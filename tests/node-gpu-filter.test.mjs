import assert from "node:assert/strict";
import test from "node:test";
import { MEMORY_THRESHOLD_OPTIONS, countLowMemoryGpus, filterNodeGpus, isValidMemoryThreshold } from "../lib/node-gpu-filter.mjs";

const gpu = (memoryUsed, overrides = {}) => ({ memoryUsed, memoryTotal: 10000, ...overrides });
const cards = () => Array.from({ length: 8 }, (_, index) => gpu(9000, { index, user: index === 0 ? "alice" : "bob" }));
const lowMemory = { lowMemoryOnly: true };
const matchesAlice = (card) => card.user === "alice";

test("one card below 50% keeps all eight GPUs in their original order", () => {
  const gpus = cards();
  gpus[7].memoryUsed = 4999;
  assert.strictEqual(filterNodeGpus(gpus, lowMemory), gpus);
  assert.equal(filterNodeGpus(gpus, lowMemory).length, 8);
  assert.equal(countLowMemoryGpus(filterNodeGpus(gpus, lowMemory)), 1);
});

test("matching card counts follow presets without counting equal thresholds or invalid readings", () => {
  const gpus = [0, 2499, 2500, 4999, 5000, 7499, 7500, 9000].map((used) => gpu(used));
  gpus.push(gpu(0, { memoryTotal: 0 }), gpu(NaN), gpu(-1), gpu(0, { memoryTotal: Infinity }));
  assert.equal(countLowMemoryGpus(gpus, 25), 2);
  assert.equal(countLowMemoryGpus(gpus, 50), 4);
  assert.equal(countLowMemoryGpus(gpus, 75), 6);
  assert.equal(countLowMemoryGpus([], 75), 0);
});

test("strict threshold uses memory occupancy, independently of compute utilization or processes", () => {
  assert.deepEqual(filterNodeGpus([gpu(5000, { utilization: 0 }), gpu(9000)], lowMemory), []);
  for (const memoryUsed of [0, 4999, 4999.9]) {
    const gpus = [gpu(memoryUsed, { utilization: 100, processes: [{ pid: 123 }] })];
    assert.strictEqual(filterNodeGpus(gpus, lowMemory), gpus);
  }
  assert.deepEqual(filterNodeGpus([gpu(5000.1)], lowMemory), []);
});

test("preset thresholds update node selection and preserve all eight GPUs", () => {
  const gpus = cards();
  gpus[7].memoryUsed = 4000;
  assert.deepEqual(filterNodeGpus(gpus, { ...lowMemory, memoryThresholdPercent: 25 }), []);
  for (const memoryThresholdPercent of [50, 75]) {
    assert.strictEqual(filterNodeGpus(gpus, { ...lowMemory, memoryThresholdPercent }), gpus);
  }
  for (const memoryThresholdPercent of MEMORY_THRESHOLD_OPTIONS) {
    assert.deepEqual(filterNodeGpus([gpu(memoryThresholdPercent * 100)], { ...lowMemory, memoryThresholdPercent }), []);
  }
});

test("thresholds accept only the three presets and fall back to 50% for old custom values", () => {
  assert.deepEqual(MEMORY_THRESHOLD_OPTIONS, [25, 50, 75]);
  for (const value of MEMORY_THRESHOLD_OPTIONS) assert.equal(isValidMemoryThreshold(value), true);
  const gpus = [gpu(6000)];
  for (const value of [0, 0.1, 60, 75.5, 100, -1, 101, NaN, Infinity, null, "75"]) {
    assert.equal(isValidMemoryThreshold(value), false);
    assert.deepEqual(filterNodeGpus(gpus, { ...lowMemory, memoryThresholdPercent: value }), []);
  }
});

test("missing or invalid memory readings cannot match a node", () => {
  for (const memoryTotal of [0, -1, NaN, Infinity, undefined, null]) {
    assert.deepEqual(filterNodeGpus([gpu(0, { memoryTotal })], lowMemory), []);
  }
  for (const memoryUsed of [-1, NaN, Infinity, undefined, null]) {
    assert.deepEqual(filterNodeGpus([gpu(memoryUsed)], lowMemory), []);
  }
  assert.deepEqual(filterNodeGpus([], lowMemory), []);
});

test("combined user and memory filters select nodes but keep every card, including other users", () => {
  const gpus = cards();
  gpus[7].memoryUsed = 1000;
  assert.strictEqual(filterNodeGpus(gpus, { ...lowMemory, matchesUser: matchesAlice }), gpus);
  assert.equal(countLowMemoryGpus(filterNodeGpus(gpus, { ...lowMemory, matchesUser: matchesAlice })), 1);
  assert.deepEqual(filterNodeGpus(gpus, { ...lowMemory, matchesUser: () => false }), []);
  assert.deepEqual(filterNodeGpus(cards(), { ...lowMemory, matchesUser: matchesAlice }), []);
});

test("turning the memory filter off restores existing user filtering and leaves source data intact", () => {
  const gpus = cards();
  gpus[7].memoryUsed = 1000;
  const before = structuredClone(gpus);
  assert.equal(filterNodeGpus(gpus, { ...lowMemory, matchesUser: matchesAlice }).length, 8);
  assert.deepEqual(filterNodeGpus(gpus, { lowMemoryOnly: false, matchesUser: matchesAlice }), [gpus[0]]);
  assert.strictEqual(filterNodeGpus(gpus), gpus);
  assert.deepEqual(gpus, before);
});
