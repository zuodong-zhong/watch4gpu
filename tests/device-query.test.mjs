import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { buildContainerCwdQuery, containerCwdQuery, deviceQuery, parseProbe, parseTimeoutMs, relayRemoteProbe, remoteProbe } from "../server.mjs";

test("validates optional per-request timeout limits", () => {
  assert.equal(parseTimeoutMs(null), null);
  assert.equal(parseTimeoutMs("45"), 45_000);
  assert.equal(parseTimeoutMs("120"), 120_000);
  assert.throws(() => parseTimeoutMs("4"), /5–120 秒/);
  assert.throws(() => parseTimeoutMs("121"), /5–120 秒/);
  assert.throws(() => parseTimeoutMs("25.5"), /整数秒/);
});

test("device query emits every GPU-PID mapping and queries unique PID metadata separately", () => {
  assert.match(deviceQuery, /printf '%s\\t%s\\t%s\\n' \"\$gpu_index\" \"\$pid\" \"\$method\"/);
  assert.match(deviceQuery, /case \"\$unique_pids\" in \*\" \$pid \"\*/);
  assert.match(deviceQuery, /__WATCH4GPU_DEVICE_PROCESSES__/);
  assert.match(deviceQuery, /-o ppid= -o pgid= -o sid=/);
  assert.equal((deviceQuery.match(/ps -ww -p/g) || []).length, 1);
});

test("container inspection batches validated PIDs and stays read-only", () => {
  assert.match(containerCwdQuery, /deep_inspection_needed=/);
  assert.ok(containerCwdQuery.indexOf("deep_inspection_needed=") < containerCwdQuery.indexOf("docker ps -q"));
  assert.match(containerCwdQuery, /docker ps -q --no-trunc/);
  assert.match(containerCwdQuery, /docker exec -u 0/);
  assert.match(containerCwdQuery, /ps -ww -e -o pid= -o args=/);
  assert.match(containerCwdQuery, /readlink \/proc/);
  assert.equal((containerCwdQuery.match(/docker exec/g) || []).length, 1);
  assert.match(containerCwdQuery, /\^\[0-9\]\+\$/);
  assert.match(remoteProbe, /__WATCH4GPU_CONTAINER_CWDS__/);
  assert.match(relayRemoteProbe, /__WATCH4GPU_CONTAINER_CWDS__/);
  assert.doesNotMatch(relayRemoteProbe, /docker exec/);
  assert.doesNotMatch(containerCwdQuery, /\b(?:sudo|su|rm|mv|cp|touch|tee|kill|pkill|renice)\b|sed\s+-i|docker\s+(?:stop|restart|kill|update)|(?:^|[;&|])\s*>[^&]/);
  const innerScript = containerCwdQuery.match(/sh -c '([^']+)' sh/)?.[1];
  assert.ok(innerScript);
  assert.equal(spawnSync("bash", ["-n"], { input: containerCwdQuery }).status, 0);
  assert.equal(spawnSync("sh", ["-n"], { input: innerScript }).status, 0);
});

test("deep inspection users are configurable without embedding private accounts", () => {
  const query = buildContainerCwdQuery(["root", "shared_account", "invalid*account"]);
  assert.match(query, /grep -Eq '\^\(root\|shared_account\)\$'/);
  assert.match(query, /\(root\|shared_account\)\//);
  assert.doesNotMatch(query, /invalid\*account/);
});

test("parseProbe associates one PID's metadata with every mapped GPU", () => {
  const output = [
    "__WATCH4GPU_HOST__",
    "gpu-host",
    "__WATCH4GPU_GPUS__",
    "0, NVIDIA A100, GPU-0, 42, 80, 4096, 81920, 200, 400",
    "1, NVIDIA A100, GPU-1, 43, 75, 4096, 81920, 190, 400",
    "__WATCH4GPU_PROCESSES__",
    "GPU-0, 4242, [Not Found], 2048",
    "GPU-1, 4242, [Not Found], 2048",
    "__WATCH4GPU_OWNERS__",
    "__WATCH4GPU_WORKLOADS__",
    "__WATCH4GPU_NAMESPACES__",
    "__WATCH4GPU_DEVICES__",
    "0\t4242\tfuser",
    "1\t4242\tfuser",
    "__WATCH4GPU_DEVICE_PROCESSES__",
    "4242\troot\t1\t4242\t4242\t01:23:45\t4242,17\t/home/alice/project\tpython /home/alice/train.py",
    "__WATCH4GPU_DONE__",
    "",
  ].join("\n");

  const result = parseProbe(output);
  assert.equal(result.hostname, "gpu-host");
  assert.equal(result.gpus.length, 2);

  const processes = result.gpus.map((gpu) => {
    assert.equal(gpu.processes.length, 1);
    return gpu.processes[0];
  });
  assert.deepEqual(processes.map((process) => process.pid), [4242, 4242]);
  assert.deepEqual(processes.map((process) => process.attributedUser), ["alice", "alice"]);
  assert.deepEqual(processes.map((process) => process.attributionSource), ["device", "device"]);
  assert.deepEqual(processes.map((process) => process.owner), ["root", "root"]);
  assert.deepEqual(processes.map((process) => process.containerPid), [4242, 4242]);
  assert.deepEqual(processes.map((process) => process.command), [
    "python /home/alice/train.py",
    "python /home/alice/train.py",
  ]);
});

test("prefers task evidence over a borrowed Python environment and reuses it for the same PID", () => {
  const command = [
    "/public/bob/envs/train/bin/python -u main.py",
    "--cfg /work/alice/project/config.yaml",
    "--data-path /archive/carol/datasets/images",
    "--output /work/alice/project/outputs",
  ].join(" ");
  const output = [
    "__WATCH4GPU_HOST__",
    "gpu-host",
    "__WATCH4GPU_GPUS__",
    "0, NVIDIA A100, GPU-0, 42, 80, 4096, 81920, 200, 400",
    "__WATCH4GPU_PROCESSES__",
    "GPU-0, 9001, /public/bob/envs/train/bin/python, 2048",
    "__WATCH4GPU_OWNERS__",
    `root 9001 02:03:04 ${command}`,
    "__WATCH4GPU_WORKLOADS__",
    `root\t9001\t1\t9001\t9001\t02:03:04\t\t/work/alice/project\t0\t0\t0\t1\t${command}`,
    "__WATCH4GPU_NAMESPACES__",
    "__WATCH4GPU_DEVICES__",
    "__WATCH4GPU_DEVICE_PROCESSES__",
    "__WATCH4GPU_DONE__",
    "",
  ].join("\n");

  const result = parseProbe(output);
  const workload = result.workloads[0];
  const process = result.gpus[0].processes[0];

  assert.equal(workload.attributedUser, "alice");
  assert.equal(process.attributedUser, "alice");
  assert.deepEqual(process.attributionEvidence, workload.attributionEvidence);
  assert.deepEqual(workload.attributionEvidence, {
    systemAccount: "root",
    environmentUser: "bob",
    taskUser: "alice",
    taskSources: ["cwd", "config", "output"],
    conflict: true,
  });
  assert.notEqual(workload.attributedUser, "carol");
});

test("uses a container cwd when host proc permissions hide the task directory", () => {
  const command = "/public/shared_env/conda/envs/train/bin/python3.11 -u scripts/train.py";
  const output = [
    "__WATCH4GPU_HOST__",
    "gpu-host",
    "__WATCH4GPU_GPUS__",
    "0, NVIDIA A100, GPU-0, 42, 80, 4096, 81920, 200, 400",
    "1, NVIDIA A100, GPU-1, 43, 75, 4096, 81920, 190, 400",
    "__WATCH4GPU_PROCESSES__",
    "GPU-0, 44468, /public/shared_env/conda/envs/train/bin/python3.11, 2048",
    "GPU-1, 44469, /public/shared_env/conda/envs/train/bin/python3.11, 2048",
    "__WATCH4GPU_OWNERS__",
    `root 44468 18:21:11 ${command}`,
    `root 44469 18:21:10 ${command}`,
    "__WATCH4GPU_WORKLOADS__",
    `root\t44468\t43737\t44468\t11180\t18:21:11\t44468,30765\t\t0\t0\t0\t8\t${command}`,
    "__WATCH4GPU_NAMESPACES__",
    "__WATCH4GPU_DEVICES__",
    "__WATCH4GPU_DEVICE_PROCESSES__",
    `44468\troot\t43737\t44468\t11180\t18:21:11\t44468,30765\t\t${command}`,
    "__WATCH4GPU_CONTAINER_CWDS__",
    `aaaaaaaaaaaa\t30765\t/public/task_owner/project\t${command}`,
    "__WATCH4GPU_DONE__",
    "",
  ].join("\n");

  const result = parseProbe(output);
  const workload = result.workloads[0];
  const process = result.gpus[0].processes[0];
  const ownerOnlyProcess = result.gpus[1].processes[0];

  assert.equal(workload.cwd, "/public/task_owner/project");
  assert.equal(workload.attributedUser, "task_owner");
  assert.deepEqual(workload.attributionEvidence, {
    systemAccount: "root",
    environmentUser: "shared_env",
    taskUser: "task_owner",
    taskSources: ["cwd"],
    conflict: true,
  });
  assert.equal(process.attributedUser, "task_owner");
  assert.deepEqual(process.attributionEvidence, workload.attributionEvidence);
  assert.equal(ownerOnlyProcess.attributedUser, "task_owner");
  assert.deepEqual(ownerOnlyProcess.attributionEvidence, workload.attributionEvidence);
});

test("attributes renamed vLLM GPU workers through their process group", () => {
  const launchCommand = "/usr/bin/python3 /usr/local/bin/vllm serve /9950backfile/task_owner/models/example --tensor-parallel-size 2";
  const unrelatedCommand = "/usr/bin/python3 /usr/local/bin/vllm serve /public/other_owner/models/example --tensor-parallel-size 2";
  const output = [
    "__WATCH4GPU_HOST__",
    "gpu-host",
    "__WATCH4GPU_GPUS__",
    "0, NVIDIA A100, GPU-0, 42, 80, 4096, 81920, 200, 400",
    "1, NVIDIA A100, GPU-1, 43, 75, 4096, 81920, 190, 400",
    "__WATCH4GPU_PROCESSES__",
    "GPU-0, 9464, VLLM::Worker_TP0, 2048",
    "GPU-1, 9465, VLLM::Worker_TP1, 2048",
    "__WATCH4GPU_OWNERS__",
    "root 9464 01:53:26 VLLM::Worker_TP0",
    "root 9465 01:53:26 VLLM::Worker_TP1",
    "__WATCH4GPU_WORKLOADS__",
    `root\t8984\t22436\t8984\t22436\t01:53:50\t\t/9950backfile/task_owner/project\t0,1\t-\t-\t-\t${launchCommand}`,
    `root\t7000\t1\t7000\t7000\t00:20:00\t\t/public/other_owner/project\t0,1\t-\t-\t-\t${unrelatedCommand}`,
    "__WATCH4GPU_NAMESPACES__",
    "__WATCH4GPU_DEVICES__",
    "0\t9464\tfuser",
    "1\t9465\tfuser",
    "__WATCH4GPU_DEVICE_PROCESSES__",
    "9464\troot\t9265\t8984\t22436\t01:53:26\t\t\tVLLM::Worker_TP0",
    "9465\troot\t9265\t8984\t22436\t01:53:26\t\t\tVLLM::Worker_TP1",
    "__WATCH4GPU_DONE__",
    "",
  ].join("\n");

  const result = parseProbe(output);
  const gpuProcesses = result.gpus.map((gpu) => gpu.processes[0]);

  assert.deepEqual(gpuProcesses.map((process) => process.attributedUser), ["task_owner", "task_owner"]);
  assert.deepEqual(gpuProcesses.map((process) => process.attributionSource), ["parent", "parent"]);
  assert.deepEqual(gpuProcesses.map((process) => process.owner), ["root", "root"]);
  assert.deepEqual(gpuProcesses.map((process) => process.attributionEvidence.taskUser), ["task_owner", "task_owner"]);
});

test("uses GPU-scoped weak evidence instead of another user's node-wide fallback", () => {
  const environmentCommand = "/public/environment_owner/envs/train/bin/python -u train.py";
  const taskCommand = "/public/shared_env/envs/train/bin/python -u train.py --output /9950backfile/task_owner/outputs";
  const output = [
    "__WATCH4GPU_HOST__",
    "gpu-host",
    "__WATCH4GPU_GPUS__",
    "0, NVIDIA A100, GPU-0, 42, 80, 4096, 81920, 200, 400",
    "4, NVIDIA A100, GPU-4, 43, 75, 4096, 81920, 190, 400",
    "__WATCH4GPU_PROCESSES__",
    "GPU-0, 23071, [Not Found], 2048",
    "GPU-4, 25702, [Not Found], 2048",
    "__WATCH4GPU_OWNERS__",
    "__WATCH4GPU_WORKLOADS__",
    `root\t22708\t21943\t22708\t22708\t02:07:50\t\t/storage-root/datasets/shared/code/project\t0\t0\t0\t4\t${environmentCommand}`,
    `root\t63896\t63893\t63893\t37497\t2-10:49:08\t\t/storage-root/datasets/shared/code/other\t4\t-\t-\t-\t${taskCommand}`,
    "__WATCH4GPU_NAMESPACES__",
    "__WATCH4GPU_DEVICES__",
    "__WATCH4GPU_DEVICE_PROCESSES__",
    "__WATCH4GPU_DONE__",
    "",
  ].join("\n");

  const result = parseProbe(output);
  const gpuZeroProcess = result.gpus.find((gpu) => gpu.index === 0).processes[0];

  assert.equal(gpuZeroProcess.attributedUser, "environment_owner");
  assert.equal(gpuZeroProcess.attributionSource, "cuda-env");
  assert.equal(gpuZeroProcess.attributionEvidence.environmentUser, "environment_owner");
  assert.equal(gpuZeroProcess.attributionEvidence.taskUser, null);
  assert.notEqual(gpuZeroProcess.attributedUser, "task_owner");
});

test("maps local ranks to GPUs when CUDA_VISIBLE_DEVICES is unset", () => {
  const command = "/public/rank_owner/envs/train/bin/python -u train.py --output /public/rank_owner/outputs";
  const output = [
    "__WATCH4GPU_HOST__",
    "gpu-host",
    "__WATCH4GPU_GPUS__",
    "0, NVIDIA A100, GPU-0, 42, 80, 4096, 81920, 200, 400",
    "1, NVIDIA A100, GPU-1, 43, 75, 4096, 81920, 190, 400",
    "__WATCH4GPU_PROCESSES__",
    "GPU-0, 35685, [Not Found], 2048",
    "GPU-1, 35686, [Not Found], 2048",
    "__WATCH4GPU_OWNERS__",
    "__WATCH4GPU_WORKLOADS__",
    `root\t17863\t17798\t17863\t17863\t02:07:50\t\t/storage-root/datasets/shared/project\t-\t0\t0\t2\t${command}`,
    `root\t17864\t17798\t17864\t17864\t02:07:50\t\t/storage-root/datasets/shared/project\t-\t1\t1\t2\t${command}`,
    "__WATCH4GPU_NAMESPACES__",
    "__WATCH4GPU_DEVICES__",
    "__WATCH4GPU_DEVICE_PROCESSES__",
    "__WATCH4GPU_DONE__",
    "",
  ].join("\n");

  const result = parseProbe(output);

  assert.deepEqual(result.workloads.map((workload) => workload.physicalGpu), [0, 1]);
  assert.deepEqual(result.workloads.map((workload) => workload.devices), [[0], [1]]);
  assert.deepEqual(result.gpus.map((gpu) => gpu.processes[0].attributedUser), ["rank_owner", "rank_owner"]);
  assert.deepEqual(result.gpus.map((gpu) => gpu.processes[0].attributionSource), ["cuda-env", "cuda-env"]);
});

test("leaves an invisible GPU PID unknown when no GPU-scoped relation exists", () => {
  const command = "/public/task_owner/envs/train/bin/python -u train.py --output /public/task_owner/outputs";
  const output = [
    "__WATCH4GPU_HOST__",
    "gpu-host",
    "__WATCH4GPU_GPUS__",
    "0, NVIDIA A100, GPU-0, 42, 80, 4096, 81920, 200, 400",
    "__WATCH4GPU_PROCESSES__",
    "GPU-0, 99999, [Not Found], 2048",
    "__WATCH4GPU_OWNERS__",
    "__WATCH4GPU_WORKLOADS__",
    `root\t7000\t1\t7000\t7000\t00:20:00\t\t/public/task_owner/project\t-\t-\t-\t-\t${command}`,
    "__WATCH4GPU_NAMESPACES__",
    "__WATCH4GPU_DEVICES__",
    "__WATCH4GPU_DEVICE_PROCESSES__",
    "__WATCH4GPU_DONE__",
    "",
  ].join("\n");

  const process = parseProbe(output).gpus[0].processes[0];

  assert.equal(process.attributedUser, null);
  assert.equal(process.attributionSource, null);
});

test("does not guess a task user when identical container commands have different working directories", () => {
  const command = "/public/shared_env/envs/train/bin/python worker.py";
  const output = [
    "__WATCH4GPU_HOST__",
    "gpu-host",
    "__WATCH4GPU_GPUS__",
    "0, NVIDIA A100, GPU-0, 42, 80, 4096, 81920, 200, 400",
    "__WATCH4GPU_PROCESSES__",
    "GPU-0, 8001, /public/shared_env/envs/train/bin/python, 2048",
    "__WATCH4GPU_OWNERS__",
    `root 8001 00:10:00 ${command}`,
    "__WATCH4GPU_WORKLOADS__",
    "__WATCH4GPU_NAMESPACES__",
    "__WATCH4GPU_DEVICES__",
    "__WATCH4GPU_DEVICE_PROCESSES__",
    "__WATCH4GPU_CONTAINER_CWDS__",
    `aaaaaaaaaaaa\t81\t/public/alice/project\t${command}`,
    `aaaaaaaaaaaa\t82\t/public/carol/project\t${command}`,
    "__WATCH4GPU_DONE__",
    "",
  ].join("\n");

  const process = parseProbe(output).gpus[0].processes[0];
  assert.equal(process.attributedUser, "shared_env");
  assert.equal(process.attributionEvidence.taskUser, null);
  assert.equal(process.attributionEvidence.conflict, false);
});

test("treats 9950backfile as a path root instead of a username", () => {
  const command = [
    "/public/example_user/envs/train/bin/python train.py",
    "--output /public/9950backfile/example_user/project/outputs",
  ].join(" ");
  const output = [
    "__WATCH4GPU_HOST__",
    "gpu-host",
    "__WATCH4GPU_GPUS__",
    "0, NVIDIA A100, GPU-0, 42, 80, 4096, 81920, 200, 400",
    "__WATCH4GPU_PROCESSES__",
    "GPU-0, 7001, /public/example_user/envs/train/bin/python, 2048",
    "__WATCH4GPU_OWNERS__",
    "__WATCH4GPU_WORKLOADS__",
    `root\t7001\t1\t7001\t7001\t00:10:00\t\t/9950backfile/example_user/project\t0\t0\t0\t1\t${command}`,
    "__WATCH4GPU_NAMESPACES__",
    "__WATCH4GPU_DEVICES__",
    "__WATCH4GPU_DEVICE_PROCESSES__",
    "__WATCH4GPU_DONE__",
    "",
  ].join("\n");

  const result = parseProbe(output);
  const workload = result.workloads[0];
  const process = result.gpus[0].processes[0];

  assert.equal(workload.attributedUser, "example_user");
  assert.equal(workload.attributionEvidence.taskUser, "example_user");
  assert.equal(workload.attributionEvidence.environmentUser, "example_user");
  assert.equal(workload.attributionEvidence.conflict, false);
  assert.equal(process.attributedUser, "example_user");
});
