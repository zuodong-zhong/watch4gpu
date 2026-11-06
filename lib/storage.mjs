import { readFile } from "node:fs/promises";
import { sshOptions } from "./ssh-options.mjs";
import { mergeStorageStatus } from "./storage-status.mjs";

const configFile = process.env.WATCH4GPU_STORAGE_CONFIG_FILE || new URL("../data/storage.local.json", import.meta.url);
const defaultTimeoutMs = 90_000;
const diskTimeoutSeconds = 8;

export function validateStorageConfig(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.disks)) throw new Error("存储配置的 disks 必须是数组");
  if (!value.sshHost && value.disks.length === 0) return { sshHost: "", disks: [] };
  if (typeof value.sshHost !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.sshHost)) throw new Error("存储配置的 SSH Host 别名无效");
  if (!value.disks.length || value.disks.length > 16) throw new Error("请配置 1–16 个磁盘挂载点");
  const seen = new Set();
  const disks = value.disks.map((disk) => {
    if (typeof disk?.path !== "string" || !/^\/[A-Za-z0-9_./-]*$/.test(disk.path) || disk.path.length > 256 || disk.path.split("/").some((part) => part === "." || part === "..")) {
      throw new Error("磁盘路径须为绝对挂载路径，仅支持字母、数字、下划线、点、横线和斜线");
    }
    const path = disk.path.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    if (seen.has(path)) throw new Error(`磁盘路径重复：${path}`);
    seen.add(path);
    if (disk.label != null && (typeof disk.label !== "string" || disk.label.length > 80)) throw new Error("磁盘名称最多 80 个字符");
    return { path, label: disk.label?.trim() || path };
  });
  return { sshHost: value.sshHost, disks };
}

export async function readStorageConfig() {
  try {
    return validateStorageConfig(JSON.parse(await readFile(configFile, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return { sshHost: "", disks: [] };
    throw error;
  }
}

// Only fixed, read-only df queries. Values come from validated local config,
// never URL parameters; no directory traversal or remote files are written.
export function buildStorageProbe(config) {
  const { disks } = validateStorageConfig(config);
  return disks.map(({ path }, index) => [
    `printf '%s\\n' '__WATCH4GPU_DISK_${index}__'`,
    `LC_ALL=C timeout ${diskTimeoutSeconds}s df -P -B1 -T -- '${path}' 2>&1`,
    `storage_probe_status=$?`,
    `printf '\\n__WATCH4GPU_DISK_END_${index}__:%s\\n' "$storage_probe_status"`,
  ].join("; ")).concat("printf '%s\\n' '__WATCH4GPU_DONE__'").join("; ");
}

export function parseStorageProbe(output, config, checkedAt, connectionError = "未收到完整的磁盘采集结果") {
  return config.disks.map((disk, index) => {
    const failed = (error) => ({ ...disk, ok: false, error });
    const section = output.match(new RegExp(`(?:^|\\n)__WATCH4GPU_DISK_${index}__\\r?\\n([\\s\\S]*?)\\r?\\n__WATCH4GPU_DISK_END_${index}__:(\\d+)(?:\\r?\\n|$)`));
    if (!section) return failed(connectionError);
    const [, body, code] = section;
    if (code !== "0") return failed(code === "124" ? `读取超时（${diskTimeoutSeconds} 秒）` : body.trim().slice(-600) || `磁盘读取失败（退出码 ${code}）`);
    const row = body.split(/\r?\n/).map((line) => line.trim().match(/^(.+?)\s+(\S+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)%\s+(\/.*)$/)).find(Boolean);
    if (!row) return failed("无法解析磁盘容量，请确认服务器支持 GNU df");
    const [, , filesystem, total, used, available, percent, mountPoint] = row;
    if (mountPoint !== disk.path) return failed(`未在 ${disk.path} 检测到独立挂载（当前落在 ${mountPoint}），请检查挂载状态`);
    const [totalBytes, usedBytes, rawAvailable, usedPercent] = [total, used, available, percent].map(Number);
    if (![totalBytes, usedBytes, rawAvailable, usedPercent].every(Number.isSafeInteger) || totalBytes <= 0) return failed("磁盘容量读数无效");
    return { ...disk, ok: true, checkedAt, totalBytes, usedBytes, availableBytes: Math.max(0, rawAvailable), usedPercent, filesystem, mountPoint };
  });
}

export function createStorageCollector(run) {
  const queue = [];
  let previous;
  let previousKey;
  return function collectStorage(rawConfig, requestedTimeoutMs = null) {
    const config = validateStorageConfig(rawConfig);
    const key = JSON.stringify(config);
    const pending = queue.find((entry) => entry.key === key);
    if (pending) return pending.promise;
    const entry = { key, promise: null };
    const preceding = queue.at(-1)?.promise;
    entry.promise = Promise.resolve(preceding).catch(() => {}).then(async () => {
      if (previousKey !== key) previous = undefined;
      previousKey = key;
      let output = "";
      let error;
      if (config.sshHost) {
        const timeoutMs = requestedTimeoutMs ?? defaultTimeoutMs;
        try {
          // Honor all connection settings, including Port and ProxyJump, in ~/.ssh/config.
          output = await run("ssh", [...sshOptions(timeoutMs), config.sshHost, buildStorageProbe(config)], undefined, timeoutMs);
        } catch (failure) {
          output = failure?.probeOutput || "";
          error = failure instanceof Error ? failure.message : String(failure);
        }
      }
      const attemptedAt = new Date().toISOString();
      const disks = parseStorageProbe(output, config, attemptedAt, error);
      const incoming = { configured: Boolean(config.sshHost), sshHost: config.sshHost, ok: disks.every((disk) => disk.ok), attemptedAt, disks };
      previous = mergeStorageStatus(previous, incoming);
      return previous;
    }).finally(() => { queue.splice(queue.indexOf(entry), 1); });
    queue.push(entry);
    return entry.promise;
  };
}
