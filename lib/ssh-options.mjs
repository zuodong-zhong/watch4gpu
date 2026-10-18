// The application owns the total deadline. SSH keepalives must not silently
// shorten a 45–120 second collection to roughly 15 seconds on a busy gateway.
export function sshOptions(timeoutMs, terminal = false) {
  return [
    terminal ? "-tt" : "-T",
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${Math.min(8, Math.max(1, Math.ceil(timeoutMs / 1000)))}`,
    "-o", "ServerAliveInterval=5",
    "-o", `ServerAliveCountMax=${Math.ceil(timeoutMs / 5000) + 1}`,
  ];
}
