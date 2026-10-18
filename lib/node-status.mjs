/**
 * Keep the last successful snapshot when a refresh fails, without changing its
 * timestamp or making it count as current data.
 * @template {{ nodeId: string, ok: boolean, checkedAt: string, refreshFailed?: boolean, error?: string }} Status
 * @param {Status | undefined} previous
 * @param {Status} incoming
 * @returns {Status}
 */
export function mergeNodeStatus(previous, incoming) {
  if (!incoming.ok && previous?.ok && previous.nodeId === incoming.nodeId) {
    return { ...previous, refreshFailed: true, error: incoming.error };
  }
  return incoming;
}

/**
 * @param {{ ok: boolean, checkedAt: string, refreshFailed?: boolean, partial?: boolean } | undefined} status
 * @param {number} now
 * @param {number} staleAfter
 */
export function isCurrentStatus(status, now, staleAfter) {
  const checkedAt = Date.parse(status?.checkedAt ?? "");
  return Boolean(status?.ok && !status.refreshFailed && !status.partial && Number.isFinite(checkedAt) && now - checkedAt <= staleAfter);
}
