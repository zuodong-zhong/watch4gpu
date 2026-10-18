import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentStatus, mergeNodeStatus } from "../lib/node-status.mjs";
import { createNodeCollector } from "../node-collector.mjs";
import { summarizeMyGpus } from "../lib/my-gpus.mjs";
import { summarizeMyTasks } from "../lib/my-tasks.mjs";

const now = Date.parse("2026-10-18T00:00:00Z");
const node = { id: "node-a", name: "Node A", enabled: true, mode: "direct", sshHost: "host-a" };
const good = {
  nodeId: node.id, ok: true, checkedAt: new Date(now).toISOString(), latencyMs: 500,
  gpus: [{ index: 0, uuid: "GPU-0", name: "Test GPU", processes: [{ pid: 123, attributedUser: "alice", attributionSource: "pid", elapsedSeconds: 120 }] }],
};
const failed = { nodeId: node.id, ok: false, checkedAt: new Date(now + 30_000).toISOString(), latencyMs: 25_000, gpus: [], error: "连接超时" };

test("an SSH failure keeps the GPU snapshot and original timestamp without counting it as current", () => {
  const result = mergeNodeStatus(good, failed);
  assert.equal(result.gpus, good.gpus);
  assert.equal(result.checkedAt, good.checkedAt);
  assert.equal(result.refreshFailed, true);
  assert.equal(result.error, failed.error);
  assert.equal(isCurrentStatus(result, now + 30_000, 75_000), false);
  const accounts = new Set(["alice"]);
  const summary = summarizeMyGpus([node], { [node.id]: result }, accounts, now + 30_000, 75_000);
  assert.equal(summary.matchedCount, 0);
  assert.equal(summary.unavailableNodes, 1);
  assert.equal(summary.groups[0].cards.length, 1);
  assert.equal(summary.groups[0].stale, true);
  const tasks = summarizeMyTasks([node], { [node.id]: result }, accounts, now + 30_000, 75_000);
  assert.equal(tasks[0].tasks[0].durationSeconds, 120);
  assert.equal(tasks[0].stale, true);
});

test("repeated failures preserve the snapshot and recovery clears the failure", () => {
  const stale = mergeNodeStatus(good, failed);
  const again = mergeNodeStatus(stale, { ...failed, error: "网关暂时无响应" });
  assert.equal(again.checkedAt, good.checkedAt);
  assert.equal(again.error, "网关暂时无响应");
  const recovered = { ...good, checkedAt: failed.checkedAt };
  assert.equal(mergeNodeStatus(again, recovered), recovered);
  assert.equal(isCurrentStatus(recovered, now + 30_000, 75_000), true);
  assert.equal(mergeNodeStatus(undefined, failed), failed);
  assert.equal(mergeNodeStatus({ ...good, nodeId: "other" }, failed), failed);
});

test("expired, invalid, missing and failed snapshots never count as current", () => {
  for (const status of [undefined, failed, { ...good, checkedAt: "invalid" }, { ...good, refreshFailed: true }]) {
    assert.equal(isCurrentStatus(status, now, 75_000), false);
  }
  assert.equal(isCurrentStatus(good, now + 75_001, 75_000), false);
  assert.equal(isCurrentStatus(good, now + 75_000, 75_000), true);
});

test("server retains successes across requests but still probes each time and invalidates a changed target", async () => {
  let calls = 0;
  const collect = createNodeCollector(async () => ++calls === 1 ? good : failed);
  assert.equal(await collect(node), good);
  const second = await collect(node);
  assert.equal(calls, 2);
  assert.equal(second.refreshFailed, true);
  assert.equal(second.checkedAt, good.checkedAt);
  assert.equal(second.gpus, good.gpus);
  assert.equal(await collect({ ...node, sshHost: "replacement-host" }), failed);
  assert.equal(await collect(node), failed, "switching back cannot resurrect an old target snapshot");
});
