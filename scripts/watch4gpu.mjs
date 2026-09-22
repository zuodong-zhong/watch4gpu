import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function startWatch4gpu({ spawnChild = spawn, runtime = process, signalGroup = process.kill.bind(process), logError = console.error, schedule = setTimeout } = {}) {
  const children = [];
  const isolatedGroups = runtime.platform !== "win32";
  let stopping = false;
  let frontendStarted = false;

  function signalChild(child, signal) {
    if (!child.pid) return false;
    try {
      if (isolatedGroups) {
        // Only target process groups created by this launcher, including npm's descendants.
        signalGroup(-child.pid, signal);
        return true;
      }
      return child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") logError(`停止子进程失败：${error.message}`);
      return false;
    }
  }

  function stop(code = 0, signal = "SIGTERM") {
    if (stopping) return;
    stopping = true;
    const running = children.filter((child) => signalChild(child, signal));
    if (!running.length) return runtime.exit(code);
    // Keep the launcher alive briefly so surviving descendants are also cleaned up.
    schedule(() => {
      for (const child of running) signalChild(child, "SIGKILL");
      runtime.exit(code);
    }, 1000);
  }

  function launch(command, args, api = false) {
    try {
      const child = spawnChild(command, args, {
        detached: isolatedGroups,
        stdio: api ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
      });
      children.push(child);
      child.once("error", (error) => {
        if (stopping) return;
        logError(`启动 ${api ? "API" : "前端"} 失败：${error.message}`);
        stop(1);
      });
      child.once("exit", (code, signal) => stop(code ?? (signal ? 1 : 0)));
      return child;
    } catch (error) {
      logError(`启动 ${api ? "API" : "前端"} 失败：${error.message}`);
      stop(1);
    }
  }

  runtime.once("SIGINT", () => stop(0, "SIGINT"));
  runtime.once("SIGTERM", () => stop());
  if (isolatedGroups) runtime.once("SIGHUP", () => stop());
  const api = launch(runtime.execPath, ["server.mjs"], true);
  api?.on("message", (message) => {
    if (stopping || frontendStarted || message?.type !== "watch4gpu:api-ready") return;
    frontendStarted = true;
    launch(runtime.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"]);
  });
  return { stop };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startWatch4gpu();
}
