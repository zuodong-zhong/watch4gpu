import assert from "node:assert/strict";
import test from "node:test";
import { resolveMyAccounts, summarizeMyGpus } from "../lib/my-gpus.mjs";
import { createApiServer } from "../server.mjs";

const now = Date.parse("2026-09-22T01:00:00Z");
const node = (id, enabled = true) => ({ id, name: id, enabled });
const process = (attributedUser, conflict = false, attributionSource = "pid") => ({ attributedUser, attributionSource, attributionEvidence: { conflict } });
const gpu = (index, processes) => ({ index, uuid: `GPU-${index}`, name: "Test GPU", processes });
const status = (gpus, overrides = {}) => ({ ok: true, checkedAt: new Date(now).toISOString(), gpus, ...overrides });
const summarize = (nodes, statuses) => summarizeMyGpus(nodes, statuses, new Set(["alice", "alice_lab"]), now, 75_000);

test("my accounts expand aliases with exact normalized matches and ignore blank names", () => {
  const names = { Alice: " Alice Chen ", alice_lab: "alice chen", bob: "Bob", nobody: "", other: "" };
  assert.deepEqual([...resolveMyAccounts(" @ALICE， carol,carol、nobody ", names)].sort(), ["alice", "alice_lab", "carol", "nobody"]);
  assert.deepEqual([...resolveMyAccounts("ali", names)], ["ali"]);
  assert.equal(resolveMyAccounts(" , ， @ ", names).size, 0);
});

test("counts cards once across aliases and processes, and keeps node-local card indexes separate", () => {
  const result = summarize([node("a"), node("b"), node("disabled", false)], {
    a: status([gpu(3, [process("alice"), process("alice_lab"), process("bob")]), gpu(1, [process("bob")])]),
    b: status([gpu(3, [process("@Alice")])]),
    disabled: status([gpu(0, [process("alice")])]),
    removed: status([gpu(0, [process("alice")])]),
  });
  assert.equal(result.matchedCount, 2);
  assert.deepEqual(result.groups.map(({ node, cards }) => [node.id, cards.map((card) => card.index)]), [["a", [3]], ["b", [3]]]);
  assert.equal(result.groups[0].cards[0].processCount, 2);
});

test("conflicting evidence is separate, inferred ownership is labelled, and system account does not override attribution", () => {
  const result = summarize([node("a")], { a: status([
    gpu(0, [process("alice", true)]),
    gpu(1, [process("alice", false, "path")]),
    gpu(2, [process("alice", true), process("alice_lab")]),
    gpu(3, [{ ...process("bob"), owner: "alice", attributionEvidence: { conflict: true, environmentUser: "alice" } }]),
    gpu(4, [process(null)]),
  ]) });
  assert.equal(result.matchedCount, 2);
  assert.equal(result.uncertainCount, 1);
  assert.equal(result.unknownGpus, 1);
  assert.deepEqual(result.groups[0].cards.map(({ index, uncertain, inferred }) => [index, uncertain, inferred]), [[0, true, false], [1, false, true], [2, false, false]]);
});

test("stale and refresh-failed cards remain historical, failed/pending nodes are not counted as empty", () => {
  const result = summarize([node("stale"), node("failed-refresh"), node("offline"), node("pending"), node("invalid-date")], {
    stale: status([gpu(0, [process("alice")])], { checkedAt: new Date(now - 80_000).toISOString() }),
    "failed-refresh": status([gpu(1, [process("alice")])], { refreshFailed: true }),
    offline: status([], { ok: false }),
    "invalid-date": status([gpu(0, [process("alice")])], { checkedAt: "invalid" }),
  });
  assert.equal(result.matchedCount, 0);
  assert.equal(result.unavailableNodes, 5);
  assert.equal(result.groups.length, 3);
  assert.ok(result.groups.every((group) => group.stale));
  assert.equal(summarize([node("a")], { a: status([]) }).unavailableNodes, 0);
});

test("profile returns only the local account without collecting remote data", async () => {
  const server = createApiServer({
    getAccount: () => "local-alice",
    getConfig: () => { throw new Error("must not load nodes"); },
    collectNode: () => { throw new Error("must not contact remote nodes"); },
  });
  const response = await new Promise((resolve) => {
    let statusCode;
    server.emit("request", { method: "GET", headers: {}, url: "/api/profile" }, {
      setHeader() {},
      writeHead(code) { statusCode = code; },
      end(body) { resolve({ statusCode, body: JSON.parse(body) }); },
    });
  });
  assert.deepEqual(response, { statusCode: 200, body: { account: "local-alice" } });
});
