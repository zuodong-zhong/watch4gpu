import { mergeNodeStatus } from "./lib/node-status.mjs";

// A timeout change applies to the next collection; it must never create a
// second SSH process for a target that is already being collected.
function connectionKey(node) {
  return JSON.stringify(node.mode === "direct"
    ? [node.mode, node.sshHost, Number(node.port || 22)]
    : [node.mode, node.gatewayHost, node.loginScript, String(node.loginArg || node.gpuNodeId), node.relayTransport ?? "shell"]);
}

export function createNodeCollector(probe) {
  const pendingByNode = new Map();
  const lastSuccessByNode = new Map();
  async function collect(snapshot, key, timeoutMs) {
    if (lastSuccessByNode.get(snapshot.id)?.key !== key) lastSuccessByNode.delete(snapshot.id);
    const result = await probe(snapshot, timeoutMs);
    const previous = lastSuccessByNode.get(snapshot.id)?.status;
    if (result?.ok && !result.refreshFailed && (!result.partial || !previous || previous.partial)) {
      lastSuccessByNode.set(snapshot.id, { key, status: result });
    }
    return result?.ok === false ? mergeNodeStatus(previous, result) : result;
  }

  return function collectNode(node, timeoutMs = null) {
    const key = connectionKey(node);
    let queue = pendingByNode.get(node.id);
    const matching = queue?.find((entry) => entry.key === key);
    if (matching) return matching.promise;

    if (!queue) {
      queue = [];
      pendingByNode.set(node.id, queue);
    }
    const previous = queue.at(-1)?.promise;
    // Snapshot configuration so edits made while waiting cannot change the
    // target associated with this request's result.
    const snapshot = { ...node };
    const entry = { key, promise: null };
    entry.promise = Promise.resolve(previous)
      .catch(() => {})
      .then(() => collect(snapshot, key, timeoutMs))
      .finally(() => {
        queue.splice(queue.indexOf(entry), 1);
        if (queue.length === 0) pendingByNode.delete(snapshot.id);
      });
    queue.push(entry);
    return entry.promise;
  };
}
