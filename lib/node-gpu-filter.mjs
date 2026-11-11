export const DEFAULT_MEMORY_THRESHOLD_PERCENT = 50;
export const MEMORY_THRESHOLD_OPTIONS = [25, 50, 75];

/** Group A-series variants while retaining other models' full names. @param {string} [name] */
export function getGpuType(name = "") {
  const model = name.trim().replace(/^NVIDIA\s+/i, "").replace(/\s+/g, " ");
  return model.match(/^(?:RTX\s+)?(A\d{3,4})\b/i)?.[1].toUpperCase() || model;
}

/** @param {{ name: string }[]} gpus */
export function buildGpuTypeOptions(gpus) {
  const counts = new Map();
  for (const gpu of gpus) {
    const type = getGpuType(gpu.name);
    if (type) counts.set(type, (counts.get(type) || 0) + 1);
  }
  return [...counts].map(([type, gpuCount]) => ({ type, gpuCount }))
    .sort((a, b) => a.type.localeCompare(b.type, "en", { numeric: true }));
}

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
 * Type filtering scopes both matching and display. Memory filtering retains all
 * sibling GPUs of that type; user filtering still determines which nodes match.
 * @template {{ name?: string, memoryUsed: number, memoryTotal: number }} Gpu
 * @param {Gpu[]} gpus
 * @param {{ gpuType?: string, lowMemoryOnly?: boolean, memoryThresholdPercent?: number, matchesUser?: (gpu: Gpu) => boolean }} [options]
 * @returns {Gpu[]}
 */
export function filterNodeGpus(gpus, { gpuType = "", lowMemoryOnly = false, memoryThresholdPercent = DEFAULT_MEMORY_THRESHOLD_PERCENT, matchesUser } = {}) {
  const typedGpus = gpuType ? gpus.filter((gpu) => getGpuType(gpu.name) === gpuType) : gpus;
  const userGpus = matchesUser ? typedGpus.filter(matchesUser) : typedGpus;
  if (matchesUser && userGpus.length === 0) return [];
  if (!lowMemoryOnly) return userGpus;

  return countLowMemoryGpus(typedGpus, memoryThresholdPercent) > 0 ? typedGpus : [];
}
