import { isUnconflictedAccountProcess } from "./my-gpus.mjs";
import { isCurrentStatus } from "./node-status.mjs";

/** @typedef {import('./my-gpus.mjs').MyGpu & { utilization: number, memoryUsed: number, memoryTotal: number }} SortGpu */

/** Keep the dashboard's existing availability rule. @param {SortGpu} gpu */
export function isFreeGpu(gpu) {
  return gpu.utilization <= 5 && gpu.memoryUsed <= 1024 && gpu.processes.length === 0;
}

/** Capacity-weighted occupancy; incomplete readings must not look like empty memory.
 * @param {{ memoryUsed: number, memoryTotal: number }[]} gpus
 */
export function memoryOccupancy(gpus) {
  if (!gpus.length || gpus.some((gpu) =>
    !Number.isFinite(gpu.memoryUsed) || gpu.memoryUsed < 0 ||
    !Number.isFinite(gpu.memoryTotal) || gpu.memoryTotal <= 0)) return Infinity;
  const used = gpus.reduce((total, gpu) => total + gpu.memoryUsed, 0);
  const capacity = gpus.reduce((total, gpu) => total + gpu.memoryTotal, 0);
  return Number.isFinite(used) && Number.isFinite(capacity) ? used / capacity : Infinity;
}

/** Build priorities from the GPUs actually shown after filtering.
 * @param {SortGpu[]} gpus
 * @param {{ enabled: boolean, status: import('./my-gpus.mjs').MyStatus | undefined, accounts: ReadonlySet<string>, now: number, staleAfter: number }} options
 */
export function nodeSortMetrics(gpus, { enabled, status, accounts, now, staleAfter }) {
  const hasCurrentData = enabled && isCurrentStatus(status, now, staleAfter) && gpus.length > 0;
  return {
    hasCurrentData,
    freeGpuCount: hasCurrentData ? gpus.filter(isFreeGpu).length : 0,
    hasMyGpu: hasCurrentData && gpus.some((gpu) => gpu.processes.some((process) => isUnconflictedAccountProcess(process, accounts))),
    memoryOccupancy: hasCurrentData ? memoryOccupancy(gpus) : Infinity,
  };
}

/** Current resources first, then free-card count, personal ownership, and occupancy.
 * Configuration order is the final stable tie-breaker, including unknown readings.
 * @param {ReturnType<typeof nodeSortMetrics> & { originalIndex: number }} a
 * @param {ReturnType<typeof nodeSortMetrics> & { originalIndex: number }} b
 */
export function compareNodeResources(a, b) {
  return Number(b.hasCurrentData) - Number(a.hasCurrentData)
    || b.freeGpuCount - a.freeGpuCount
    || Number(b.hasMyGpu) - Number(a.hasMyGpu)
    || (a.memoryOccupancy === b.memoryOccupancy ? 0 : a.memoryOccupancy - b.memoryOccupancy)
    || a.originalIndex - b.originalIndex;
}
