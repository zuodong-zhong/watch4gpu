import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { summarizeMyTasks } from "../lib/my-tasks.mjs";
import { formatShanghaiTime, formatTaskDuration, parseElapsedSeconds, parseProcessTimes, toShanghaiTimestamp } from "../lib/task-time.mjs";
import { parseProbe, remoteProbe, relayRemoteProbeSteps, taskTimeQuery } from "../server.mjs";

const checkedAt = "2026-09-22T01:00:00Z";
const now = Date.parse(checkedAt);
const nodes = [{ id: "a", name: "Node A", enabled: true }];
const accounts = new Set(["alice", "alice_lab"]);
const proc = (pid, overrides = {}) => ({ pid, attributedUser: "alice", attributionSource: "pid", name: "python", command: "python train.py --config experiment.yaml", elapsed: "01:00:00", ...overrides });
const gpu = (index, processes) => ({ index, name: "Test GPU", uuid: `GPU-${index}`, processes });
const status = (gpus, overrides = {}) => ({ ok: true, checkedAt, gpus, ...overrides });
const summarize = (statuses, at = now) => summarizeMyTasks(nodes, statuses, accounts, at, 75_000);

test("parses ps durations, including days and zero, without converting invalid values to zero", () => {
  for (const [value, expected] of [["00:00", 0], ["03:04", 184], ["02:03:04", 7384], ["12-02:03:04", 1044184], ["100:00:00", 360000]]) {
    assert.equal(parseElapsedSeconds(value), expected);
  }
  for (const value of [null, "", "N/A", "-1:00", "1-02:03", "03:90", "00:99:00", "1-25:00:00"]) assert.equal(parseElapsedSeconds(value), null);
  assert.equal(formatTaskDuration(93784), "1 天 2 小时 3 分 4 秒");
  assert.equal(formatTaskDuration(0), "0 秒");
  assert.equal(formatTaskDuration(null), "未知");
});

test("UTC process start times are recorded and rendered in Asia/Shanghai across a date boundary", () => {
  const times = parseProcessTimes("  123 Mon Sep 21 18:30:00 2026 23400\n124 Tue Sep 22 00:00:00 2026 3600\n");
  assert.deepEqual(times.get(123), { startedAt: "2026-09-22T02:30:00+08:00", elapsedSeconds: 23400, timingSource: "process" });
  assert.equal(formatShanghaiTime("2026-09-21T18:30:00Z"), "2026-09-22 02:30:00");
  assert.equal(formatShanghaiTime("2026-09-22T03:30:00+09:00"), "2026-09-22 02:30:00");
  assert.equal(toShanghaiTimestamp(now), "2026-09-22T09:00:00+08:00");
  assert.equal(formatShanghaiTime("invalid"), "未知");
  assert.equal(parseProcessTimes("125 Tue Feb 30 00:00:00 2026 3\n126 Tue Sep 22 25:00:00 2026 3\n127 Tue Sep 22 00:00:00 2026 -1").size, 0);
});

test("task timing probe is fixed and read-only, validates PIDs, and queries each PID once", () => {
  assert.doesNotMatch(taskTimeQuery, /\b(?:sudo|su|rm|mv|cp|touch|tee|kill|pkill|renice|docker)\b|sed\s+-i|(?:^|[;&|])\s*>[^&]/);
  assert.match(taskTimeQuery, /LC_ALL=C TZ=UTC ps/);
  assert.match(remoteProbe, /__WATCH4GPU_TASK_TIMES__/);
  assert.ok(relayRemoteProbeSteps.some((step) => step.command.includes(taskTimeQuery)));
  const result = spawnSync("bash", ["-c", `nvidia-smi() { printf '123\\n123\\n456\\ninvalid\\n'; }; ps() { printf '%s %s %s\\n' "$LC_ALL" "$TZ" "$*"; }; ${taskTimeQuery}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["C UTC -ww -p 123 -o pid= -o lstart= -o etimes=", "C UTC -ww -p 456 -o pid= -o lstart= -o etimes="]);
});

function probeFixture(timing = "") {
  return ["__WATCH4GPU_HOST__", "test-host", "__WATCH4GPU_GPUS__", "0, Test GPU, GPU-0, 40, 50, 2000, 80000, 100, 400", "__WATCH4GPU_PROCESSES__", "GPU-0, 123, python, 2000", "__WATCH4GPU_OWNERS__", "alice 123 01:00:00 python train.py", "__WATCH4GPU_WORKLOADS__", "__WATCH4GPU_NAMESPACES__", "__WATCH4GPU_DEVICES__", "__WATCH4GPU_DEVICE_PROCESSES__", "__WATCH4GPU_CONTAINER_CWDS__", ...(timing ? ["__WATCH4GPU_TASK_TIMES__", timing] : []), "__WATCH4GPU_DONE__"].join("\n");
}

test("API prefers the GPU PID start time over inferred elapsed data and labels old-probe estimates", () => {
  const exact = parseProbe(probeFixture("123 Tue Sep 22 00:30:00 2026 1800"), checkedAt).gpus[0].processes[0];
  assert.equal(exact.startedAt, "2026-09-22T08:30:00+08:00");
  assert.equal(exact.elapsedSeconds, 1800);
  assert.equal(exact.timingSource, "process");
  assert.equal(exact.timeZone, "Asia/Shanghai");
  const fallback = parseProbe(probeFixture(), checkedAt).gpus[0].processes[0];
  assert.equal(fallback.startedAt, "2026-09-22T08:00:00+08:00");
  assert.equal(fallback.timingSource, "estimated");
  const unknown = parseProbe(probeFixture().replace("alice 123 01:00:00 python train.py", ""), checkedAt).gpus[0].processes[0];
  assert.equal(unknown.startedAt, null);
  assert.equal(unknown.elapsedSeconds, null);
});

test("deduplicates a GPU process across cards and aliases but keeps identical jobs and node-local PIDs separate", () => {
  const statuses = { a: status([gpu(2, [proc(123), proc(124), proc(999, { attributedUser: "bob" })]), gpu(0, [proc(123, { attributedUser: "alice_lab" })])]), b: status([gpu(3, [proc(123)])]) };
  const groups = summarizeMyTasks([...nodes, { id: "b", name: "Node B", enabled: true }, { id: "disabled", enabled: false }], statuses, accounts, now, 75_000);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].tasks.length, 2);
  assert.deepEqual(groups[0].tasks[0].gpuIndices, [0, 2]);
  assert.deepEqual(groups[0].tasks[0].accounts, ["alice", "alice_lab"]);
  assert.equal(groups[1].tasks[0].pid, 123);
});

test("live elapsed time advances, stale and failed snapshots freeze, and unknown starts stay unknown", () => {
  const gpus = [gpu(0, [proc(123), proc(124, { elapsed: null }), proc(125, { attributionSource: "parent" })])];
  const live = summarize({ a: status(gpus) }, now + 10_000)[0];
  assert.equal(live.tasks.find((task) => task.pid === 123).durationSeconds, 3610);
  assert.equal(live.tasks.find((task) => task.pid === 124).timing.startedAt, null);
  assert.equal(live.tasks.find((task) => task.pid === 125).timing.source, "related");
  for (const [snapshot, at] of [[status(gpus), now + 80_000], [status(gpus, { refreshFailed: true }), now + 10_000]]) {
    const group = summarize({ a: snapshot }, at)[0];
    assert.equal(group.stale, true);
    assert.equal(group.tasks.find((task) => task.pid === 123).durationSeconds, 3600);
  }
  assert.equal(summarize({ a: status(gpus, { ok: false }) }).length, 0);
  assert.equal(summarize({}).length, 0);
  assert.equal(summarize({ a: status([gpu(0, [proc(123, { attributionEvidence: { conflict: true } })])]) })[0].tasks[0].uncertain, true);
  assert.equal(summarize({ a: status([gpu(0, [proc(123, { elapsed: "00:05" })])]) })[0].tasks[0].durationSeconds, 5, "PID reuse must not retain a previous task duration");
});
