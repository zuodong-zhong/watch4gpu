import assert from "node:assert/strict";
import test from "node:test";
import { compareNodeResources, isFreeGpu, memoryOccupancy, nodeSortMetrics } from "../lib/node-sort.mjs";
import { resolveMyAccounts, summarizeMyGpus } from "../lib/my-gpus.mjs";
import { filterNodeGpus } from "../lib/node-gpu-filter.mjs";

const now = Date.parse("2026-11-01T00:00:00Z");
const accounts = resolveMyAccounts("alice", { alice: "Alice", alice_lab: "Alice" });
const process = (user, conflict = false) => ({ attributedUser: user, attributionSource: "pid", attributionEvidence: { conflict } });
const gpu = (used, processes = [process("bob")], total = 10000, name = "NVIDIA A800") => ({
  index: 0, uuid: "gpu-0", name, utilization: 0, memoryUsed: used, memoryTotal: total, processes,
});
const status = (gpus, overrides = {}) => ({ ok: true, checkedAt: new Date(now).toISOString(), gpus, ...overrides });
const rank = (id, gpus, options = {}) => ({
  id, originalIndex: 0,
  ...nodeSortMetrics(gpus, { enabled: true, status: status(gpus), accounts, now, staleAfter: 75000, ...options }),
});
const order = (rows) => rows.toSorted(compareNodeResources).map(({ id }) => id);

test("free nodes come first by free-card count, then personal nodes, then ascending memory", () => {
  const rows = [
    rank("other-high", [gpu(9000)]),
    rank("other-low", [gpu(2000)]),
    rank("mine", [gpu(9900, [process("alice")])]),
    rank("one-free", [gpu(0, []), gpu(9500)]),
    rank("two-free", [gpu(0, []), gpu(0, []), gpu(9500)]),
  ];
  const before = structuredClone(rows);
  assert.deepEqual(order(rows), ["two-free", "one-free", "mine", "other-low", "other-high"]);
  assert.deepEqual(rows, before);
});

test("ties in free-card count favor personal ownership before memory occupancy", () => {
  assert.deepEqual(order([
    rank("free-other", [gpu(0, []), gpu(2000)]),
    rank("free-mine-high", [gpu(0, []), gpu(9000, [process("alice")])]),
    rank("free-mine-low", [gpu(0, []), gpu(5000, [process("alice")])]),
  ]), ["free-mine-low", "free-mine-high", "free-other"]);
});

test("occupancy compares capacity-weighted percentages across unequal sizes and counts", () => {
  assert.deepEqual(order([
    rank("half-40GB", [gpu(20000, undefined, 40000)]),
    rank("lower-80GB", [gpu(30000, undefined, 80000)]),
  ]), ["lower-80GB", "half-40GB"]);
  assert.equal(memoryOccupancy([gpu(8000, undefined, 10000), gpu(10000, undefined, 100000)]), 18000 / 110000);
  assert.equal(memoryOccupancy([gpu(5000), gpu(5000)]), memoryOccupancy([gpu(5000)]));
});

test("personal ranking shares aliases and conflict handling with My GPU", () => {
  const cards = [gpu(9000, [process(" @ALICE_LAB "), process("alice")]), gpu(8000, [process("alice", true)]), gpu(7000, [process("alice-other")])];
  const summary = summarizeMyGpus([{ id: "n", name: "n", enabled: true }], { n: status(cards) }, accounts, now, 75000);
  const metrics = cards.map((card) => rank("n", [card]));
  assert.deepEqual(metrics.map(({ hasMyGpu }) => hasMyGpu), [true, false, false]);
  assert.equal(metrics.filter(({ hasMyGpu }) => hasMyGpu).length, summary.matchedCount);
  assert.equal(summary.uncertainCount, 1);
  assert.equal(rank("mixed", [gpu(9000, [process("alice", true), process("alice_lab")])]).hasMyGpu, true);
});

test("outdated, partial, failed, disabled and empty nodes cannot receive resource priority", () => {
  const cards = [gpu(0, []), gpu(9000, [process("alice")])];
  const unavailable = [
    rank("stale", cards, { status: status(cards, { checkedAt: new Date(now - 75001).toISOString() }) }),
    rank("partial", cards, { status: status(cards, { partial: true }) }),
    rank("failed-refresh", cards, { status: status(cards, { refreshFailed: true }) }),
    rank("failed", cards, { status: status(cards, { ok: false }) }),
    rank("pending", cards, { status: undefined }),
    rank("disabled", cards, { enabled: false }),
    rank("empty", []),
  ].map((row, originalIndex) => ({ ...row, originalIndex }));
  for (const row of unavailable) {
    assert.equal(row.hasCurrentData, false);
    assert.equal(row.freeGpuCount, 0);
    assert.equal(row.hasMyGpu, false);
    assert.equal(row.memoryOccupancy, Infinity);
  }
  assert.deepEqual(order([...unavailable, rank("current-busy", [gpu(9999)])]), ["current-busy", ...unavailable.map(({ id }) => id)]);
});

test("missing memory readings are not interpreted as low occupancy, and ties remain stable", () => {
  for (const card of [gpu(-1), gpu(NaN), gpu(Infinity), gpu(undefined), gpu(0, undefined, 0), gpu(0, undefined, null)]) {
    assert.equal(memoryOccupancy([gpu(0), card]), Infinity);
  }
  const rows = [
    { ...rank("unknown-second", [gpu(NaN)]), originalIndex: 4 },
    { ...rank("unknown-first", [gpu(NaN)]), originalIndex: 2 },
    { ...rank("known-second", [gpu(5000)]), originalIndex: 3 },
    { ...rank("known-first", [gpu(5000)]), originalIndex: 1 },
  ];
  assert.deepEqual(order(rows), ["known-first", "known-second", "unknown-first", "unknown-second"]);
});

test("hidden GPU types and users cannot boost the displayed node's priority", () => {
  const cards = [gpu(0, []), gpu(9000, [process("alice")]), gpu(8000, [process("bob")], 10000, "NVIDIA RTX A6000")];
  const typeFiltered = filterNodeGpus(cards, { gpuType: "A6000" });
  const metrics = rank("n", typeFiltered, { status: status(cards) });
  assert.equal(metrics.freeGpuCount, 0);
  assert.equal(metrics.hasMyGpu, false);
  assert.equal(metrics.memoryOccupancy, 0.8);
  const userFiltered = filterNodeGpus(cards, { matchesUser: (card) => card.processes.some((p) => p.attributedUser === "bob") });
  assert.equal(rank("n", userFiltered, { status: status(cards) }).hasMyGpu, false);
});

test("changing personal accounts changes priority without changing the GPU data", () => {
  const alice = [gpu(9000, [process("alice")])];
  const bob = [gpu(8000, [process("bob")])];
  assert.deepEqual(order([rank("bob", bob), rank("alice", alice)]), ["alice", "bob"]);
  const next = { accounts: resolveMyAccounts("bob", {}) };
  assert.deepEqual(order([rank("alice", alice, next), rank("bob", bob, next)]), ["bob", "alice"]);
});

test("availability keeps the existing utilization, memory and process thresholds", () => {
  assert.equal(isFreeGpu({ ...gpu(1024, []), utilization: 5 }), true);
  assert.equal(isFreeGpu({ ...gpu(0, []), utilization: 6 }), false);
  assert.equal(isFreeGpu(gpu(1025, [])), false);
  assert.equal(isFreeGpu(gpu(0, [process("alice")])), false);
});
