import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["server.mjs"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev"], { stdio: "inherit" }),
];

function stop(signal = "SIGTERM") {
  for (const child of children) child.kill(signal);
}

process.on("SIGINT", () => { stop("SIGINT"); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
for (const child of children) child.on("exit", (code) => {
  if (code && code !== 0) { stop(); process.exit(code); }
});
