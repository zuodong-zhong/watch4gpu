import { normalizeAccount } from "./my-gpus.mjs";
import { parseElapsedSeconds, toShanghaiTimestamp } from "./task-time.mjs";
import { describeTaskCommand } from "./task-description.mjs";

/** @typedef {import('./my-gpus.mjs').MyProcess} MyProcess */
/** @param {MyProcess} process @param {string} checkedAt */
function processTiming(process, checkedAt) {
  const seconds = process.elapsedSeconds ?? parseElapsedSeconds(process.elapsed);
  const elapsedSeconds = seconds != null && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  const source = process.timingSource || (["pid", "account", "nspid"].includes(process.attributionSource || "") ? "estimated" : "related");
  const suppliedStart = process.startedAt ? Date.parse(process.startedAt) : NaN;
  const startedAt = toShanghaiTimestamp(Number.isFinite(suppliedStart) ? suppliedStart : elapsedSeconds == null ? NaN : Date.parse(checkedAt) - elapsedSeconds * 1000);
  return { startedAt, elapsedSeconds, source: elapsedSeconds == null && !startedAt ? null : source };
}

/** List one task per node + GPU PID. Do not merge independent jobs by command or shell group.
 * @param {import('./my-gpus.mjs').MyNode[]} nodes
 * @param {Record<string, import('./my-gpus.mjs').MyStatus>} statuses
 * @param {ReadonlySet<string>} accounts
 * @param {number} now
 * @param {number} staleAfter
 */
export function summarizeMyTasks(nodes, statuses, accounts, now, staleAfter) {
  return nodes.filter((node) => node.enabled).flatMap((node) => {
    const status = statuses[node.id];
    if (!status?.ok) return [];
    const checkedAtMs = Date.parse(status.checkedAt);
    const stale = Boolean(status.refreshFailed || status.partial || !Number.isFinite(checkedAtMs) || now - checkedAtMs > staleAfter);
    /** @type {Map<number, { pid: number, command: string, accounts: Set<string>, gpuIndices: Set<number>, uncertain: boolean, inferred: boolean, timing: ReturnType<typeof processTiming> }>} */
    const tasks = new Map();
    for (const gpu of status.gpus) {
      for (const process of gpu.processes) {
        const account = normalizeAccount(process.attributedUser);
        if (!accounts.has(account) || !Number.isSafeInteger(process.pid) || !(process.pid > 0)) continue;
        const timing = processTiming(process, status.checkedAt);
        const task = tasks.get(process.pid) || {
          pid: process.pid,
          command: process.command || process.name || "任务命令不可见",
          accounts: new Set(), gpuIndices: new Set(), uncertain: false, inferred: false, timing,
        };
        task.accounts.add(account);
        task.gpuIndices.add(gpu.index);
        task.uncertain ||= Boolean(process.attributionEvidence?.conflict);
        task.inferred ||= !["pid", "account"].includes(process.attributionSource || "");
        // A directly observed timestamp wins if another GPU has only inferred metadata.
        if (!task.timing.startedAt || timing.source === "process") task.timing = timing;
        tasks.set(process.pid, task);
      }
    }
    if (!tasks.size) return [];
    return [{ node, stale, checkedAt: status.checkedAt, tasks: [...tasks.values()].map((task) => ({
      ...task,
      description: describeTaskCommand(task.command),
      accounts: [...task.accounts],
      gpuIndices: [...task.gpuIndices].sort((a, b) => a - b),
      // Failed/stale snapshots must never look like verified, still-running jobs.
      durationSeconds: task.timing.elapsedSeconds == null ? null : task.timing.elapsedSeconds + (stale ? 0 : Math.max(0, Math.floor((now - checkedAtMs) / 1000))),
    })).sort((a, b) => (Date.parse(a.timing.startedAt || "") || Infinity) - (Date.parse(b.timing.startedAt || "") || Infinity) || a.pid - b.pid) }];
  });
}

/** Combine identical descriptions for the node overview, preserving GPU coverage.
 * This groups descriptions, not jobs: independent PIDs stay separate in the task list.
 * @param {ReturnType<typeof summarizeMyTasks>[number]['tasks']} tasks
 */
export function summarizeNodeTaskDescriptions(tasks) {
  /** @type {Map<string, { key: string, description: NonNullable<typeof tasks[number]['description']>, gpuIndices: Set<number>, processCount: number, uncertainCount: number, earliestStartedAt: string | null, longestDurationSeconds: number | null, estimatedTiming: boolean, missingTimingCount: number }>} */
  const summaries = new Map();
  for (const task of tasks) {
    if (!task.description) continue;
    const key = JSON.stringify(task.description);
    const summary = summaries.get(key) || { key, description: task.description, gpuIndices: new Set(), processCount: 0, uncertainCount: 0, earliestStartedAt: null, longestDurationSeconds: null, estimatedTiming: false, missingTimingCount: 0 };
    for (const index of task.gpuIndices) summary.gpuIndices.add(index);
    summary.processCount++;
    if (task.uncertain) summary.uncertainCount++;
    const start = task.timing?.startedAt;
    if (start && Number.isFinite(Date.parse(start)) && (!summary.earliestStartedAt || Date.parse(start) < Date.parse(summary.earliestStartedAt))) summary.earliestStartedAt = start;
    if (task.durationSeconds != null && Number.isFinite(task.durationSeconds) && task.durationSeconds >= 0) summary.longestDurationSeconds = Math.max(summary.longestDurationSeconds ?? 0, task.durationSeconds);
    if (task.timing?.source && task.timing.source !== "process") summary.estimatedTiming = true;
    if (!start || task.durationSeconds == null) summary.missingTimingCount++;
    summaries.set(key, summary);
  }
  return [...summaries.values()].map((summary) => ({ ...summary, gpuIndices: [...summary.gpuIndices].sort((a, b) => a - b) }));
}
