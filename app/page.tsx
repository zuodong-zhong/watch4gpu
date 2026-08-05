"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import userNames from "@/data/user-names.json";

type NodeMode = "direct" | "relay";
type AttributionSource = "pid" | "nspid" | "device" | "cuda-env" | "path" | "parent" | "node" | "account" | null;
type AttributionEvidence = {
  systemAccount: string | null;
  environmentUser: string | null;
  taskUser: string | null;
  taskSources: string[];
  conflict: boolean;
};

type NodeConfig = {
  id: string;
  name: string;
  mode: NodeMode;
  sshHost?: string;
  hostName?: string;
  user?: string;
  port?: number;
  gatewayHost?: string;
  gpuNodeId?: string;
  loginScript?: string;
  enabled: boolean;
};

type ProcessInfo = {
  gpuUuid: string;
  pid: number;
  name: string;
  memoryMiB: number;
  owner: string | null;
  attributedUser: string | null;
  attributionSource: AttributionSource;
  attributionEvidence?: AttributionEvidence | null;
  elapsed: string | null;
  command: string | null;
  cwd?: string | null;
  containerPid: number | null;
  ppid: number | null;
  pgid: number | null;
  sid: number | null;
};

type GpuInfo = {
  index: number;
  name: string;
  uuid: string;
  temperature: number;
  utilization: number;
  memoryUsed: number;
  memoryTotal: number;
  powerDraw: number | null;
  powerLimit: number | null;
  processes: ProcessInfo[];
};

type WorkloadInfo = {
  user: string | null;
  attributedUser: string | null;
  attributionSource: "path" | "parent" | "account" | null;
  attributionEvidence?: AttributionEvidence | null;
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  elapsed: string;
  hostPid: number;
  namespacePid: number;
  groupCount?: number;
  command: string;
  cwd?: string | null;
  devices: number[];
};

type NodeStatus = {
  nodeId: string;
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  hostname?: string;
  gpus: GpuInfo[];
  workloads?: WorkloadInfo[];
  error?: string;
};

const API = process.env.NEXT_PUBLIC_WATCH4GPU_API_URL || "http://127.0.0.1:8787";
const USER_NAMES: Record<string, string> = (() => {
  const configured = process.env.NEXT_PUBLIC_WATCH4GPU_USER_NAMES;
  if (!configured) return userNames;
  try {
    const parsed = JSON.parse(configured);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return userNames;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return userNames;
  }
})();
const DEFAULT_TIMEOUT_SECONDS = 45;
const TIMEOUT_STORAGE_KEY = "watch4gpu.timeoutSeconds";
const TIMEOUT_OPTIONS = [
  { seconds: 15, label: "快速" },
  { seconds: 25, label: "标准" },
  { seconds: 45, label: "稳妥" },
  { seconds: 60, label: "宽松" },
  { seconds: 90, label: "最长" },
];
const REFRESH_OPTIONS = [
  { seconds: 10, label: "频繁" },
  { seconds: 30, label: "标准" },
  { seconds: 60, label: "省心" },
  { seconds: 0, label: "手动" },
];
const emptyNode: NodeConfig = {
  id: "",
  name: "",
  mode: "direct",
  sshHost: "",
  hostName: "",
  user: "",
  port: 22,
  gatewayHost: "",
  gpuNodeId: "",
  loginScript: "~/login.sh",
  enabled: true,
};

function clamp(value: number) {
  return Math.max(0, Math.min(100, value || 0));
}

function normalizeUser(user?: string | null) {
  return user?.trim().replace(/^@/, "").toLowerCase() || "";
}

function userIdentity(user?: string | null) {
  const account = normalizeUser(user);
  if (!account) return "用户不可见";
  const name = USER_NAMES[account];
  return name ? `${name}，账号 ${account}` : `账号 ${account}`;
}

function attributedUserLabel(user?: string | null, evidence?: AttributionEvidence | null) {
  const account = normalizeUser(user);
  if (!account) return "用户不可见";
  const display = USER_NAMES[account] || account;
  return evidence?.conflict ? `可能是 @${display}` : `@${display}`;
}

function attributionEvidenceTitle(user?: string | null, evidence?: AttributionEvidence | null) {
  if (!evidence) return null;
  const details = [
    evidence.systemAccount && `系统账户 ${evidence.systemAccount}`,
    evidence.environmentUser && `环境 ${evidence.environmentUser}`,
    evidence.taskUser && `任务目录 ${evidence.taskUser}`,
  ].filter(Boolean).join(" / ");
  if (evidence.conflict) {
    return `证据存在冲突：${details}。当前仅能判断可能是 ${normalizeUser(user)}，无法由进程信息确认实际操作者。`;
  }
  return details ? `归属证据：${details}` : null;
}

function AttributionEvidenceList({ evidence }: { evidence?: AttributionEvidence | null }) {
  if (!evidence?.conflict) return null;
  const items = [
    evidence.systemAccount && { kind: "system", label: "系统账户", value: evidence.systemAccount },
    evidence.environmentUser && { kind: "environment", label: "环境", value: evidence.environmentUser },
    evidence.taskUser && { kind: "task", label: "任务目录", value: evidence.taskUser },
  ].filter((item): item is { kind: string; label: string; value: string } => Boolean(item));
  return (
    <span className="attribution-evidence" role="list" aria-label="进程归属证据">
      {items.map((item) => <span className={item.kind} role="listitem" key={item.kind}><small>{item.label}</small>{item.value}</span>)}
    </span>
  );
}

function processAttributionTitle(process: ProcessInfo) {
  const evidenceTitle = attributionEvidenceTitle(process.attributedUser, process.attributionEvidence);
  if (evidenceTitle) return evidenceTitle;
  const identity = userIdentity(process.attributedUser);
  const account = process.owner ? `；系统账户 ${process.owner}` : "";
  switch (process.attributionSource) {
    case "pid": return `PID 直接匹配：${identity}${account}`;
    case "nspid": return `通过容器与宿主机 PID 映射推断：${identity}${account}`;
    case "device": return `通过 GPU 设备占用推断：${identity}${account}`;
    case "cuda-env": return `通过 CUDA 进程变量推断：${identity}${account}`;
    case "path": return `根据启动命令路径推断：${identity}${account}`;
    case "parent": return `根据父进程推断：${identity}${account}`;
    case "node": return `根据节点上下文推断：${identity}`;
    case "account": return `系统账户：${process.owner || process.attributedUser}`;
    default: return "当前 SSH 会话无法识别该进程用户";
  }
}

function isInferredAttribution(source: AttributionSource) {
  return source != null && ["nspid", "device", "cuda-env", "path", "parent", "node"].includes(source);
}

function isFreeGpu(gpu: GpuInfo) {
  return gpu.utilization <= 5 && gpu.memoryUsed <= 1024 && gpu.processes.length === 0;
}

function relativeTime(iso: string | undefined, now: number) {
  if (!iso) return "尚未更新";
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function MetricRing({ value, label }: { value: number; label: string }) {
  const safe = clamp(value);
  const tone = safe >= 90 ? "var(--red)" : safe >= 70 ? "var(--orange)" : "var(--green)";
  return (
    <div
      className="metric-ring"
      style={{ background: `conic-gradient(${tone} ${safe}%, rgba(29,29,31,.075) 0)` }}
    role="img"
    aria-label={`${label} ${Math.round(safe)}%`}
    >
      <div className="metric-ring-inner">
        <strong>{Math.round(safe)}%</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function GpuTile({ gpu }: { gpu: GpuInfo }) {
  const memoryPercent = gpu.memoryTotal ? (gpu.memoryUsed / gpu.memoryTotal) * 100 : 0;
  const free = isFreeGpu(gpu);
  return (
    <article className={`gpu-tile ${free ? "gpu-free" : "gpu-occupied"}`}>
      <div className="gpu-head">
        <div><span className="gpu-index">GPU {gpu.index}</span><h4 title={gpu.name}>{gpu.name}</h4></div>
        <div className="gpu-state-group">
          <span className={`gpu-state ${free ? "free" : "occupied"}`}>{free ? "可用" : "已占用"}</span>
          <span className={`temperature ${gpu.temperature >= 80 ? "hot" : ""}`}>{gpu.temperature}°C</span>
        </div>
      </div>

      <div className="gpu-vitals">
        <MetricRing value={gpu.utilization} label="利用率" />
        <MetricRing value={memoryPercent} label="显存" />
        <div className="memory-copy">
          <small>显存用量</small>
          <strong>{(gpu.memoryUsed / 1024).toFixed(1)}</strong>
          <span>/ {(gpu.memoryTotal / 1024).toFixed(1)} GB</span>
        </div>
      </div>

      <div className="gpu-foot">
        <span>{gpu.powerDraw == null ? "功耗未知" : gpu.powerLimit == null ? `${Math.round(gpu.powerDraw)} W · 上限未知` : `${Math.round(gpu.powerDraw)} / ${Math.round(gpu.powerLimit)} W`}</span>
        <span>{gpu.processes.length ? `${gpu.processes.length} 个进程` : "无计算进程"}</span>
      </div>

      {gpu.processes.length > 0 && (
        <div className="processes">
          {gpu.processes.map((process) => (
            <div className="process-row" key={`${gpu.uuid}-${process.pid}`}>
              <div className="process-main">
                <span
                  className={`process-owner ${isInferredAttribution(process.attributionSource) ? "inferred" : ""} ${process.attributionEvidence?.conflict ? "conflicted" : ""} ${process.attributedUser ? "" : "unknown"}`}
                  title={processAttributionTitle(process)}
                  role="note"
                  aria-label={processAttributionTitle(process)}
                >{attributedUserLabel(process.attributedUser, process.attributionEvidence)}{isInferredAttribution(process.attributionSource) && !process.attributionEvidence?.conflict && <small>推断</small>}</span>
                <span className="process-name" title={process.command || process.name}>{process.name.split("/").pop()}</span>
              </div>
              <AttributionEvidenceList evidence={process.attributionEvidence} />
              <div className="process-meta">
                <code>PID {process.pid}</code>
                <span>{process.elapsed ? `已运行 ${process.elapsed}` : "时长未知"}</span>
                <b>{process.memoryMiB} MiB</b>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function WorkloadDetails({ workloads }: { workloads: WorkloadInfo[] }) {
  if (!workloads.length) return null;
  return (
    <details className="workload-details" open>
      <summary><span>节点训练进程</span><strong>{workloads.length} 组</strong></summary>
      <div className="workload-rows">
        {workloads.slice(0, 12).map((workload) => (
          <div className="workload-row" key={`${workload.pid}-${workload.command}`}>
            <span
              className={`process-owner ${workload.attributionSource === "path" || workload.attributionSource === "parent" ? "inferred" : ""} ${workload.attributionEvidence?.conflict ? "conflicted" : ""}`}
              title={attributionEvidenceTitle(workload.attributedUser || workload.user, workload.attributionEvidence) || undefined}
              role="note"
            >{attributedUserLabel(workload.attributedUser || workload.user, workload.attributionEvidence)}</span>
            <code>PID {workload.pid}</code>
            {workload.devices.length > 0 && <span className="workload-gpu">GPU {workload.devices.join(",")}</span>}
            <span className="workload-command" title={workload.command}>{workload.command}</span>
            <span>{workload.elapsed}</span>
            <AttributionEvidenceList evidence={workload.attributionEvidence} />
          </div>
        ))}
      </div>
      {workloads.length > 12 && <small>另有 {workloads.length - 12} 个进程组</small>}
    </details>
  );
}

function CollectionPicker({
  id,
  label,
  value,
  options,
  icon,
  helperText,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  options: { seconds: number; label: string }[];
  icon: "refresh" | "timeout";
  helperText: string;
  disabled?: boolean;
  onChange: (seconds: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const controlRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const displayValue = value === 0 ? "暂停" : `${value} 秒`;

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.requestAnimationFrame(() => {
      popoverRef.current?.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)?.focus();
    });
    function closeMenu(event: PointerEvent) {
      if (!controlRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, value]);

  function choose(seconds: number) {
    onChange(seconds);
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return <div className="collection-picker" ref={controlRef}>
    <span>{label}</span>
    <button
      className="collection-trigger"
      type="button"
      ref={triggerRef}
      disabled={disabled}
      aria-label={`${label}：${displayValue}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={id}
      onClick={() => setOpen((current) => !current)}
    >
      <span className={`picker-icon ${icon}`} aria-hidden="true" />
      <strong>{value === 0 ? "暂停" : <>{value}<small>秒</small></>}</strong>
      <span className={`picker-chevron ${open ? "open" : ""}`} aria-hidden="true">⌄</span>
    </button>
    {open && <div className="collection-popover" id={id} ref={popoverRef} role="dialog" aria-label={`设置${label}`}>
      <div className="collection-popover-copy"><strong>{label}</strong><span>{icon === "refresh" ? "选择数据自动更新频率" : "单个节点的最长等待时间"}</span></div>
      <div className={`collection-options options-${options.length}`} role="group" aria-label={label}>
        {options.map((option) => <button
          type="button"
          key={option.seconds}
          data-value={option.seconds}
          className={value === option.seconds ? "active" : ""}
          aria-pressed={value === option.seconds}
          onClick={() => choose(option.seconds)}
        ><strong>{option.seconds === 0 ? "暂停" : <>{option.seconds}<small>秒</small></>}</strong><span>{option.label}</span></button>)}
      </div>
      <p>{helperText}</p>
    </div>}
  </div>;
}

export default function Home() {
  const [nodes, setNodes] = useState<NodeConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [configError, setConfigError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [query, setQuery] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState(30);
  const [timeoutSeconds, setTimeoutSeconds] = useState(DEFAULT_TIMEOUT_SECONDS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<NodeConfig>(emptyNode);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const modalRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const timeoutSecondsRef = useRef(DEFAULT_TIMEOUT_SECONDS);

  const loadNodes = useCallback(async () => {
    try {
      const response = await fetch(`${API}/api/nodes`, { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取节点配置");
      const data = await response.json();
      setNodes(data.nodes);
      setConfigError("");
    } catch {
      setConfigError("无法读取节点配置");
    }
  }, []);

  const refresh = useCallback(async (silent = false, timeoutOverride?: number) => {
    if (!silent) setRefreshing(true);
    try {
      const params = new URLSearchParams({ timeoutSeconds: String(timeoutOverride ?? timeoutSecondsRef.current) });
      const response = await fetch(`${API}/api/status?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("刷新失败");
      const data = await response.json();
      const next = Object.fromEntries((data.statuses as NodeStatus[]).map((item) => [item.nodeId, item]));
      setStatuses(next);
      setStatusError("");
      setNow(Date.now());
    } catch {
      setStatusError("本地采集服务未连接");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = Number(window.localStorage.getItem(TIMEOUT_STORAGE_KEY));
        if (TIMEOUT_OPTIONS.some((option) => option.seconds === stored)) {
          timeoutSecondsRef.current = stored;
          setTimeoutSeconds(stored);
        }
      } catch {
        // Local storage can be unavailable in privacy-restricted browser contexts.
      }
      setSettingsReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    const timer = window.setTimeout(() => { void Promise.all([loadNodes(), refresh()]); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadNodes, refresh, settingsReady]);

  useEffect(() => {
    if (!intervalSeconds) return;
    const timer = window.setInterval(() => { void refresh(true); }, intervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [intervalSeconds, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    window.requestAnimationFrame(() => previousFocusRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!editorOpen || !modalRef.current) return;
    const modal = modalRef.current;
    const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const firstField = modal.querySelector<HTMLElement>("[data-autofocus]") || modal.querySelector<HTMLElement>(focusableSelector);
    firstField?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(modal.querySelectorAll<HTMLElement>(focusableSelector));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeEditor, editorOpen]);

  const filteredNodes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return nodes;
    return nodes.filter((node) => [node.name, node.sshHost, node.hostName, node.gpuNodeId].some((value) => value?.toLowerCase().includes(needle)));
  }, [nodes, query]);

  const rankedNodes = useMemo(() => filteredNodes.map((node, originalIndex) => {
    const status = statuses[node.id];
    const freeGpuCount = status?.ok ? status.gpus.filter(isFreeGpu).length : 0;
    return { node, originalIndex, freeGpuCount };
  }).sort((a, b) => b.freeGpuCount - a.freeGpuCount || a.originalIndex - b.originalIndex), [filteredNodes, statuses]);

  const enabledNodes = nodes.filter((node) => node.enabled);
  const allGpus = enabledNodes.flatMap((node) => statuses[node.id]?.ok ? statuses[node.id].gpus : []);
  const onlineCount = enabledNodes.filter((node) => statuses[node.id]?.ok).length;
  const freeGpuTotal = allGpus.filter(isFreeGpu).length;
  const occupiedGpuTotal = allGpus.length - freeGpuTotal;
  const avgUtil = allGpus.length ? Math.round(allGpus.reduce((sum, gpu) => sum + gpu.utilization, 0) / allGpus.length) : 0;
  const lastChecked = enabledNodes.map((node) => statuses[node.id]?.checkedAt).filter(Boolean).sort().at(-1);
  const serviceError = statusError || configError;

  function openCreate() {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingIndex(null);
    setDraft({ ...emptyNode });
    setSaveError("");
    setEditorOpen(true);
  }

  function openEdit(index: number) {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingIndex(index);
    setDraft({ ...nodes[index] });
    setSaveError("");
    setEditorOpen(true);
  }

  async function saveNodes(next: NodeConfig[]) {
    const response = await fetch(`${API}/api/nodes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: next }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存失败");
    setNodes(result.nodes);
  }

  async function submitNode(event: FormEvent) {
    event.preventDefault();
    setSaveError("");
    setSaving(true);
    const normalized = { ...draft, id: draft.id.trim(), name: draft.name.trim() };
    try {
      const next = editingIndex == null ? [...nodes, normalized] : nodes.map((node, index) => index === editingIndex ? normalized : node);
      await saveNodes(next);
      closeEditor();
      await refresh();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function deleteNode(index: number) {
    setDeleting(true);
    try {
      await saveNodes(nodes.filter((_, itemIndex) => itemIndex !== index));
      setDeleteIndex(null);
      await refresh();
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }

  function chooseTimeout(seconds: number) {
    timeoutSecondsRef.current = seconds;
    setTimeoutSeconds(seconds);
    try {
      window.localStorage.setItem(TIMEOUT_STORAGE_KEY, String(seconds));
    } catch {
      // Keep the in-memory choice even when persistence is unavailable.
    }
    void refresh(false, seconds);
  }

  function nodeState(node: NodeConfig, status?: NodeStatus) {
    if (!node.enabled) return { label: "已停用", tone: "disabled" };
    if (!status) return { label: "正在连接", tone: "connecting" };
    if (!status.ok) return { label: "无法连接", tone: "error" };
    const staleAfter = intervalSeconds ? Math.max(75_000, intervalSeconds * 2500) : 180_000;
    if (now - new Date(status.checkedAt).getTime() > staleAfter) return { label: "数据已过期", tone: "stale" };
    return { label: "在线", tone: "online" };
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="GPU Watch 首页"><span className="brand-mark">W4</span><span>GPU Watch<small>本地 GPU 控制台</small></span></a>
        <label className="search"><span aria-hidden="true">⌕</span><input aria-label="搜索节点" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索节点、IP 或编号" /></label>
        <div className="top-actions">
          <button className="icon-button" onClick={() => void refresh()} disabled={refreshing} aria-label="立即刷新"><span aria-hidden="true">{refreshing ? "…" : "↻"}</span></button>
          <button className="primary add-button" onClick={openCreate}><span aria-hidden="true">＋</span><span className="button-text">添加节点</span></button>
        </div>
      </header>

      <section className="overview" id="top" aria-labelledby="overview-title">
        <div className="overview-title">
          <p>GPU 集群</p>
          <h1 id="overview-title">资源状态</h1>
          <span className="sync-message" role="status" aria-live="polite">{refreshing ? "正在刷新…" : intervalSeconds === 0 ? `已暂停 · 更新于${relativeTime(lastChecked, now)}` : `更新于${relativeTime(lastChecked, now)}`}</span>
        </div>
        <div className="overview-stats" aria-label="集群资源概览">
          <div className="available"><span>可用 GPU</span><strong>{freeGpuTotal}</strong></div>
          <div><span>已占用</span><strong>{occupiedGpuTotal}</strong></div>
          <div><span>在线节点</span><strong>{onlineCount}<small> / {enabledNodes.length}</small></strong></div>
          <div><span>平均利用率</span><strong>{avgUtil}<small>%</small></strong></div>
        </div>
        <div className="collection-controls" aria-label="采集设置">
          <CollectionPicker id="refresh-menu" label="自动刷新" value={intervalSeconds} options={REFRESH_OPTIONS} icon="refresh" helperText="暂停后仍可使用顶部按钮手动刷新。" onChange={setIntervalSeconds} />
          <CollectionPicker id="timeout-menu" label="超时上限" value={timeoutSeconds} options={TIMEOUT_OPTIONS} icon="timeout" helperText="较慢的中转节点建议选择 45 秒以上。" disabled={!settingsReady} onChange={chooseTimeout} />
        </div>
      </section>

      {serviceError && nodes.length > 0 && <div className="notice" role="alert"><span aria-hidden="true">!</span><div><strong>暂时无法刷新</strong><p>继续显示上次成功采集的数据。</p></div><button onClick={() => { void loadNodes(); void refresh(); }}>重试</button></div>}

      <section className="section-head">
        <div><h2>{query ? `${filteredNodes.length} 个匹配节点` : `${nodes.length} 个计算节点`}</h2><p>{query ? `搜索“${query}”` : "空闲资源优先显示"}</p></div>
        <span>{freeGpuTotal ? `${freeGpuTotal} 块 GPU 可立即使用` : allGpus.length ? "当前没有空闲 GPU" : "等待资源数据"}</span>
      </section>

      <section className="node-grid" aria-label="计算节点">
        {loading && nodes.length === 0 && <div className="loading-state" role="status"><span className="spinner" aria-hidden="true" /><strong>正在连接本地采集服务</strong><p>读取节点配置与 GPU 状态…</p></div>}

        {!loading && serviceError && nodes.length === 0 && <div className="connection-state" role="alert"><span aria-hidden="true">!</span><h2>无法连接本地采集服务</h2><p>请确认 <code>npm run watch4gpu</code> 正在运行，然后重试。</p><button className="primary" onClick={() => { void loadNodes(); void refresh(); }}>重新连接</button></div>}

        {!loading && !serviceError && filteredNodes.length === 0 && <div className="empty-state"><span aria-hidden="true">◇</span><h2>{query ? "没有匹配的节点" : "还没有节点"}</h2><p>{query ? "换一个关键词，或清除搜索条件。" : "添加第一个计算节点，开始查看 GPU 状态。"}</p>{query ? <button onClick={() => setQuery("")}>清除搜索</button> : <button className="primary" onClick={openCreate}>添加节点</button>}</div>}

        {rankedNodes.map(({ node, originalIndex, freeGpuCount }) => {
          const status = statuses[node.id];
          const state = nodeState(node, status);
          return (
            <article className={`node-card ${freeGpuCount > 0 ? "has-free" : ""} state-${state.tone}`} key={node.id}>
              <div className="node-header">
                <div className="node-title"><span className={`status-dot ${state.tone}`} /><div><h3>{node.name}</h3><p>{node.mode === "direct" ? `${node.user ? `${node.user}@` : ""}${node.hostName || node.sshHost}` : `${node.gatewayHost} → GPU_${node.gpuNodeId}`}</p></div></div>
                <div className="node-actions"><span className={`node-state ${state.tone}`}>{state.label}</span><button onClick={() => openEdit(originalIndex)} aria-label={`编辑 ${node.name}`}>编辑</button><button className="delete" onClick={() => setDeleteIndex(originalIndex)} aria-label={`删除 ${node.name}`}>删除</button></div>
              </div>

              {!node.enabled ? <div className="state-message"><strong>这个节点已停用</strong><p>编辑节点可重新启用自动采集。</p></div> : status?.ok ? <>
                <div className="node-summary">
                  <div><strong>{freeGpuCount}</strong><span>/ {status.gpus.length} 块可用</span></div>
                  <p><span>{status.latencyMs} ms</span><span>{status.hostname || node.name}</span><span>{relativeTime(status.checkedAt, now)}更新</span></p>
                </div>
                <WorkloadDetails workloads={status.workloads || []} />
                <div className="gpu-grid">{status.gpus.map((gpu) => <GpuTile gpu={gpu} key={gpu.uuid || gpu.index} />)}</div>
              </> : status ? <div className="state-message error"><strong>无法连接节点</strong><p>{status.error}</p><button onClick={() => void refresh()}>重新尝试</button></div> : <div className="state-message"><strong>正在建立连接</strong><p>首次采集可能需要几秒钟。</p></div>}

              {deleteIndex === originalIndex && <div className="delete-confirm" role="alertdialog" aria-label={`确认删除 ${node.name}`}><p><strong>删除“{node.name}”？</strong><span>节点配置将从本机移除。</span></p><div><button onClick={() => setDeleteIndex(null)} disabled={deleting}>取消</button><button className="danger" onClick={() => void deleteNode(originalIndex)} disabled={deleting}>{deleting ? "正在删除…" : "确认删除"}</button></div></div>}
            </article>
          );
        })}
      </section>

      <footer><span>GPU Watch · 本地优先</span><span>SSH 配置与采集结果只保留在你的设备上</span></footer>

      {editorOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeEditor()}>
        <section className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="editor-title" aria-describedby="editor-description">
          <div className="modal-head"><div><p>节点配置</p><h2 id="editor-title">{editingIndex == null ? "添加新节点" : "编辑节点"}</h2><span id="editor-description">配置只会保存在这台设备上。</span></div><button onClick={closeEditor} aria-label="关闭"><span aria-hidden="true">×</span></button></div>
          <form onSubmit={submitNode}>
            <div className="mode-picker">
              <label className={draft.mode === "direct" ? "active" : ""}><input type="radio" checked={draft.mode === "direct"} onChange={() => setDraft({ ...draft, mode: "direct" })} />直连 SSH<small>通过 Host 别名或 IP 连接</small></label>
              <label className={draft.mode === "relay" ? "active" : ""}><input type="radio" checked={draft.mode === "relay"} onChange={() => setDraft({ ...draft, mode: "relay" })} />中转节点<small>登录网关后执行脚本</small></label>
            </div>
            <div className="form-grid">
              <label>配置 ID<input data-autofocus required pattern="[A-Za-z0-9._-]+" value={draft.id} disabled={editingIndex != null} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="iva-60" /><small>字母、数字、点、横线或下划线</small></label>
              <label>显示名称<input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="GPU Server 01" /></label>
              {draft.mode === "direct" ? <>
                <label className="wide">SSH Host 别名<input required value={draft.sshHost || ""} onChange={(event) => setDraft({ ...draft, sshHost: event.target.value })} placeholder="与 ~/.ssh/config 保持一致" /></label>
                <label>HostName / IP<input value={draft.hostName || ""} onChange={(event) => setDraft({ ...draft, hostName: event.target.value })} placeholder="192.0.2.10（可选）" /></label>
                <label>用户<input value={draft.user || ""} onChange={(event) => setDraft({ ...draft, user: event.target.value })} placeholder="researcher（可选）" /></label>
                <label>端口<input type="number" min="1" max="65535" value={draft.port || 22} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /></label>
              </> : <>
                <label className="wide">网关 SSH Host<input required value={draft.gatewayHost || ""} onChange={(event) => setDraft({ ...draft, gatewayHost: event.target.value })} placeholder="gpu-gateway" /></label>
                <label>GPU 节点编号<input required pattern="[0-9]+" value={draft.gpuNodeId || ""} onChange={(event) => setDraft({ ...draft, gpuNodeId: event.target.value })} placeholder="34" /></label>
                <label>远程登录脚本<input required value={draft.loginScript || ""} onChange={(event) => setDraft({ ...draft, loginScript: event.target.value })} placeholder="login.sh" /></label>
              </>}
            </div>
            <label className="toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span aria-hidden="true" />启用自动采集</label>
            {saveError && <p className="form-error" role="alert">{saveError}</p>}
            <div className="modal-actions"><button type="button" onClick={closeEditor} disabled={saving}>取消</button><button className="primary" type="submit" disabled={saving}>{saving ? "正在保存…" : "保存并刷新"}</button></div>
          </form>
        </section>
      </div>}
    </main>
  );
}
