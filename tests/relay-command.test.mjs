import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { buildRelayCommandLogin, buildRelayCommandProbe, relayCommandReadyMarker } from "../lib/relay-command.mjs";
import { relayRemoteProbeSteps, runRelay } from "../server.mjs";

const node = { id: "gpu-test", mode: "relay", gatewayHost: "gateway", gpuNodeId: "34", loginScript: "/shared/login_1.sh", relayTransport: "command" };

test("command transport carries the complete read-only probe below the terminal line limit", () => {
  const command = buildRelayCommandProbe(relayRemoteProbeSteps);
  const payload = command.match(/printf '%s' '([A-Za-z0-9+/=]+)'/)[1];
  const decoded = gunzipSync(Buffer.from(payload, "base64")).toString();
  assert.equal(decoded, relayRemoteProbeSteps.map(({ command }) => command).join("\n"));
  assert.ok(Buffer.byteLength(command) <= 4095);
  assert.doesNotMatch(command, /__WATCH4GPU_DONE__|pexpect/);
  assert.equal(spawnSync("bash", ["-n"], { input: decoded }).status, 0);
  assert.doesNotMatch(decoded, /docker exec|\b(?:sudo|kill|pkill|rm|touch|tee)\b/);
});

test("Expect adapter preserves script argv and stops before the pexpect handoff", async (t) => {
  if (spawnSync("expect", ["-v"]).status !== 0) return t.skip("Expect is not installed");
  const directory = await mkdtemp(join(tmpdir(), "watch4gpu-command-"));
  try {
    const script = join(directory, "connect.exp");
    const loginScript = join(directory, "login.sh");
    await writeFile(script, 'send_user "ARG=[lindex $argv 0]\\n"\nproc interact {} { send_user "CLI_HANDOFF\\n" }\nsend "pexpect --kill_disabled -- /bin/bash\\r"\nerror "must not run cd or conda"\n');
    await writeFile(loginScript, `expect ${script} "$1"\n`);
    const result = spawnSync("bash", ["-c", buildRelayCommandLogin({ ...node, loginScript, loginArg: "GPU_34" })], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ARG=GPU_34/);
    assert.ok(result.stdout.includes(relayCommandReadyMarker));
    assert.match(result.stdout, /CLI_HANDOFF/);
    assert.equal(result.stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("client acknowledgement override preserves spawn scope and unrelated arguments", async (t) => {
  const nativeExpect = spawnSync("bash", ["-c", "command -v expect"], { encoding: "utf8" });
  if (nativeExpect.status !== 0) return t.skip("Expect is not installed");
  const expectPath = nativeExpect.stdout.trim();
  assert.match(expectPath, /^\/[A-Za-z0-9_./-]+$/);
  const directory = await mkdtemp(join(tmpdir(), "watch4gpu-spawn-"));
  try {
    const prelude = join(directory, "spawn-prelude.tcl");
    const script = join(directory, "connect.exp");
    const loginScript = join(directory, "login.sh");
    // Emulate Expect's caller-local spawn_id without allocating a real PTY.
    // Installing this before the production adapter exercises its uplevel call.
    await writeFile(prelude, String.raw`
rename spawn native_spawn
proc spawn {args} {
  set ::captured_spawn_args $args
  uplevel 1 [list set spawn_id fake-spawn-id]
  return 123
}
`);
    await writeFile(join(directory, "expect"), `#!/bin/sh\nexec ${expectPath} -c 'source $env(WATCH4GPU_TEST_SPAWN_PRELUDE)' "$@"\n`, { mode: 0o700 });
    await writeFile(script, String.raw`
proc launch {} {
  set boot {import sys; sys.modules['readline']=None; exec(open('./client_start.py').read())}
  set original [list sudo -p SUDOPASS: /fake/python -c $boot --address {./servers/GPU name} --id_prefix {prefix; literal}]
  set result [spawn {*}$original]
  if {![info exists spawn_id] || $spawn_id ne "fake-spawn-id"} { error "spawn_id escaped its caller scope" }
  if {$result != 123} { error "spawn return value changed" }
  if {[llength $::captured_spawn_args] != [llength $original]} { error "argument count changed" }
  for {set i 0} {$i < [llength $original]} {incr i} {
    if {$i != 5 && [lindex $::captured_spawn_args $i] ne [lindex $original $i]} { error "unrelated argument changed at $i" }
  }
  send_user "BOOT=[lindex $::captured_spawn_args 5]\n"
  set unchanged [list /fake/python -c {print("literal ; argv")} --address {path with spaces}]
  spawn {*}$unchanged
  if {$::captured_spawn_args ne $unchanged} { error "unrelated bootstrap was rewritten" }
  send_user "SPAWN_SCOPE_AND_ARGS_OK\n"
}
launch
`);
    await writeFile(loginScript, `expect ${script} "$1"\n`);
    const result = spawnSync("bash", ["-c", buildRelayCommandLogin({ ...node, loginScript })], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, WATCH4GPU_TEST_SPAWN_PRELUDE: prelude },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /SPAWN_SCOPE_AND_ARGS_OK/);
    const boot = result.stdout.split("\n").find((line) => line.startsWith("BOOT=")).slice(5);
    const disableReadline = boot.indexOf("sys.modules['readline']=None");
    const importConfig = boot.indexOf("from fake_cmd.utils import config");
    const extendWait = boot.indexOf("config.msg_confirm_wait_timeout=15.0");
    const startClient = boot.indexOf("exec(open('./client_start.py').read())");
    assert.ok(disableReadline >= 0 && disableReadline < importConfig && importConfig < extendWait && extendWait < startClient, boot);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("command transport sends one batch only after handoff and consumes coalesced markers", async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let killed = false;
  child.kill = () => { killed = true; return true; };
  const result = runRelay(node, 1000, () => child);
  child.stdout.write("[fake_cmd GPU_34]$ ");
  assert.equal(child.stdin.readableLength, 0);
  child.stdout.write(`${relayCommandReadyMarker.slice(0, 20)}`);
  assert.equal(child.stdin.readableLength, 0);
  child.stdout.write(`${relayCommandReadyMarker.slice(20)}\n`);
  assert.equal(child.stdin.read().toString(), `${buildRelayCommandProbe(relayRemoteProbeSteps)}\r`);
  child.stdout.write(`${relayRemoteProbeSteps.map(({ marker }) => marker).join("\n")}\n`);
  assert.equal(child.stdin.readableLength, 0, "no per-section commands in batch mode");
  assert.equal(killed, true);
  child.emit("close", 0);
  assert.match(await result, /__WATCH4GPU_DONE__/);
});
