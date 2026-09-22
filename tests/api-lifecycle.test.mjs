import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

function waitForReady(child, diagnostics) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`API did not become ready: ${diagnostics()}`)), 3000);
    function finish(error) {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    }
    function onMessage(message) {
      if (message?.type === "watch4gpu:api-ready") finish();
    }
    function onError(error) { finish(error); }
    function onExit(code, signal) {
      finish(new Error(`API exited before readiness (${code ?? signal}): ${diagnostics()}`));
    }
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child, diagnostics) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`API remained alive after IPC disconnect: ${diagnostics()}`));
    }, 3000);
    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once("exit", onExit);
  });
}

test("a real API process exits when its launcher IPC connection disappears", { timeout: 10000 }, async (t) => {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, WATCH4GPU_API_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  const diagnostics = () => stderr;
  t.after(async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = waitForExit(child, diagnostics);
    child.kill("SIGKILL");
    await exited;
  });

  await waitForReady(child, diagnostics);
  const exited = waitForExit(child, diagnostics);
  child.disconnect();
  assert.deepEqual(await exited, { code: 0, signal: null });
});
