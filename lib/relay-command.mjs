import { gzipSync } from "node:zlib";

export const relayCommandReadyMarker = "__WATCH4GPU_COMMAND_READY__";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// The legacy login script owns authentication. Intercept only its handoff to
// pexpect, in this one client process, and leave the authenticated CLI available
// for a fixed read-only command. No scripts or server processes are modified.
export function buildRelayCommandLogin(node) {
  // Slow shared storage can take more than the client's default 3 seconds to
  // acknowledge a command. Extend only this client's wait, retaining the same
  // message ID and the outer collection deadline (no extra command sessions).
  const adapter = String.raw`
rename spawn watch4gpu_original_spawn
proc spawn {args} {
  set boot_index [lsearch -exact $args -c]
  if {$boot_index >= 0} {
    incr boot_index
    set boot [lindex $args $boot_index]
    set entry {exec(open('./client_start.py').read())}
    set replacement {from fake_cmd.utils import config; config.msg_confirm_wait_timeout=15.0; exec(open('./client_start.py').read())}
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
  const login = `expect() { command expect -c ${shellQuote(adapter)} -- "$@"; }; source ${node.loginScript} ${shellQuote(String(node.loginArg || node.gpuNodeId))}`;
  return `bash -c ${shellQuote(login)}`;
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
