import assert from "node:assert/strict";
import test from "node:test";

import { deviceQuery, parseProbe, parseTimeoutMs } from "../server.mjs";

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
  assert.equal((deviceQuery.match(/ps -ww -p/g) || []).length, 1);
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
    "4242\troot\t01:23:45\t4242,17\tpython /home/alice/train.py",
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
