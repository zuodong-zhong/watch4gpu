export const TASK_TIME_ZONE = "Asia/Shanghai";

const shanghaiFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TASK_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** @param {number} timestamp */
export function toShanghaiTimestamp(timestamp) {
  if (!Number.isFinite(timestamp)) return null;
  const parts = Object.fromEntries(shanghaiFormatter.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

/** @param {string | null | undefined} value */
export function formatShanghaiTime(value) {
  const timestamp = value ? Date.parse(value) : NaN;
  return toShanghaiTimestamp(timestamp)?.replace("T", " ").replace("+08:00", "") || "未知";
}

/** Parse ps etime: [[days-]hours:]minutes:seconds.
 * @param {string | null | undefined} value
 */
export function parseElapsedSeconds(value) {
  const match = value?.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!match || (match[1] && !match[2])) return null;
  const [, days, hours, minutes, seconds] = match;
  if (Number(minutes) >= 60 || Number(seconds) >= 60 || (days && Number(hours) >= 24)) return null;
  const total = Number(days || 0) * 86400 + Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Number.isSafeInteger(total) ? total : null;
}

/** @param {number | null} seconds */
export function formatTaskDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "未知";
  const whole = Math.floor(seconds);
  const days = Math.floor(whole / 86400);
  const hours = Math.floor(whole % 86400 / 3600);
  const minutes = Math.floor(whole % 3600 / 60);
  return `${days ? `${days} 天 ` : ""}${hours || days ? `${hours} 小时 ` : ""}${minutes || hours || days ? `${minutes} 分 ` : ""}${whole % 60} 秒`;
}

/** Parse fixed LC_ALL=C TZ=UTC ps output, independent of local/remote timezone.
 * @param {string} text
 */
export function parseProcessTimes(text) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const times = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(\d+)$/);
    if (!match) continue;
    const [, pid, month, day, hour, minute, second, year, elapsed] = match;
    const monthIndex = months.indexOf(month);
    if (monthIndex < 0 || Number(day) < 1 || Number(day) > 31 || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) continue;
    const timestamp = Date.UTC(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second));
    if (new Date(timestamp).getUTCMonth() !== monthIndex || !Number.isSafeInteger(Number(elapsed))) continue;
    times.set(Number(pid), { startedAt: toShanghaiTimestamp(timestamp), elapsedSeconds: Number(elapsed), timingSource: "process" });
  }
  return times;
}
