import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_FILE = join(ROOT, "data", "nodes.json");
const CONFIG_FILE = process.env.WATCH4GPU_CONFIG_FILE || join(ROOT, "data", "nodes.local.json");
const HOST = "127.0.0.1";
const PORT = Number(process.env.WATCH4GPU_API_PORT || 8787);
const SSH_TIMEOUT_MS = Number(process.env.WATCH4GPU_SSH_TIMEOUT_MS || 25000);
const RELAY_TIMEOUT_MS = Number(process.env.WATCH4GPU_RELAY_TIMEOUT_MS || 45000);
const CONTAINER_PROCESS_INSPECTION = !/^(?:0|false|off)$/i.test(process.env.WATCH4GPU_CONTAINER_PROCESS_INSPECTION || "1");
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 120;
const configuredOrigins = new Set(
  (process.env.WATCH4GPU_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const configuredUserPathPrefixes = (process.env.WATCH4GPU_USER_PATH_PREFIXES || "")
  .split(",")
  .map((prefix) => prefix.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const idPattern = /^[A-Za-z0-9._-]+$/;
const nodeNumberPattern = /^\d+$/;
const safeRemotePath = /^[A-Za-z0-9_./~+-]+$/;
const localDeepInspectionUsers = (() => {
  try {
    const value = JSON.parse(readFileSync(join(ROOT, "data", "deep-inspection-users.local.json"), "utf8"));
    const users = Array.isArray(value) ? value : value?.users;
    return Array.isArray(users) ? users : [];
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`忽略无效的本地深度搜索账户配置：${error.message}`);
    return [];
  }
})();
const configuredDeepInspectionUsers = [
  "root",
  ...localDeepInspectionUsers,
  ...(process.env.WATCH4GPU_DEEP_INSPECTION_USERS || "").split(","),
]
  .filter((user) => typeof user === "string")
  .map((user) => user.trim().toLowerCase())
  .filter((user, index, users) => idPattern.test(user) && users.indexOf(user) === index);

const gpuQuery = "nvidia-smi --query-gpu=index,name,uuid,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit --format=csv,noheader,nounits";
const processQuery = "nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || true";
const ownerQuery = "nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits 2>/dev/null | while IFS= read -r pid; do ps -ww -p \"$pid\" -o user= -o pid= -o etime= -o args= 2>/dev/null; done";
const workloadProcessPattern = "[t]orchrun|[d]eepspeed|[a]ccelerate|[p]ython|[s]wift|[vV][lL][lL][mM]";
const workloadQuery = [
  "ps -ww -e -o user= -o pid= -o ppid= -o pgid= -o sid= -o etime= -o args=",
  `| grep -E '${workloadProcessPattern}'`,
  "| grep -Ev 'client_start\\.py|server_start\\.py|fake_cmd|/nvitop|/gpustat|torch/_inductor/compile_worker'",
  "| while read -r user pid ppid pgid sid elapsed cmd; do",
  "nspids=$(awk '/^NSpid:/{for(i=2;i<=NF;i++) printf \"%s%s\", (i==2?\"\":\",\"), $i}' /proc/\"$pid\"/status 2>/dev/null);",
  "cwd=$(readlink /proc/\"$pid\"/cwd 2>/dev/null || true);",
  "IFS=$'\\t' read -r cuda local_rank rank world_size < <(tr '\\0' '\\n' < /proc/\"$pid\"/environ 2>/dev/null | awk -F= 'BEGIN{cuda=\"-\";local=\"-\";rank=\"-\";world=\"-\"} $1==\"CUDA_VISIBLE_DEVICES\"{cuda=substr($0,index($0,\"=\")+1)} $1==\"LOCAL_RANK\"{local=substr($0,index($0,\"=\")+1)} $1==\"RANK\"{rank=substr($0,index($0,\"=\")+1)} $1==\"WORLD_SIZE\"{world=substr($0,index($0,\"=\")+1)} END{printf \"%s\\t%s\\t%s\\t%s\",cuda,local,rank,world}');",
  "cmd=${cmd:0:700};",
  "printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$user\" \"$pid\" \"$ppid\" \"$pgid\" \"$sid\" \"$elapsed\" \"$nspids\" \"$cwd\" \"$cuda\" \"$local_rank\" \"$rank\" \"$world_size\" \"$cmd\";",
  "done",
  "| awk -F '\\t' '{key=$1 SUBSEP $9 SUBSEP $10 SUBSEP $11 SUBSEP $12 SUBSEP $13; gsub(/--(local_rank|node_rank|parent|read-fd|write-fd)(=| )[0-9]+/, \"--dynamic=*\", key); if (!seen[key]++) print}'",
  "| head -n 64",
].join(" ");
const namespaceQuery = [
  "ps -ww -e -o user= -o pid= -o ppid= -o pgid= -o sid= -o etime= -o args=",
  `| grep -E '${workloadProcessPattern}'`,
  "| grep -Ev 'client_start\\.py|server_start\\.py|fake_cmd|/nvitop|/gpustat|torch/_inductor/compile_worker'",
  "| while read -r user pid ppid pgid sid elapsed cmd; do",
  "nspids=$(awk '/^NSpid:/{for(i=2;i<=NF;i++) printf \"%s%s\", (i==2?\"\":\",\"), $i}' /proc/\"$pid\"/status 2>/dev/null);",
  "cwd=$(readlink /proc/\"$pid\"/cwd 2>/dev/null || true);",
  "case \"$nspids\" in *,*) cmd=${cmd:0:700}; printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$user\" \"$pid\" \"$ppid\" \"$pgid\" \"$sid\" \"$elapsed\" \"$nspids\" \"$cwd\" \"$cmd\";; esac;",
  "done | head -n 256",
].join(" ");
const deviceProcessMarker = "__WATCH4GPU_DEVICE_PROCESSES__";
const containerCwdMarker = "__WATCH4GPU_CONTAINER_CWDS__";
function buildContainerCwdQuery(users) {
  const safeUsers = users.map((user) => user.trim().toLowerCase()).filter((user, index, values) => idPattern.test(user) && values.indexOf(user) === index);
  const accountPattern = safeUsers.map((user) => user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "root";
  return [
  "if command -v docker >/dev/null 2>&1; then",
  "deep_inspection_needed=$(for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits 2>/dev/null); do",
  "printf '%s' \"$pid\" | grep -Eq '^[0-9]+$' || continue;",
  "process_line=$(ps -ww -p \"$pid\" -o user= -o args= 2>/dev/null);",
  "process_user=$(printf '%s' \"$process_line\" | awk '{print $1}');",
  `if printf '%s' "$process_user" | grep -Eq '^(${accountPattern})$'; then printf '1'; break; fi;`,
  `if printf '%s' "$process_line" | grep -Eq '/(public|9950backfile|home|Users)/(${accountPattern})/'; then printf '1'; break; fi;`,
  "done);",
  "if test \"$deep_inspection_needed\" = 1; then",
  "docker ps -q --no-trunc 2>/dev/null | grep -E '^[0-9a-f]{12,64}$' | head -n 32 | while IFS= read -r container_id; do",
  `docker exec -u 0 "$container_id" sh -c 'container_id=$1; ps -ww -e -o pid= -o args= 2>/dev/null | grep -E "${workloadProcessPattern}" | grep -Ev "client_start\\.py|server_start\\.py|fake_cmd|/nvitop|/gpustat|torch/_inductor/compile_worker" | head -n 128 | while read -r pid cmd; do printf "%s" "$pid" | grep -Eq "^[0-9]+$" || continue; cwd=$(readlink /proc/"$pid"/cwd 2>/dev/null || true); test -n "$cwd" || continue; cmd=$(printf "%s" "$cmd" | cut -c1-700); printf "%s\\\\t%s\\\\t%s\\\\t%s\\\\n" "$container_id" "$pid" "$cwd" "$cmd"; done' sh "$container_id" 2>/dev/null || true;`,
  "done;",
  "fi;",
  "fi",
  ].join(" ");
}
const containerCwdQuery = buildContainerCwdQuery(configuredDeepInspectionUsers);
const deviceQuery = [
  "unique_pids=' ';",
  "for device in /dev/nvidia[0-9]*; do test -e \"$device\" || continue; gpu_index=${device#/dev/nvidia}; pids=; method=;",
  "if command -v fuser >/dev/null 2>&1; then pids=$(fuser \"$device\" 2>/dev/null); method=fuser; fi;",
  "if test -z \"$pids\" && command -v lsof >/dev/null 2>&1; then pids=$(lsof -t \"$device\" 2>/dev/null | sort -u); method=lsof; fi;",
  "for pid in $pids; do case \"$pid\" in ''|*[!0-9]*) continue;; esac;",
  "printf '%s\\t%s\\t%s\\n' \"$gpu_index\" \"$pid\" \"$method\";",
  "case \"$unique_pids\" in *\" $pid \"*) ;; *) unique_pids=\"${unique_pids}${pid} \";; esac;",
  "done; done;",
  `printf '%s\\n' '${deviceProcessMarker}';`,
  "for pid in $unique_pids; do",
  "nspids=$(awk '/^NSpid:/{for(i=2;i<=NF;i++) printf \"%s%s\", (i==2?\"\":\",\"), $i}' /proc/\"$pid\"/status 2>/dev/null);",
  "cwd=$(readlink /proc/\"$pid\"/cwd 2>/dev/null || true);",
  "ps -ww -p \"$pid\" -o user= -o ppid= -o pgid= -o sid= -o etime= -o args= 2>/dev/null",
  "| awk -v pid=\"$pid\" -v nspids=\"$nspids\" -v cwd=\"$cwd\" '{user=$1; ppid=$2; pgid=$3; sid=$4; elapsed=$5; for(i=1;i<=5;i++) sub(/^[[:space:]]*[^[:space:]]+[[:space:]]*/, \"\"); cmd=substr($0,1,700); printf \"%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\", pid, user, ppid, pgid, sid, elapsed, nspids, cwd, cmd}';",
  "done",
].join(" ");
const remoteProbePrefix = `printf '__WATCH4GPU_HOST__\\n'; hostname; printf '__WATCH4GPU_GPUS__\\n'; ${gpuQuery}; printf '__WATCH4GPU_PROCESSES__\\n'; ${processQuery}; printf '__WATCH4GPU_OWNERS__\\n'; ${ownerQuery}; printf '__WATCH4GPU_WORKLOADS__\\n'; ${workloadQuery}; printf '__WATCH4GPU_NAMESPACES__\\n'; ${namespaceQuery}; printf '__WATCH4GPU_DEVICES__\\n'; ${deviceQuery}; printf '${containerCwdMarker}\\n'`;
const remoteProbe = `${remoteProbePrefix}; ${CONTAINER_PROCESS_INSPECTION ? containerCwdQuery : ":"}; printf '__WATCH4GPU_DONE__\\n'`;
const relayRemoteProbe = `${remoteProbePrefix}; :; printf '__WATCH4GPU_DONE__\\n'`;

function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function isAllowedOrigin(origin) {
  if (configuredOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return JSON.parse(await readFile(DEFAULT_CONFIG_FILE, "utf8"));
  }
}

function validateNodes(value) {
  if (!value || !Array.isArray(value.nodes)) throw new Error("nodes 必须是数组");
  if (value.nodes.length > 100) throw new Error("节点数量不能超过 100");
  const seen = new Set();
  return value.nodes.map((raw) => {
    const node = { ...raw };
    if (!idPattern.test(node.id || "")) throw new Error(`无效的配置 ID：${node.id || "（空）"}`);
    if (seen.has(node.id)) throw new Error(`配置 ID 重复：${node.id}`);
    seen.add(node.id);
    if (typeof node.name !== "string" || !node.name.trim()) throw new Error(`${node.id} 缺少显示名称`);
    if (!['direct', 'relay'].includes(node.mode)) throw new Error(`${node.id} 的连接方式无效`);
    if (node.mode === "direct" && !idPattern.test(node.sshHost || "")) throw new Error(`${node.id} 的 SSH Host 别名无效`);
    if (node.mode === "relay") {
      if (!idPattern.test(node.gatewayHost || "")) throw new Error(`${node.id} 的网关 Host 无效`);
      if (!nodeNumberPattern.test(node.gpuNodeId || "")) throw new Error(`${node.id} 的 GPU 节点编号必须为数字`);
      if (!safeRemotePath.test(node.loginScript || "")) throw new Error(`${node.id} 的登录脚本路径无效`);
    }
    node.name = node.name.trim().slice(0, 80);
    node.enabled = node.enabled !== false;
    node.port = Math.min(65535, Math.max(1, Number(node.port || 22)));
    return node;
  });
}

function parseTimeoutMs(value) {
  if (value == null) return null;
  if (!/^\d+$/.test(value)) throw new Error("超时时间必须为整数秒");
  const seconds = Number(value);
  if (seconds < MIN_TIMEOUT_SECONDS || seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`超时时间必须在 ${MIN_TIMEOUT_SECONDS}–${MAX_TIMEOUT_SECONDS} 秒之间`);
  }
  return seconds * 1000;
}

function run(command, args, input, timeoutMs = SSH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      settled = true;
      reject(new Error(`连接超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && stdout.includes("__WATCH4GPU_DONE__")) resolve(stdout);
      else {
        const details = `${stdout}\n${stderr}`.trim() || `SSH 退出码 ${code}`;
        reject(new Error(details.slice(-1800)));
      }
    });
    if (input) child.stdin.end(input);
  });
}

function stripTerminalCodes(value) {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function runRelay(node, timeoutMs = RELAY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const args = ["-tt", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", node.gatewayHost, `bash ${node.loginScript} ${node.gpuNodeId}`];
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let sentProbe = false;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`中转连接超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const clean = stripTerminalCodes(stdout);
      if (!sentProbe && /conda activate[^\n]*\n[^\n]*root@[^#]*#/.test(clean)) {
        sentProbe = true;
        child.stdin.write(`${relayRemoteProbe}\r`);
      }
      if ((stdout.match(/__WATCH4GPU_DONE__/g) || []).length >= 2) finish(null, stripTerminalCodes(stdout));
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      const details = stripTerminalCodes(`${stdout}\n${stderr}`).trim() || `SSH 退出码 ${code}`;
      finish(new Error(details.slice(-1800)));
    });
  });
}

function csv(line) {
  return line.split(",").map((part) => part.trim());
}

function number(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const ignoredPathUsers = new Set([
  ".venv", ".vscode-server", "9950backfile", "bin", "conda", "data", "datasets", "env", "envs", "home", "mnt", "opt", "public",
  "root", "share", "shared", "software", "softwares", "tmp", "users", "usr", "var", "venv", "work", "workspace",
]);
const configOptions = new Set(["--cfg", "--config", "--config-file", "--config_path", "--config-path"]);
const outputOptions = new Set([
  "--checkpoint-dir", "--checkpoint_dir", "--log-dir", "--log_dir", "--logging-dir", "--logging_dir", "--output",
  "--output-dir", "--output-path", "--output_dir", "--output_path", "--results-dir", "--results_dir", "--save-dir",
  "--save_dir", "--work-dir", "--work_dir",
]);
const dataOptions = new Set([
  "--data", "--data-dir", "--data-path", "--data-root", "--data_dir", "--data_path", "--data_root",
  "--dataset", "--dataset-dir", "--dataset-path", "--dataset_dir", "--dataset_path", "--train-data", "--val-data",
]);

function cleanPathCandidate(value) {
  return value?.replace(/^['"]|['",;]$/g, "").replace(/[^A-Za-z0-9._-].*$/, "") || null;
}

function usablePathUser(value) {
  const candidate = cleanPathCandidate(value);
  return candidate && !ignoredPathUsers.has(candidate.toLowerCase()) ? candidate : null;
}

function inferUserFromPath(value) {
  if (!value || value === "-" || value === "[Not Found]") return null;
  const cleanValue = value.replace(/^['"]|['"]$/g, "");
  for (const prefix of configuredUserPathPrefixes) {
    const marker = `${prefix}/`;
    const start = cleanValue.indexOf(marker);
    if (start < 0) continue;
    const candidate = usablePathUser(cleanValue.slice(start + marker.length).split(/[\/\s]/, 1)[0]);
    if (candidate) return candidate;
  }
  const patterns = [
    /\/9950backfile\/([^/\s]+)/i,
    /\/public\/([^/\s]+)/i,
    /\/(?:home|Users)\/([^/\s]+)/,
    /\/(?:data|mnt)\/(?:home|users?)\/([^/\s]+)/i,
  ];
  for (const pattern of patterns) {
    const candidate = usablePathUser(cleanValue.match(pattern)?.[1]);
    if (candidate) return candidate;
  }
  const genericMount = cleanValue.match(/^\/+([^/\s]+)\/([^/\s]+)/);
  if (genericMount) return usablePathUser(genericMount[2]);
  return null;
}

function commandTokens(command) {
  return String(command || "").match(/(?:[^\s'"\\]+|"(?:\\.|[^"])*"|'[^']*')+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) || [];
}

function addTaskEvidence(evidence, source, value) {
  const user = inferUserFromPath(value);
  if (user) evidence.push({ source, user });
}

function chooseTaskUser(taskEvidence) {
  if (!taskEvidence.length) return null;
  const scores = new Map();
  const weights = { output: 4, config: 4, script: 3, cwd: 3, parent: 2 };
  for (const item of taskEvidence) scores.set(item.user, (scores.get(item.user) || 0) + (weights[item.source] || 1));
  return [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
}

function buildAttribution({ systemAccount = null, processName = null, command = null, cwd = null, inheritedTaskUser = null }) {
  const tokens = commandTokens(command);
  const environmentUser = inferUserFromPath(processName) || inferUserFromPath(tokens[0]);
  const taskEvidence = [];
  addTaskEvidence(taskEvidence, "cwd", cwd);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const separator = token.indexOf("=");
    const option = (separator >= 0 ? token.slice(0, separator) : token).toLowerCase();
    const inlineValue = separator >= 0 ? token.slice(separator + 1) : null;
    if (dataOptions.has(option)) {
      if (inlineValue == null) index += 1;
      continue;
    }
    if (configOptions.has(option) || outputOptions.has(option)) {
      const value = inlineValue == null ? tokens[index + 1] : inlineValue;
      addTaskEvidence(taskEvidence, configOptions.has(option) ? "config" : "output", value);
      if (inlineValue == null) index += 1;
      continue;
    }
    if (!token.startsWith("-") && /\.(?:py|sh)$/i.test(token)) addTaskEvidence(taskEvidence, "script", token);
  }
  if (inheritedTaskUser) taskEvidence.push({ source: "parent", user: inheritedTaskUser });
  const taskUser = chooseTaskUser(taskEvidence);
  const accountUser = systemAccount && systemAccount !== "root" ? systemAccount : null;
  const attributedUser = taskUser || accountUser || environmentUser || systemAccount || null;
  const candidates = new Set([taskUser, accountUser, environmentUser].filter(Boolean));
  return {
    attributedUser,
    attributionSource: taskUser ? (inheritedTaskUser && taskEvidence.every((item) => item.source === "parent") ? "parent" : "path") : accountUser ? "account" : environmentUser ? "path" : systemAccount ? "account" : null,
    attributionEvidence: {
      systemAccount,
      environmentUser,
      taskUser,
      taskSources: [...new Set(taskEvidence.filter((item) => item.user === taskUser).map((item) => item.source))],
      conflict: candidates.size > 1,
    },
  };
}

function integerOrNull(value) {
  return /^\d+$/.test(String(value || "")) ? Number(value) : null;
}

function parseNamespacePids(value) {
  if (!value) return [];
  return String(value).split(",").map(integerOrNull).filter((pid) => pid != null && pid > 0);
}

function parseVisibleDevices(value) {
  if (!/^\d+(?:,\d+)*$/.test(String(value || ""))) return [];
  return String(value).split(",").map(Number);
}

function addCandidate(map, key, value) {
  if (key == null) return;
  const current = map.get(key) || [];
  if (!current.some((item) => item.pid === value.pid)) current.push(value);
  map.set(key, current);
}

function selectUnambiguousWorkload(candidates, { requireTaskEvidence = false } = {}) {
  if (!candidates?.length) return null;
  const relevant = requireTaskEvidence
    ? candidates.filter((candidate) => candidate.attributionEvidence?.taskUser)
    : candidates;
  if (!relevant.length) return null;
  const usable = relevant.filter((candidate) => candidate.attributedUser);
  if (usable.length !== relevant.length) return null;
  const users = new Set(usable.map((candidate) => candidate.attributedUser));
  if (users.size !== 1) return null;
  return usable.find((candidate) => candidate.command) || usable[0];
}

function parseProbe(output) {
  const hostMarker = "__WATCH4GPU_HOST__";
  const gpuMarker = "__WATCH4GPU_GPUS__";
  const processMarker = "__WATCH4GPU_PROCESSES__";
  const ownerMarker = "__WATCH4GPU_OWNERS__";
  const workloadMarker = "__WATCH4GPU_WORKLOADS__";
  const namespaceMarker = "__WATCH4GPU_NAMESPACES__";
  const deviceMarker = "__WATCH4GPU_DEVICES__";
  const containerMarker = "__WATCH4GPU_CONTAINER_CWDS__";
  const doneMarker = "__WATCH4GPU_DONE__";
  const hostStart = output.lastIndexOf(hostMarker);
  const gpuStart = output.lastIndexOf(gpuMarker);
  const processStart = output.lastIndexOf(processMarker);
  const ownerStart = output.lastIndexOf(ownerMarker);
  const workloadStart = output.lastIndexOf(workloadMarker);
  const namespaceStart = output.lastIndexOf(namespaceMarker);
  const deviceStart = output.lastIndexOf(deviceMarker);
  const containerStart = output.lastIndexOf(containerMarker);
  const doneStart = output.lastIndexOf(doneMarker);
  const hostPart = hostStart >= 0 && gpuStart > hostStart ? output.slice(hostStart + hostMarker.length, gpuStart) : "";
  const gpuPart = gpuStart >= 0 && processStart > gpuStart ? output.slice(gpuStart + gpuMarker.length, processStart) : "";
  const processPart = processStart >= 0 && ownerStart > processStart ? output.slice(processStart + processMarker.length, ownerStart) : "";
  const ownerPart = ownerStart >= 0 && workloadStart > ownerStart ? output.slice(ownerStart + ownerMarker.length, workloadStart) : "";
  const workloadPart = workloadStart >= 0 && namespaceStart > workloadStart ? output.slice(workloadStart + workloadMarker.length, namespaceStart) : "";
  const namespacePart = namespaceStart >= 0 && deviceStart > namespaceStart ? output.slice(namespaceStart + namespaceMarker.length, deviceStart) : "";
  const deviceEnd = containerStart > deviceStart ? containerStart : doneStart;
  const devicePart = deviceStart >= 0 && deviceEnd > deviceStart ? output.slice(deviceStart + deviceMarker.length, deviceEnd) : "";
  const containerPart = containerStart >= 0 && doneStart > containerStart ? output.slice(containerStart + containerMarker.length, doneStart) : "";
  const deviceProcessStart = devicePart.indexOf(deviceProcessMarker);
  const deviceMapPart = deviceProcessStart >= 0 ? devicePart.slice(0, deviceProcessStart) : "";
  const deviceProcessPart = deviceProcessStart >= 0 ? devicePart.slice(deviceProcessStart + deviceProcessMarker.length) : "";
  const normalizeProcessCommand = (value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 700);
  const containerCwdsByCommand = new Map();
  for (const line of containerPart.split(/\r?\n/)) {
    const [containerId, containerPid, cwd, ...commandParts] = line.split("\t");
    if (!/^[0-9a-f]{12,64}$/.test(containerId || "") || !/^\d+$/.test(containerPid || "")) continue;
    if (!cwd?.startsWith("/") || cwd.length > 1000) continue;
    const command = normalizeProcessCommand(commandParts.join("\t"));
    if (!command) continue;
    const candidates = containerCwdsByCommand.get(command) || new Set();
    candidates.add(cwd);
    containerCwdsByCommand.set(command, candidates);
  }
  const resolveProcessCwd = (value, command) => {
    const direct = value === "-" ? null : value || null;
    if (direct) return direct;
    const candidates = containerCwdsByCommand.get(normalizeProcessCommand(command));
    return candidates?.size === 1 ? [...candidates][0] : null;
  };
  const owners = new Map();
  for (const line of ownerPart.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (match) {
      const [user, pid, elapsed, command] = match.slice(1);
      const cwd = resolveProcessCwd(null, command);
      owners.set(Number(pid), {
        user,
        elapsed,
        command,
        cwd,
        ...buildAttribution({ systemAccount: user, command, cwd }),
      });
    }
  }
  const workloadsByExactPid = new Map();
  const namespaceCandidates = new Map();
  const pgidCandidates = new Map();
  const sidCandidates = new Map();
  const cudaCandidates = new Map();
  const deviceCandidates = new Map();
  const workloads = [];
  for (const line of workloadPart.split(/\r?\n/)) {
    const [user, pid, ppid, pgid, sid, elapsed, namespacePidsValue, cwd, cudaValue, localRankValue, rankValue, worldSizeValue, ...commandParts] = line.split("\t");
    if (!/^\d+$/.test(pid || "")) continue;
    const namespacePids = parseNamespacePids(namespacePidsValue);
    const hostPid = namespacePids[0] || Number(pid);
    const command = commandParts.join("\t");
    const resolvedCwd = resolveProcessCwd(cwd, command);
    const visibleDevices = parseVisibleDevices(cudaValue === "-" ? "" : cudaValue);
    const localRank = integerOrNull(localRankValue === "-" ? "" : localRankValue);
    const rank = integerOrNull(rankValue === "-" ? "" : rankValue);
    const worldSize = integerOrNull(worldSizeValue === "-" ? "" : worldSizeValue);
    const physicalGpu = visibleDevices.length === 1
      ? visibleDevices[0]
      : localRank != null && visibleDevices.length > 0 && localRank < visibleDevices.length
        ? visibleDevices[localRank]
        : localRank != null && visibleDevices.length === 0
          ? localRank
          : null;
    const workload = {
      user,
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      sid: Number(sid),
      elapsed,
      namespacePids,
      hostPid,
      namespacePid: namespacePids.at(-1) || Number(pid),
      groupCount: 1,
      cwd: resolvedCwd,
      command,
      cudaVisibleDevices: visibleDevices,
      localRank,
      rank,
      worldSize,
      physicalGpu,
      devices: physicalGpu == null ? visibleDevices : [physicalGpu],
    };
    if (/client_start\.py|server_start\.py|fake_cmd|\/nvitop(?:\s|$)|\/gpustat(?:\s|$)/i.test(workload.command)) continue;
    Object.assign(workload, buildAttribution({
      systemAccount: workload.user,
      command: workload.command,
      cwd: workload.cwd,
    }));
    workloads.push(workload);
    workloadsByExactPid.set(workload.pid, workload);
    for (const namespacePid of namespacePids) {
      if (namespacePid !== workload.pid) addCandidate(namespaceCandidates, namespacePid, workload);
    }
    for (const device of workload.devices) addCandidate(cudaCandidates, device, workload);
  }
  for (const workload of workloads) {
    if (workload.attributionEvidence.taskUser) continue;
    let parent = workloadsByExactPid.get(workload.ppid);
    const visited = new Set();
    while (parent && !visited.has(parent.pid)) {
      visited.add(parent.pid);
      if (parent.attributionEvidence.taskUser) {
        Object.assign(workload, buildAttribution({
          systemAccount: workload.user,
          command: workload.command,
          cwd: workload.cwd,
          inheritedTaskUser: parent.attributionEvidence.taskUser,
        }));
        break;
      }
      parent = workloadsByExactPid.get(parent.ppid);
    }
  }
  for (const workload of workloads) {
    addCandidate(pgidCandidates, workload.pgid, workload);
    addCandidate(sidCandidates, workload.sid, workload);
  }
  for (const line of namespacePart.split(/\r?\n/)) {
    const [user, pid, ppid, pgid, sid, elapsed, namespacePidsValue, cwd, ...commandParts] = line.split("\t");
    if (!/^\d+$/.test(pid || "")) continue;
    const namespacePids = parseNamespacePids(namespacePidsValue);
    const hostPid = namespacePids[0] || Number(pid);
    const command = commandParts.join("\t");
    const resolvedCwd = resolveProcessCwd(cwd, command);
    const attribution = buildAttribution({ systemAccount: user, command, cwd: resolvedCwd });
    const evidence = {
      user,
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      sid: Number(sid),
      elapsed,
      namespacePids,
      hostPid,
      namespacePid: namespacePids.at(-1) || Number(pid),
      cwd: resolvedCwd,
      command,
      ...attribution,
    };
    for (const namespacePid of namespacePids) {
      if (namespacePid !== evidence.pid) addCandidate(namespaceCandidates, namespacePid, evidence);
    }
    addCandidate(pgidCandidates, evidence.pgid, evidence);
    addCandidate(sidCandidates, evidence.sid, evidence);
  }
  const deviceProcesses = new Map();
  for (const line of deviceProcessPart.split(/\r?\n/)) {
    const [pid, user, ppid, pgid, sid, elapsed, namespacePidsValue, cwd, ...commandParts] = line.split("\t");
    if (!/^\d+$/.test(pid || "") || !user) continue;
    const namespacePids = parseNamespacePids(namespacePidsValue);
    const hostPid = namespacePids[0] || Number(pid);
    const command = commandParts.join("\t");
    const resolvedCwd = resolveProcessCwd(cwd, command);
    const attribution = buildAttribution({ systemAccount: user, command, cwd: resolvedCwd });
    deviceProcesses.set(Number(pid), {
      user,
      pid: Number(pid),
      ppid: integerOrNull(ppid),
      pgid: integerOrNull(pgid),
      sid: integerOrNull(sid),
      elapsed,
      namespacePids,
      hostPid,
      namespacePid: namespacePids.at(-1) || Number(pid),
      cwd: resolvedCwd,
      command,
      ...attribution,
    });
  }
  for (const line of deviceMapPart.split(/\r?\n/)) {
    const [gpuIndex, pid, method] = line.split("\t");
    if (!/^\d+$/.test(gpuIndex || "") || !/^\d+$/.test(pid || "")) continue;
    const process = deviceProcesses.get(Number(pid));
    if (!process) continue;
    addCandidate(deviceCandidates, Number(gpuIndex), { ...process, deviceMethod: method });
  }
  const findTaskAncestor = (startPid) => {
    let current = workloadsByExactPid.get(startPid);
    const visited = new Set();
    while (current && !visited.has(current.pid)) {
      visited.add(current.pid);
      if (current.attributionEvidence?.taskUser) return current;
      current = workloadsByExactPid.get(current.ppid);
    }
    return null;
  };
  const gpuRows = gpuPart.split(/\r?\n/).filter((line) => /^\s*\d+\s*,/.test(line)).map((line) => {
    const [index, name, uuid, temperature, utilization, memoryUsed, memoryTotal, powerDraw, powerLimit] = csv(line);
    return {
      index: Number(index), name, uuid,
      temperature: number(temperature) || 0,
      utilization: number(utilization) || 0,
      memoryUsed: number(memoryUsed) || 0,
      memoryTotal: number(memoryTotal) || 0,
      powerDraw: number(powerDraw), powerLimit: number(powerLimit),
    };
  });
  const gpuIndexByUuid = new Map(gpuRows.map((gpu) => [gpu.uuid, gpu.index]));
  const processes = processPart.split(/\r?\n/).filter((line) => line.includes(",")).map((line) => {
    const [gpuUuid, pid, name, memoryMiB] = csv(line);
    const numericPid = Number(pid);
    const gpuIndex = gpuIndexByUuid.get(gpuUuid);
    const directOwner = owners.get(numericPid);
    const directDeviceProcess = deviceProcesses.get(numericPid);
    const directWorkload = workloadsByExactPid.get(numericPid);
    const directTaskWorkload = directWorkload?.attributionEvidence?.taskUser ? directWorkload : null;
    const directTaskOwner = directOwner?.attributionEvidence?.taskUser ? directOwner : null;
    const namespaceWorkload = selectUnambiguousWorkload(namespaceCandidates.get(numericPid), { requireTaskEvidence: true });
    const ancestorWorkload = findTaskAncestor(directDeviceProcess?.ppid);
    const pgidWorkload = selectUnambiguousWorkload(pgidCandidates.get(directDeviceProcess?.pgid), { requireTaskEvidence: true });
    const deviceWorkload = selectUnambiguousWorkload(deviceCandidates.get(gpuIndex), { requireTaskEvidence: true });
    const cudaWorkload = selectUnambiguousWorkload(cudaCandidates.get(gpuIndex), { requireTaskEvidence: true });
    const sidWorkload = selectUnambiguousWorkload(sidCandidates.get(directDeviceProcess?.sid), { requireTaskEvidence: true });
    const weakDeviceWorkload = selectUnambiguousWorkload(deviceCandidates.get(gpuIndex));
    const weakCudaWorkload = selectUnambiguousWorkload(cudaCandidates.get(gpuIndex));
    let workload = null;
    let owner = null;
    let mappingSource = null;
    if (directTaskWorkload) {
      workload = directTaskWorkload;
      owner = directTaskWorkload;
      mappingSource = "pid";
    } else if (directTaskOwner) {
      owner = directTaskOwner;
      mappingSource = "pid";
    } else if (namespaceWorkload) {
      workload = namespaceWorkload;
      owner = namespaceWorkload;
      mappingSource = "nspid";
    } else if (ancestorWorkload) {
      workload = ancestorWorkload;
      owner = ancestorWorkload;
      mappingSource = "parent";
    } else if (pgidWorkload) {
      workload = pgidWorkload;
      owner = pgidWorkload;
      mappingSource = "parent";
    } else if (deviceWorkload) {
      workload = deviceWorkload;
      owner = deviceWorkload;
      mappingSource = "device";
    } else if (cudaWorkload) {
      workload = cudaWorkload;
      owner = cudaWorkload;
      mappingSource = "cuda-env";
    } else if (sidWorkload) {
      workload = sidWorkload;
      owner = sidWorkload;
      mappingSource = "parent";
    } else if (directWorkload) {
      workload = directWorkload;
      owner = directWorkload;
      mappingSource = "pid";
    } else if (weakDeviceWorkload) {
      workload = weakDeviceWorkload;
      owner = weakDeviceWorkload;
      mappingSource = "device";
    } else if (weakCudaWorkload) {
      workload = weakCudaWorkload;
      owner = weakCudaWorkload;
      mappingSource = "cuda-env";
    } else if (directOwner) {
      owner = directOwner;
      mappingSource = "pid";
    }
    const launchCommand = workload?.command || directDeviceProcess?.command || owner?.command || null;
    const linkedAttribution = workload?.attributionEvidence || owner?.attributionEvidence
      ? {
          attributedUser: workload?.attributedUser || owner?.attributedUser || null,
          attributionEvidence: workload?.attributionEvidence || owner?.attributionEvidence,
        }
      : buildAttribution({
          systemAccount: owner?.user || null,
          processName: name,
          command: launchCommand,
          cwd: directDeviceProcess?.cwd || owner?.cwd || null,
        });
    const attributedUser = linkedAttribution.attributedUser;
    const attributionSource = mappingSource || (attributedUser ? "path" : null);
    return {
      gpuUuid,
      pid: numericPid,
      name: name === "[Not Found]" && launchCommand ? launchCommand : name,
      memoryMiB: number(memoryMiB) || 0,
      owner: owner?.user || null,
      attributedUser,
      attributionSource,
      attributionEvidence: linkedAttribution.attributionEvidence || null,
      elapsed: owner?.elapsed || null,
      command: launchCommand,
      containerPid: workload?.pid || null,
      ppid: workload?.ppid || null,
      pgid: workload?.pgid || null,
      sid: workload?.sid || null,
    };
  });
  const gpus = gpuRows.map((gpu) => ({ ...gpu, processes: processes.filter((process) => process.gpuUuid === gpu.uuid) }));
  if (!gpus.length) throw new Error(`未读取到 GPU；远端输出：${gpuPart.trim().slice(-1200) || "（空）"}`);
  return { hostname: hostPart.trim().split(/\r?\n/).filter(Boolean).at(-1), gpus, workloads };
}

async function probe(node, requestedTimeoutMs = null) {
  const started = Date.now();
  try {
    let output;
    const timeoutMs = requestedTimeoutMs ?? (node.mode === "relay" ? RELAY_TIMEOUT_MS : SSH_TIMEOUT_MS);
    const common = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2"];
    if (node.mode === "direct") {
      output = await run("ssh", [...common, "-p", String(node.port || 22), node.sshHost, remoteProbe], undefined, timeoutMs);
    } else {
      output = await runRelay(node, timeoutMs);
    }
    const parsed = parseProbe(output);
    return { nodeId: node.id, ok: true, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, ...parsed };
  } catch (error) {
    return { nodeId: node.id, ok: false, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, gpus: [], error: error instanceof Error ? error.message : String(error) };
  }
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  if (request.method === "OPTIONS") return json(response, 204, {});
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true });
    if (request.method === "GET" && url.pathname === "/api/nodes") return json(response, 200, await readConfig());
    if (request.method === "GET" && url.pathname === "/api/status") {
      const config = await readConfig();
      const requestedNode = url.searchParams.get("node");
      const requestedTimeoutMs = parseTimeoutMs(url.searchParams.get("timeoutSeconds"));
      const enabled = config.nodes.filter((node) => node.enabled !== false && (!requestedNode || node.id === requestedNode));
      if (requestedNode && enabled.length === 0) return json(response, 404, { error: `找不到已启用的节点：${requestedNode}` });
      const statuses = await Promise.all(enabled.map((node) => probe(node, requestedTimeoutMs)));
      return json(response, 200, { statuses });
    }
    if (request.method === "PUT" && url.pathname === "/api/nodes") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1_000_000) throw new Error("请求内容过大");
      }
      const nodes = validateNodes(JSON.parse(body));
      const config = { nodes };
      await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      return json(response, 200, config);
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => console.log(`GPU Watch API: http://${HOST}:${PORT}`));
}

export { buildContainerCwdQuery, containerCwdQuery, deviceQuery, parseProbe, parseTimeoutMs, relayRemoteProbe, remoteProbe };
