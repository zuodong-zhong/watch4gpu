import { gzipSync } from "node:zlib";

export const relayCommandReadyMarker = "__WATCH4GPU_COMMAND_READY__";
export const relayClientStartedMarker = "__WATCH4GPU_CLIENT_STARTED__";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// The legacy login script owns authentication. Adapt startup waits in this one
// client process, and optionally replace its pexpect handoff with a fixed
// read-only command. No scripts or server processes are modified.
export function buildRelayLogin(node, timeoutMs = 90_000) {
  const commandMode = node.relayTransport === "command";
  const loginArg = shellQuote(String(node.loginArg || node.gpuNodeId));
  if (!commandMode && !/(?:^|\/)login(?:_1)?\.sh$/.test(node.loginScript || "")) {
    return `bash ${node.loginScript} ${loginArg}`;
  }
  // Legacy scripts start their 30-second prompt timer immediately after sending
  // the sudo password. Authentication alone can take slightly over 30 seconds,
  // so that timer repeatedly kills a healthy client before Python even starts.
  // Change only this Expect process; Node still enforces the overall deadline.
  const startupSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const startupAdapter = `
proc watch4gpu_startup_timeout {name index operation} {
  upvar 1 $name value
  if {$value > 0 && $value < ${startupSeconds}} { set value ${startupSeconds} }
}
trace add variable prompt_timeout write watch4gpu_startup_timeout
`;
  // Slow shared storage can take more than the client's default 3 seconds to
  // acknowledge a command. Extend only this client's wait, retaining the same
  // message ID and the outer collection deadline (no extra command sessions).
  const commandAdapter = String.raw`
rename spawn watch4gpu_original_spawn
proc spawn {args} {
  set boot_index [lsearch -exact $args -c]
  if {$boot_index >= 0} {
    incr boot_index
    set boot [lindex $args $boot_index]
    set entry {exec(open('./client_start.py').read())}
    set replacement {print("__WATCH4GPU_CLIENT_STARTED__", flush=True); from fake_cmd.utils import config; config.msg_confirm_wait_timeout=15.0; exec(open('./client_start.py').read())}
    set args [lreplace $args $boot_index $boot_index [string map [list $entry $replacement] $boot]]
  }
  uplevel 1 [list watch4gpu_original_spawn {*}$args]
}
rename send watch4gpu_original_send
proc send {args} {
  if {[regexp {^pexpect\s+--kill_disabled\s+--\s+/bin/bash\r?$} [lindex $args end]]} {
    send_user "\n__WATCH4GPU_COMMAND_READY__\n"
    interact
    exit 0
  }
  watch4gpu_original_send {*}$args
}
`;
  // expect -c installs the adapter before Expect loads the supplied script and
  // initializes argv. Sourcing that script inside -c would run it too early.
  const adapter = startupAdapter + (commandMode ? commandAdapter : "");
  const login = `expect() { command expect -c ${shellQuote(adapter)} -- "$@"; }; source ${node.loginScript} ${loginArg}`;
  return `bash -c ${shellQuote(login)}`;
}

export function buildRelayCommandLogin(node, timeoutMs) {
  return buildRelayLogin({ ...node, relayTransport: "command" }, timeoutMs);
}

export function buildRelayCommandProbe(steps) {
  // One request avoids a round trip for every section. Compression keeps it
  // below the canonical PTY line limit; decoding and execution use pipes only.
  const script = steps.map(({ command }) => command).join("\n");
  const payload = gzipSync(script).toString("base64");
  const command = `cmd --exec /bin/bash -- printf '%s' '${payload}' | base64 -d | gzip -dc | /bin/bash`;
  if (Buffer.byteLength(command) > 4095) throw new Error("兼容采集命令超过终端行长度限制");
  return command;
}
