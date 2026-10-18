import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { sshOptions } from "../lib/ssh-options.mjs";
import { relayRemoteProbeSteps, runRelay } from "../server.mjs";

test("SSH keepalive failure cannot preempt the selected collection deadline", () => {
  for (const timeoutMs of [5000, 15000, 25000, 45000, 60000, 90000, 120000]) {
    const options = Object.fromEntries(sshOptions(timeoutMs).filter((value) => value.includes("=")).map((value) => value.split("=")));
    assert.ok(Number(options.ServerAliveInterval) * Number(options.ServerAliveCountMax) * 1000 > timeoutMs);
    assert.ok(Number(options.ConnectTimeout) * 1000 <= timeoutMs);
    assert.equal(options.BatchMode, "yes");
    assert.equal(sshOptions(timeoutMs)[0], "-T");
    assert.equal(sshOptions(timeoutMs, true)[0], "-tt");
  }
});

test("relay SSH uses the requested deadline as well as terminal mode", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    pid: 123, exitCode: null, signalCode: null,
    kill() { queueMicrotask(() => this.emit("close", null, "SIGTERM")); },
  });
  const result = runRelay({ gatewayHost: "gateway", gpuNodeId: "1", loginScript: "/shared/login_new.sh" }, 90_000, (command, args) => {
    assert.equal(command, "ssh");
    assert.deepEqual(args.slice(0, -2), sshOptions(90_000, true));
    return child;
  });
  child.stdout.write("pexpect --kill_disabled -- /bin/bash\r\nroot@gpu:/# ");
  for (const { marker } of relayRemoteProbeSteps) child.stdout.write(`${marker}\n`);
  await result;
});
