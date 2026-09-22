import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { startWatch4gpu } from "../scripts/watch4gpu.mjs";
import { startApiServer } from "../server.mjs";

function harness({ failSpawn = 0 } = {}) {
  const runtime = Object.assign(new EventEmitter(), { platform: "darwin", execPath: "/test/node" });
  const children = [];
  const signals = [];
  const errors = [];
  const exits = [];
  const timers = [];
  runtime.exit = (code) => exits.push(code);
  startWatch4gpu({
    runtime,
    spawnChild(command, args, options) {
      if (children.length + 1 === failSpawn) throw new Error("spawn unavailable");
      const child = Object.assign(new EventEmitter(), { pid: 100 + children.length, command, args, options });
      children.push(child);
      return child;
    },
    signalGroup: (pid, signal) => signals.push([pid, signal]),
    logError: (message) => errors.push(message),
    schedule: (callback) => timers.push(callback),
  });
  return { runtime, children, signals, errors, exits, timers, finish: () => timers.splice(0).forEach((callback) => callback()) };
}

function fakeApi(child) {
  const server = new EventEmitter();
  server.listen = (port, host, ready) => { server.ready = ready; server.port = port; server.host = host; };
  const runtime = Object.assign(new EventEmitter(), {
    connected: true,
    send: (message) => child.emit("message", message),
    disconnect() { this.connected = false; this.emit("disconnect"); },
    exit: (code) => child.emit("exit", code),
  });
  const errors = [];
  startApiServer({ server, runtime, log() {}, logError: (message) => errors.push(message) });
  return { server, runtime, errors };
}

test("a busy API port reports actionable guidance and never starts the frontend", () => {
  const app = harness();
  const api = fakeApi(app.children[0]);
  api.server.emit("error", Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }));
  assert.equal(app.children.length, 1);
  assert.equal(api.runtime.connected, false, "failed API releases its IPC connection");
  assert.equal(api.errors.length, 1);
  assert.ok(api.errors[0].includes(`${api.server.host}:${api.server.port}`));
  assert.match(api.errors[0], /已被占用.*已有页面.*Ctrl\+C/);
  assert.doesNotMatch(api.errors[0], /Unhandled|\n\s+at /);
  app.children[0].emit("message", { type: "watch4gpu:api-ready" });
  assert.equal(app.children.length, 1, "late readiness cannot restart a stopped launcher");
  app.finish();
  assert.deepEqual(app.exits, [1]);
});

test("frontend starts exactly once after the API listening callback", () => {
  const app = harness();
  const api = fakeApi(app.children[0]);
  assert.equal(app.children.length, 1);
  app.children[0].emit("message", { type: "unrelated" });
  assert.equal(app.children.length, 1);
  api.server.ready();
  api.server.ready();
  assert.equal(app.children.length, 2);
  assert.equal(app.children[1].command, "npm");
  assert.deepEqual(app.children[1].args, ["run", "dev"]);
  assert.deepEqual(app.children[0].options.stdio, ["inherit", "inherit", "inherit", "ipc"]);
  assert.ok(app.children.every((child) => child.options.detached));
});

test("Ctrl+C stops only owned process groups, including descendants, exactly once", () => {
  const app = harness();
  app.children[0].emit("message", { type: "watch4gpu:api-ready" });
  app.runtime.emit("SIGINT");
  app.children[1].emit("exit", 0);
  app.runtime.emit("SIGTERM");
  assert.deepEqual(app.signals, [[-100, "SIGINT"], [-101, "SIGINT"]]);
  app.finish();
  assert.deepEqual(app.signals.slice(2), [[-100, "SIGKILL"], [-101, "SIGKILL"]]);
  assert.deepEqual(app.exits, [0]);
});

test("closing the terminal stops both owned process groups", () => {
  const app = harness();
  app.children[0].emit("message", { type: "watch4gpu:api-ready" });
  app.runtime.emit("SIGHUP");
  assert.deepEqual(app.signals, [[-100, "SIGTERM"], [-101, "SIGTERM"]]);
  app.finish();
  assert.deepEqual(app.exits, [0]);
});

test("API exits when its launcher disconnects", () => {
  const child = new EventEmitter();
  const exits = [];
  child.on("exit", (code) => exits.push(code));
  const api = fakeApi(child);
  api.server.ready();
  api.runtime.disconnect();
  assert.deepEqual(exits, [0]);
});

test("standalone API does not subscribe to a launcher disconnect", () => {
  const server = new EventEmitter();
  server.listen = () => {};
  const runtime = new EventEmitter();
  startApiServer({ server, runtime });
  assert.equal(runtime.listenerCount("disconnect"), 0);
});

test("a child exit also shuts down its sibling even when its exit code is zero", () => {
  for (const code of [0, 2]) {
    const app = harness();
    app.children[0].emit("message", { type: "watch4gpu:api-ready" });
    app.children[1].emit("exit", code);
    assert.deepEqual(app.signals, [[-100, "SIGTERM"], [-101, "SIGTERM"]]);
    app.finish();
    assert.deepEqual(app.exits, [code]);
  }
});

test("synchronous frontend spawn failure shuts down the API", () => {
  const app = harness({ failSpawn: 2 });
  app.children[0].emit("message", { type: "watch4gpu:api-ready" });
  assert.match(app.errors[0], /启动 前端 失败：spawn unavailable/);
  assert.deepEqual(app.signals, [[-100, "SIGTERM"]]);
  app.finish();
  assert.deepEqual(app.exits, [1]);
});

test("asynchronous child spawn failure exits without an unhandled error", () => {
  const app = harness();
  app.children[0].pid = undefined;
  app.children[0].emit("error", new Error("ENOENT"));
  assert.match(app.errors[0], /启动 API 失败：ENOENT/);
  assert.deepEqual(app.exits, [1]);
  assert.deepEqual(app.signals, []);
});
