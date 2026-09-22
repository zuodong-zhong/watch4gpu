import assert from "node:assert/strict";
import test from "node:test";

import { createNodePoller } from "../lib/node-poller.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function fixture(interval = 100) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const calls = [];
  const results = [];
  const errors = [];
  const activity = [];
  const poller = createNodePoller({
    poll(node) {
      const request = deferred();
      calls.push({ node, at: now, ...request });
      return request.promise;
    },
    onResult: (node, result) => results.push({ node, result }),
    onError: (node, error) => errors.push({ node, error }),
    onActivity: (count) => activity.push(count),
    setTimer(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  poller.setInterval(interval);

  return {
    poller, calls, results, errors, activity, timers,
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

test("slow nodes do not overlap or hold back a fast node's independent schedule", async () => {
  const f = fixture();
  f.poller.setNodes([{ id: "slow" }, { id: "fast" }]);
  await flush();
  assert.deepEqual(f.calls.map(({ node }) => node.id), ["slow", "fast"]);
  assert.equal(f.activity.at(-1), 2);

  await f.advance(20);
  f.calls[1].resolve("first fast result");
  await flush();
  await f.advance(99);
  assert.equal(f.calls.length, 2);
  await f.advance(1);
  assert.equal(f.calls[2].node.id, "fast");
  assert.equal(f.calls[2].at, 120);
  await f.advance(200);
  assert.equal(f.calls.length, 3);

  f.calls[0].resolve("slow result");
  await flush();
  await f.advance(100);
  assert.equal(f.calls[3].node.id, "slow");
  assert.equal(f.calls[3].at, 420);
  f.poller.stop();
});

test("manual refresh joins active work and replaces a waiting timer without queuing another run", async () => {
  const f = fixture();
  f.poller.setNodes([{ id: "one" }]);
  await flush();
  const firstRefresh = f.poller.refresh("one");
  const secondRefresh = f.poller.refresh();
  await f.advance(500);
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve("first");
  await Promise.all([firstRefresh, secondRefresh]);
  assert.equal(f.calls.length, 1);
  await f.advance(50);

  const manual = f.poller.refresh("one");
  await flush();
  assert.equal(f.calls.length, 2);
  await f.advance(200);
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve("manual");
  await manual;
  await f.advance(100);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].at, 850);
  f.poller.stop();
});

test("failed requests wait the full interval before retrying and manual refresh shares the failure", async () => {
  const f = fixture();
  f.poller.setNodes([{ id: "one" }]);
  await flush();
  const refresh = f.poller.refresh("one");
  const failure = new Error("timed out");
  f.calls[0].reject(failure);
  await refresh;
  assert.deepEqual(f.errors, [{ node: { id: "one" }, error: failure }]);
  assert.equal(f.activity.at(-1), 0);
  await f.advance(99);
  assert.equal(f.calls.length, 1);
  await f.advance(1);
  assert.equal(f.calls.length, 2);
  f.poller.stop();
});

test("interval changes reset waiting timers, apply after active work, and pause automatic polling", async () => {
  const f = fixture();
  f.poller.setNodes([{ id: "one" }, { id: "two" }]);
  await flush();
  f.calls[0].resolve("one");
  await flush();
  await f.advance(20);
  f.poller.setInterval(200);
  f.calls[1].resolve("two");
  await flush();
  await f.advance(199);
  assert.equal(f.calls.length, 2);
  await f.advance(1);
  assert.equal(f.calls.length, 4);

  f.poller.setInterval(0);
  f.calls[2].resolve("one again");
  f.calls[3].resolve("two again");
  await flush();
  await f.advance(1_000);
  assert.equal(f.calls.length, 4);
  assert.equal(f.timers.size, 0);

  const manual = f.poller.refresh("one");
  await flush();
  assert.equal(f.calls.length, 5);
  f.calls[4].resolve("manual");
  await manual;
  assert.equal(f.timers.size, 0);
  f.poller.setInterval(50);
  await f.advance(50);
  assert.equal(f.calls.length, 7);
  f.poller.stop();
});

test("unchanged nodes retain their timers and new nodes load even when automatic polling is paused", async () => {
  const f = fixture();
  f.poller.setNodes([{ id: "one" }]);
  await flush();
  f.calls[0].resolve("one");
  await flush();
  await f.advance(50);
  f.poller.setNodes([{ id: "one" }, { id: "two" }, { id: "disabled", enabled: false }]);
  await flush();
  assert.equal(f.calls[1].node.id, "two");
  await f.advance(50);
  assert.equal(f.calls[2].node.id, "one");
  assert.equal(f.calls[2].at, 100);

  f.poller.setInterval(0);
  f.poller.setNodes([{ id: "one" }, { id: "two" }, { id: "three" }]);
  await flush();
  assert.equal(f.calls[3].node.id, "three");
  f.poller.stop();
});

test("changed config waits for the old request, suppresses its result, and immediately loads the latest config", async () => {
  const f = fixture(0);
  f.poller.setNodes([{ id: "one", host: "old" }]);
  await flush();
  f.poller.setNodes([{ id: "one", host: "intermediate" }]);
  f.poller.setNodes([{ id: "one", host: "new" }]);
  await flush();
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve("stale");
  await flush();
  assert.deepEqual(f.results, []);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].node, { id: "one", host: "new" });
  f.calls[1].resolve("fresh");
  await flush();
  assert.deepEqual(f.results, [{ node: { id: "one", host: "new" }, result: "fresh" }]);
  assert.equal(f.timers.size, 0);
  f.poller.stop();
});

test("removed or disabled nodes stop polling and readding an active id still preserves its slot", async () => {
  const f = fixture();
  f.poller.setNodes([{ id: "one" }, { id: "two" }]);
  await flush();
  f.calls[1].resolve("two");
  await flush();
  f.poller.setNodes([{ id: "two", enabled: false }]);
  assert.equal(f.activity.at(-1), 0);
  assert.equal(f.timers.size, 0);
  f.poller.setNodes([{ id: "one" }]);
  await flush();
  assert.equal(f.calls.length, 2);
  f.calls[0].reject(new Error("obsolete failure"));
  await flush();
  assert.deepEqual(f.errors, []);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].node.id, "one");
  f.poller.setNodes([]);
  f.calls[2].resolve("removed");
  await flush();
  await f.advance(1_000);
  assert.deepEqual(f.results, [{ node: { id: "two" }, result: "two" }]);
  assert.equal(f.calls.length, 3);
  f.poller.stop();
});

test("stop clears waiting timers and suppresses results, errors, activity, and future work", async () => {
  const f = fixture();
  f.poller.setNodes([{ id: "done" }, { id: "late" }, { id: "error" }]);
  await flush();
  f.calls[0].resolve("before stop");
  await flush();
  const activityBeforeStop = [...f.activity];
  f.poller.stop();
  f.calls[1].resolve("late");
  f.calls[2].reject(new Error("late error"));
  await flush();
  f.poller.setNodes([{ id: "new" }]);
  f.poller.setInterval(1);
  await f.poller.refresh();
  await f.advance(1_000);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.results, [{ node: { id: "done" }, result: "before stop" }]);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.activity, activityBeforeStop);
  assert.equal(f.timers.size, 0);
});

test("stop before dispatch prevents requests from starting", async () => {
  const f = fixture();
  f.poller.setNodes([{ id: "one" }]);
  f.poller.stop();
  await flush();
  assert.equal(f.calls.length, 0);
});
