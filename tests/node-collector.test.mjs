import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createNodeCollector } from "../node-collector.mjs";
import { createApiServer, relayRemoteProbeSteps, run, runRelay } from "../server.mjs";

const directNode = { id: "node-a", name: "Node A", mode: "direct", sshHost: "host-a", port: 22 };
const relayNode = { id: "node-a", name: "Node A", mode: "relay", gatewayHost: "gateway", gpuNodeId: "34", loginScript: "/shared/login_1.sh" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function statusRequest(server, path) {
  return new Promise((resolve) => {
    let status;
    server.emit("request", { method: "GET", headers: {}, url: path }, {
      setHeader() {},
      writeHead(code) { status = code; },
      end(body) { resolve({ status, body: JSON.parse(body) }); },
    });
  });
}

test("bulk and single-node API requests share a collection despite different timeouts", async () => {
  const nodes = [directNode, { ...directNode, id: "node-b", sshHost: "host-b" }];
  const calls = [];
  const collectNode = createNodeCollector((node, timeoutMs) => {
    const work = deferred();
    calls.push({ node, timeoutMs, work });
    return work.promise;
  });
  const server = createApiServer({ getConfig: async () => ({ nodes }), collectNode });
  const requests = [
    statusRequest(server, "/api/status?timeoutSeconds=45"),
    statusRequest(server, "/api/status?node=node-a&timeoutSeconds=120"),
    statusRequest(server, "/api/status?timeoutSeconds=5"),
  ];
  await nextTurn();
  assert.deepEqual(calls.map(({ node, timeoutMs }) => [node.id, timeoutMs]), [["node-a", 45_000], ["node-b", 45_000]]);
  for (const { node, work } of calls) work.resolve({ nodeId: node.id, ok: true, gpus: [] });
  const responses = await Promise.all(requests);
  assert.ok(responses.every(({ status }) => status === 200));
  assert.deepEqual(responses.map(({ body }) => body.statuses.map(({ nodeId }) => nodeId)), [
    ["node-a", "node-b"], ["node-a"], ["node-a", "node-b"],
  ]);

  const later = statusRequest(server, "/api/status?node=node-a&timeoutSeconds=120");
  await nextTurn();
  assert.equal(calls.length, 3, "settled results are not cached");
  assert.equal(calls[2].timeoutMs, 120_000);
  calls[2].work.resolve({ nodeId: "node-a", ok: true, gpus: [] });
  await later;
});

test("a failed collection is shared and the next request can retry", async () => {
  const work = deferred();
  let count = 0;
  const collect = createNodeCollector(() => ++count === 1 ? work.promise : "recovered");
  const first = collect(directNode, 25_000);
  const duplicate = collect({ ...directNode, name: "Renamed" }, 45_000);
  assert.equal(first, duplicate);
  const rejected = assert.rejects(first, /temporary failure/);
  work.reject(new Error("temporary failure"));
  await rejected;
  assert.equal(await collect(directNode), "recovered");
  assert.equal(count, 2);
});

test("changed target configurations queue per node and return their own results", async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const collect = createNodeCollector((node) => {
    const work = deferred();
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    calls.push({ node, work });
    return work.promise.finally(() => { active -= 1; });
  });
  const first = collect(directNode);
  const updated = { ...directNode, sshHost: "replacement-host" };
  const second = collect(updated);
  const secondDuplicate = collect(updated, 120_000);
  assert.equal(second, secondDuplicate);
  updated.sshHost = "mutated-after-request";
  const third = collect(relayNode);
  await nextTurn();
  assert.equal(calls.length, 1);
  const rejected = assert.rejects(first, /old connection failed/);
  calls[0].work.reject(new Error("old connection failed"));
  await rejected;
  await nextTurn();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].node.sshHost, "replacement-host");
  calls[1].work.resolve("replacement result");
  assert.equal(await second, "replacement result");
  await nextTurn();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].node.mode, "relay");
  calls[2].work.resolve("relay result");
  assert.equal(await third, "relay result");
  assert.equal(maximumActive, 1);
});

test("connection-affecting settings are distinct even when the node id is unchanged", async () => {
  const variants = [
    [directNode, { ...directNode, port: 2222 }],
    [relayNode, { ...relayNode, gatewayHost: "other-gateway" }],
    [relayNode, { ...relayNode, loginScript: "/shared/login_new.sh" }],
    [relayNode, { ...relayNode, gpuNodeId: "46" }],
    [relayNode, { ...relayNode, loginArg: "GPU24" }],
    [relayNode, { ...relayNode, relayTransport: "command" }],
  ];
  for (const [initial, updated] of variants) {
    const firstWork = deferred();
    const calls = [];
    const collect = createNodeCollector((node) => {
      calls.push(node);
      return calls.length === 1 ? firstWork.promise : "new target";
    });
    const first = collect(initial);
    const second = collect(updated);
    await nextTurn();
    assert.equal(calls.length, 1);
    firstWork.resolve("old target");
    assert.deepEqual(await Promise.all([first, second]), ["old target", "new target"]);
    assert.equal(calls.length, 2);
  }
});

test("default and explicit shell transports share the same collection", async () => {
  const work = deferred();
  let count = 0;
  const collect = createNodeCollector(() => {
    count += 1;
    return work.promise;
  });
  const implicit = collect(relayNode);
  const explicit = collect({ ...relayNode, relayTransport: "shell" });
  assert.equal(implicit, explicit);
  await nextTurn();
  assert.equal(count, 1);
  work.resolve("shared shell result");
  assert.equal(await explicit, "shared shell result");
});

class FakeChild extends EventEmitter {
  pid = 123;
  exitCode = null;
  signalCode = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  signals = [];
  onKill = deferred();

  kill(signal) {
    this.signals.push(signal);
    this.onKill.resolve(signal);
    return true;
  }

  close(code = null, signal = "SIGTERM") {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

test("a direct SSH timeout keeps its node locked until the child closes", async () => {
  const children = [];
  const collect = createNodeCollector(() => run("ssh", [], undefined, 10, () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  }));
  const first = collect(directNode);
  const rejected = assert.rejects(first, /连接超时/);
  await nextTurn();
  await children[0].onKill.promise;
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  assert.equal(collect(directNode, 120_000), first);
  const replacement = collect({ ...directNode, sshHost: "new-host" });
  await nextTurn();
  assert.equal(children.length, 1, "timeout alone must not release the node");
  children[0].close();
  await rejected;
  await nextTurn();
  assert.equal(children.length, 2);
  children[1].stdout.write("__WATCH4GPU_DONE__\n");
  children[1].close(0, null);
  assert.equal(await replacement, "__WATCH4GPU_DONE__\n");
});

test("successful relay output waits for SSH exit and stops sending probe commands", async () => {
  const child = new FakeChild();
  let settled = false;
  const result = runRelay(relayNode, 10_000, () => child).then((value) => {
    settled = true;
    return value;
  });
  child.stdout.write("pexpect -- /bin/bash\r\nroot@gpu:/# ");
  for (const { marker } of relayRemoteProbeSteps) child.stdout.write(`${marker}\n`);
  await child.onKill.promise;
  await nextTurn();
  assert.equal(settled, false);
  const sentBytes = child.stdin.readableLength;
  child.stdout.write("late output after completion\n");
  assert.equal(child.stdin.readableLength, sentBytes);
  child.close();
  assert.match(await result, /__WATCH4GPU_DONE__/);
});

test("relay timeouts settle only after child close", async () => {
  const child = new FakeChild();
  let settled = false;
  const result = runRelay(relayNode, 10, () => child).finally(() => { settled = true; });
  const rejected = assert.rejects(result, /中转连接超时/);
  await child.onKill.promise;
  await nextTurn();
  assert.equal(settled, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  child.close();
  await rejected;
});

test("unresponsive local SSH children receive SIGKILL before the collection unlocks", async () => {
  const children = [new FakeChild(), new FakeChild()];
  const results = [
    run("ssh", [], undefined, 10, () => children[0]),
    runRelay(relayNode, 10, () => children[1]),
  ];
  const rejected = results.map((result) => assert.rejects(result, /连接超时/));
  await Promise.all(children.map((child) => child.onKill.promise));
  await delay(1100);
  for (const child of children) {
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
    child.close(null, "SIGKILL");
  }
  await Promise.all(rejected);
});

test("spawn errors wait for the child close event and release the collection", async () => {
  for (const execute of [
    (child) => run("ssh", [], undefined, 10_000, () => child),
    (child) => runRelay(relayNode, 10_000, () => child),
  ]) {
    const child = new FakeChild();
    child.pid = undefined;
    let settled = false;
    const result = execute(child).finally(() => { settled = true; });
    const rejected = assert.rejects(result, /spawn failed/);
    child.emit("error", new Error("spawn failed"));
    await nextTurn();
    assert.equal(settled, false);
    assert.deepEqual(child.signals, []);
    child.close(-2, null);
    await rejected;
  }
});
