/** @param {string | null | undefined} value */
export function normalizeAccount(value) {
  return value?.trim().replace(/^@/, "").toLowerCase() || "";
}

/** Expand accounts that share a configured display name, without partial matching.
 * @param {string} value
 * @param {Record<string, string>} names
 */
export function resolveMyAccounts(value, names) {
  const accounts = new Set(value.split(/[,，、\s]+/).map(normalizeAccount).filter(Boolean));
  const entries = Object.entries(names).map(([account, name]) => [normalizeAccount(account), name.trim().toLowerCase()]);
  const labels = new Set(entries.filter(([account, label]) => accounts.has(account) && label).map(([, label]) => label));
  for (const [account, label] of entries) {
    if (label && labels.has(label)) accounts.add(account);
  }
  return accounts;
}

/** @typedef {{ attributedUser: string | null, attributionSource: string | null, attributionEvidence?: { conflict: boolean } | null, pid?: number, name?: string, command?: string | null, elapsed?: string | null, startedAt?: string | null, elapsedSeconds?: number | null, timingSource?: "process" | "estimated" | "related" | null }} MyProcess */
/** @typedef {{ index: number, uuid: string, name: string, processes: MyProcess[] }} MyGpu */
/** @typedef {{ ok: boolean, checkedAt: string, refreshFailed?: boolean, partial?: boolean, gpus: MyGpu[] }} MyStatus */
/** @typedef {{ id: string, name: string, enabled: boolean }} MyNode */

/** Summarize only observed GPU processes; workloads and system accounts are not ownership proof.
 * @param {MyNode[]} nodes
 * @param {Record<string, MyStatus>} statuses
 * @param {ReadonlySet<string>} accounts
 * @param {number} now
 * @param {number} staleAfter
 */
export function summarizeMyGpus(nodes, statuses, accounts, now, staleAfter) {
  let unavailableNodes = 0;
  let unknownGpus = 0;
  const groups = [];
  for (const node of nodes.filter((node) => node.enabled)) {
    const status = statuses[node.id];
    const checkedAt = Date.parse(status?.checkedAt);
    const stale = !status?.ok || status.refreshFailed || status.partial || !Number.isFinite(checkedAt) || now - checkedAt > staleAfter;
    if (stale) unavailableNodes++;
    if (!status?.ok) continue;
    const cards = [];
    for (const gpu of status.gpus) {
      if (gpu.processes.some((process) => !normalizeAccount(process.attributedUser))) unknownGpus++;
      const matches = gpu.processes.filter((process) => accounts.has(normalizeAccount(process.attributedUser)));
      if (!matches.length) continue;
      const unconflicted = matches.filter((process) => !process.attributionEvidence?.conflict);
      cards.push({
        index: gpu.index, uuid: gpu.uuid, name: gpu.name,
        processCount: matches.length,
        uncertain: !unconflicted.length,
        inferred: unconflicted.length > 0 && unconflicted.every((process) => !["pid", "account"].includes(process.attributionSource || "")),
      });
    }
    if (cards.length) groups.push({ node, cards: cards.sort((a, b) => a.index - b.index), stale: Boolean(stale), checkedAt: status.checkedAt });
  }
  const currentCards = groups.filter((group) => !group.stale).flatMap((group) => group.cards);
  return {
    groups,
    matchedCount: currentCards.filter((card) => !card.uncertain).length,
    uncertainCount: currentCards.filter((card) => card.uncertain).length,
    unavailableNodes, unknownGpus,
  };
}
