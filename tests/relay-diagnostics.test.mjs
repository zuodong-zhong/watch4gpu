import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { relayRemoteProbeSteps, runRelay } from "../server.mjs";

const relayNode = { gatewayHost: "gateway", gpuNodeId: "34", loginScript: "/shared/login_1.sh" };
const shellReady = "[fake_cmd GPU34]$ pexpect --kill_disabled -- /bin/bash\r\nroot@gpu:/# ";
const selectError = "Command terminated with exception: <class 'ValueError'> - filedescriptor out of range in select()";

class FakeChild extends EventEmitter {
  pid = 123;
  exitCode = null;
  signalCode = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  writes = [];
  signals = [];
  killed = new Promise((resolve) => { this.resolveKilled = resolve; });

  constructor() {
    super();
    this.stdin.on("data", (chunk) => { this.writes.push(chunk.toString()); });
  }

  kill(signal) {
    this.signals.push(signal);
    this.resolveKilled();
    return true;
  }

  close() {
    this.signalCode = "SIGTERM";
    this.emit("close", null, "SIGTERM");
  }
}

async function timeoutError(output, node = relayNode, completedSteps = []) {
  const child = new FakeChild();
  const result = runRelay(node, 15, () => child).then(
    () => assert.fail("expected a timeout"),
    (error) => error,
  );
  if (output) child.stdout.write(output);
  for (const marker of completedSteps) child.stdout.write(`${marker}\n`);
  await child.killed;
  child.close();
  return result;
}

test("relay timeouts identify login progress without copying the transcript", async () => {
  const cases = [
    ["", relayNode, "连接 SSH 网关"],
    ["SUDOPASS:private-session-detail\r\n", relayNode, "等待中转服务握手"],
    ["[fake_cmd GPU34]$ ", relayNode, "等待交互终端启动"],
    ["[fake_cmd GPU34]$ pexpect --kill_disabled -- /bin/bash\r\n", relayNode, "等待节点 Shell"],
    ["root@gpu:/# conda activate /private-environment\r\n", { ...relayNode, loginScript: "/shared/login.sh" }, "等待 Conda 初始化"],
  ];
  for (const [output, node, stage] of cases) {
    const error = await timeoutError(output, node);
    assert.equal(error.message, `中转连接超时（0 秒）：${stage}`);
    assert.doesNotMatch(error.message, /private-session-detail|private-environment/);
  }
});

test("relay timeouts distinguish a connected GPU query from slow device inspection", async () => {
  const gpuError = await timeoutError(shellReady, relayNode, ["__WATCH4GPU_GPUS__"]);
  assert.match(gpuError.message, /^中转连接超时.*读取 GPU 状态$/);

  const deviceError = await timeoutError(shellReady, relayNode, relayRemoteProbeSteps.slice(0, 7).map(({ marker }) => marker));
  assert.match(deviceError.message, /^中转连接超时.*读取 GPU 设备占用$/);
});

test("a fragmented server select error fails promptly and waits for local SSH cleanup", async () => {
  const child = new FakeChild();
  let settled = false;
  const result = runRelay(relayNode, 10_000, () => child).catch((error) => {
    settled = true;
    return error;
  });
  child.stdout.write("private-session-detail\r\n[ fake startup ]\r\n\u001b[31mCommand terminated with exception: <class 'ValueError'> - filedescriptor out of range ");
  assert.deepEqual(child.signals, []);
  child.stdout.write("in select()\u001b[0m\r\n");
  await child.killed;
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(settled, false);
  assert.deepEqual(child.writes, []);
  child.stdout.write(shellReady);
  assert.deepEqual(child.writes, [], "failed sessions must not receive probe commands");
  child.close();
  const error = await result;
  assert.equal(error.message, "中转交互终端启动失败：服务器 select() 文件描述符超出限制，无法创建节点 Shell");
  assert.doesNotMatch(error.message, /private-session-detail/);
});

test("the same select failure is recognized on stderr", async () => {
  const child = new FakeChild();
  const result = runRelay(relayNode, 10_000, () => child).catch((error) => error);
  child.stderr.write(selectError);
  await child.killed;
  child.close();
  assert.match((await result).message, /select\(\) 文件描述符超出限制/);
});

test("two relay sessions keep independent input and progress", async () => {
  const children = [new FakeChild(), new FakeChild()];
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    return children[calls.length - 1];
  };
  const first = runRelay(relayNode, 10_000, spawn);
  const second = runRelay({ ...relayNode, gpuNodeId: "46" }, 10_000, spawn);
  assert.equal(calls[0].args.at(-1), "bash /shared/login_1.sh 34");
  assert.equal(calls[1].args.at(-1), "bash /shared/login_1.sh 46");

  children[0].stdout.write(shellReady);
  assert.equal(children[0].writes.length, 1);
  assert.equal(children[1].writes.length, 0);
  children[1].stdout.write(shellReady);
  for (const { marker } of relayRemoteProbeSteps) children[0].stdout.write(`${marker}\n`);
  await children[0].killed;
  assert.equal(children[1].writes.length, 1);
  assert.deepEqual(children[1].signals, []);
  children[0].close();
  assert.match(await first, /__WATCH4GPU_DONE__/);

  for (const { marker } of relayRemoteProbeSteps) children[1].stdout.write(`${marker}\n`);
  await children[1].killed;
  children[1].close();
  assert.match(await second, /__WATCH4GPU_DONE__/);
  const commands = relayRemoteProbeSteps.map(({ command }) => `${command}\r`);
  assert.deepEqual(children[0].writes, commands);
  assert.deepEqual(children[1].writes, commands);
});
