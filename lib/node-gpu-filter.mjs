export const DEFAULT_MEMORY_THRESHOLD_PERCENT = 50;
export const MEMORY_THRESHOLD_OPTIONS = [25, 50, 75];

/** @param {number} value */
export function isValidMemoryThreshold(value) {
  return MEMORY_THRESHOLD_OPTIONS.includes(value);
}

/**
 * Count matching cards, independently of how many sibling cards are displayed.
 * @param {{ memoryUsed: number, memoryTotal: number }[]} gpus
 * @param {number} [memoryThresholdPercent]
 */
export function countLowMemoryGpus(gpus, memoryThresholdPercent = DEFAULT_MEMORY_THRESHOLD_PERCENT) {
  const threshold = isValidMemoryThreshold(memoryThresholdPercent) ? memoryThresholdPercent : DEFAULT_MEMORY_THRESHOLD_PERCENT;
  return gpus.filter((gpu) =>
    Number.isFinite(gpu.memoryUsed) && gpu.memoryUsed >= 0 &&
    Number.isFinite(gpu.memoryTotal) && gpu.memoryTotal > 0 &&
    gpu.memoryUsed / gpu.memoryTotal < threshold / 100).length;
}

/**
 * Memory filtering selects whole nodes; user filtering still determines which
 * nodes match, but never hides sibling GPUs while the memory filter is enabled.
 * @template {{ memoryUsed: number, memoryTotal: number }} Gpu
 * @param {Gpu[]} gpus
 * @param {{ lowMemoryOnly?: boolean, memoryThresholdPercent?: number, matchesUser?: (gpu: Gpu) => boolean }} [options]
 * @returns {Gpu[]}
 */
export function filterNodeGpus(gpus, { lowMemoryOnly = false, memoryThresholdPercent = DEFAULT_MEMORY_THRESHOLD_PERCENT, matchesUser } = {}) {
  const userGpus = matchesUser ? gpus.filter(matchesUser) : gpus;
  if (matchesUser && userGpus.length === 0) return [];
  if (!lowMemoryOnly) return userGpus;

  return countLowMemoryGpus(gpus, memoryThresholdPercent) > 0 ? gpus : [];
}
