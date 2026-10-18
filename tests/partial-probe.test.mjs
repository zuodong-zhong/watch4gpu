import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { parseIncompleteProbe, run, runRelay } from "../server.mjs";
import { createNodeCollector } from "../node-collector.mjs";
import { isCurrentStatus } from "../lib/node-status.mjs";

const checkedAt = "2026-10-18T00:00:00Z";
const base = [
  "__WATCH4GPU_HOST__", "test-host", "__WATCH4GPU_GPUS__",
  "0, Test GPU, GPU-0, 40, 90, 8192, 81920, 150, 400",
  "__WATCH4GPU_PROCESSES__", "GPU-0, 42, python, 8192",
  "__WATCH4GPU_OWNERS__",
].join("\n") + "\n";

test("a slow optional section cannot discard complete GPU and process observations", () => {
  const partial = parseIncompleteProbe(base + "alice 42 01:00 python /home/alice/train.py\n__WATCH4GPU_WORKLOADS__\nunfinished workload", checkedAt);
  assert.equal(partial.gpus.length, 1);
  assert.equal(partial.gpus[0].processes[0].pid, 42);
  assert.equal(partial.gpus[0].processes[0].attributedUser, "alice");
  assert.equal(partial.gpus[0].memoryUsed, 8192);
  assert.equal(partial.incompleteStage, "读取训练进程");
  assert.deepEqual(partial.workloads, []);
});

test("discard incomplete metadata and never mistake a truncated process list for an idle GPU", () => {
  const partial = parseIncompleteProbe(base + "alice 42 01:00 python /unfinished", checkedAt);
  assert.equal(partial.gpus[0].processes[0].attributedUser, null);
  assert.equal(partial.gpus[0].processes.length, 1);
  for (const output of [undefined, "", base.slice(0, base.indexOf("__WATCH4GPU_PROCESSES__")), base.slice(0, base.indexOf("__WATCH4GPU_OWNERS__")), base.replace("GPU-0, 40, 90", "bad row")]) {
    assert.equal(parseIncompleteProbe(output, checkedAt), null);
  }
});

test("the server keeps a full snapshot available when a partial refresh is followed by a complete failure", async () => {
  const node = { id: "node-a", mode: "direct", sshHost: "test-host" };
  const full = { nodeId: node.id, ok: true, checkedAt, gpus: [{ index: 0 }] };
  const partial = { ...full, partial: true, gpus: [{ index: 1 }] };
  const results = [full, partial, { nodeId: node.id, ok: false, checkedAt, gpus: [], error: "timeout" }];
  const collect = createNodeCollector(async () => results.shift());
  assert.equal(await collect(node), full);
  assert.equal(await collect(node), partial);
  const failed = await collect(node);
  assert.equal(failed.gpus, full.gpus);
  assert.equal(failed.refreshFailed, true);
  assert.equal(isCurrentStatus(partial, Date.parse(checkedAt), 75_000), false);
  const firstPartial = createNodeCollector(async () => partial);
  assert.equal(await firstPartial(node), partial);
  let attempts = 0;
  const partialThenFailure = createNodeCollector(async () => ++attempts === 1 ? partial : { nodeId: node.id, ok: false, checkedAt, gpus: [] });
  await partialThenFailure(node);
  const retained = await partialThenFailure(node);
  assert.equal(retained.gpus, partial.gpus);
  assert.equal(retained.partial, true);
  assert.equal(retained.refreshFailed, true);
});

test("direct and relay timeouts retain captured sections internally after SSH closes", async () => {
  for (const relay of [false, true]) {
    const child = Object.assign(new EventEmitter(), {
      pid: 123, exitCode: null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      kill() { queueMicrotask(() => this.emit("close", null, "SIGTERM")); },
    });
    const result = relay
      ? runRelay({ gatewayHost: "gateway", gpuNodeId: "1", loginScript: "/shared/login_1.sh" }, 10, () => child)
      : run("ssh", [], undefined, 10, () => child);
    child.stdout.write(base);
    await assert.rejects(result, (error) => {
      assert.equal(error.probeOutput, base);
      assert.equal(Object.keys(error).includes("probeOutput"), false);
      assert.equal(parseIncompleteProbe(error.probeOutput, checkedAt).gpus.length, 1);
      return /连接超时/.test(error.message);
    });
  }
});
