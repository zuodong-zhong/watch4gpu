/** @typedef {{ path: string, label: string, ok: boolean, checkedAt?: string, refreshFailed?: boolean, totalBytes?: number, usedBytes?: number, availableBytes?: number, usedPercent?: number, filesystem?: string, mountPoint?: string, error?: string }} DiskStatus */
/** @typedef {{ configured: boolean, sshHost: string, ok: boolean, attemptedAt: string, disks: DiskStatus[] }} StorageStatus */

/** Keep each disk's last successful reading and its original timestamp. */
/** @param {StorageStatus | undefined} previous @param {StorageStatus} incoming @returns {StorageStatus} */
export function mergeStorageStatus(previous, incoming) {
  if (!incoming.configured || previous?.sshHost !== incoming.sshHost) return incoming;
  return {
    ...incoming,
    disks: incoming.disks.map((disk) => {
      const old = previous.disks.find((item) => item.path === disk.path);
      return !disk.ok && old?.ok
        ? { ...old, label: disk.label, refreshFailed: true, error: disk.error }
        : disk;
    }),
  };
}

/** @param {number | undefined} bytes */
export function formatStorageBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "未知";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const index = bytes === 0 ? 0 : Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: index === 0 ? 0 : 2 }).format(bytes / 1024 ** index)} ${units[index]}`;
}

/** @param {DiskStatus} disk */
export function storageCapacityTone(disk) {
  if (!disk.ok || disk.availableBytes == null || !disk.totalBytes) return "unknown";
  const remaining = disk.availableBytes / disk.totalBytes;
  return remaining <= 0.05 ? "critical" : remaining <= 0.1 ? "warning" : "normal";
}
