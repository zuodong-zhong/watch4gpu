"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { createNodePoller } from "@/lib/node-poller.mjs";
import { formatStorageBytes, mergeStorageStatus, storageCapacityTone, type StorageStatus } from "@/lib/storage-status.mjs";
import { formatShanghaiTime } from "@/lib/task-time.mjs";
import UiIcon from "./ui-icon";

export type StorageCapsuleHandle = { refresh: () => Promise<void> };

export default function StorageCapsule({ api, ready, intervalSeconds, timeoutSeconds, now, ref }: {
  api: string;
  ready: boolean;
  intervalSeconds: number;
  timeoutSeconds: number;
  now: number;
  ref?: Ref<StorageCapsuleHandle>;
}) {
  const [status, setStatus] = useState<StorageStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const settings = useRef({ intervalSeconds, timeoutSeconds });
  const pollerRef = useRef<ReturnType<typeof createNodePoller<{ id: string }, StorageStatus>> | null>(null);

  useImperativeHandle(ref, () => ({ refresh: () => pollerRef.current?.refresh() ?? Promise.resolve() }), []);

  useEffect(() => {
    if (!open) return;
    popoverRef.current?.focus({ preventScroll: true });
    function closeOutside(event: Event) {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    function positionPopover() {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
      const anchor = trigger.getBoundingClientRect();
      const { width, height } = popover.getBoundingClientRect();
      const gap = 8;
      const edge = 12;
      const below = anchor.bottom + gap;
      const above = anchor.top - gap - height;
      const top = below + height <= window.innerHeight - edge ? below : above >= edge ? above : Math.max(edge, window.innerHeight - height - edge);
      popover.style.top = `${top}px`;
      popover.style.left = `${Math.max(edge, Math.min(anchor.left, window.innerWidth - width - edge))}px`;
    }
    positionPopover();
    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
    };
  }, [open, status, error]);

  useEffect(() => {
    settings.current = { intervalSeconds, timeoutSeconds };
    pollerRef.current?.setInterval(intervalSeconds * 1000);
  }, [intervalSeconds, timeoutSeconds]);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const poller = createNodePoller<{ id: string }, StorageStatus>({
      poll: async () => {
        const seconds = settings.current.timeoutSeconds;
        const response = await fetch(`${api}/api/storage?timeoutSeconds=${seconds}`, {
          cache: "no-store",
          // The API owns the SSH deadline. GPU requests may occupy the browser's
          // HTTP connection pool before this request can even reach the API.
          signal: controller.signal,
        });
        if (response.status === 404) throw new Error("请重启本地采集服务以启用磁盘监控，再点击刷新。");
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "暂时无法读取磁盘空间，请重试。");
        return result;
      },
      onResult: (_, result) => {
        setStatus((current) => mergeStorageStatus(current, result));
        setError("");
      },
      onError: (_, failure) => {
        setError(failure instanceof Error && failure.name === "TimeoutError"
          ? "读取磁盘超时，请重试或调高超时上限。"
          : failure instanceof Error && failure.name !== "TypeError"
            ? failure.message
            : "无法连接本地采集服务，请确认服务正在运行后重试。");
        setStatus((current) => current ? { ...current, ok: false, disks: current.disks.map((disk) => ({ ...disk, refreshFailed: true })) } : current);
      },
      onActivity: (count) => setBusy(count > 0),
    });
    pollerRef.current = poller;
    poller.setInterval(settings.current.intervalSeconds * 1000);
    poller.setNodes([{ id: "storage" }]);
    return () => { poller.stop(); controller.abort(); pollerRef.current = null; };
  }, [api, ready]);

  const staleAfter = Math.max(90_000, (intervalSeconds + timeoutSeconds + 15) * 1000);
  const diskStates = status?.disks.map((disk) => {
    const checkedAt = Date.parse(disk.checkedAt ?? "");
    const stale = disk.ok && (disk.refreshFailed || !Number.isFinite(checkedAt) || now - checkedAt > staleAfter);
    return { disk, stale, tone: stale ? "stale" : storageCapacityTone(disk) };
  }) ?? [];
  const lowSpaceCount = diskStates.filter(({ tone }) => tone === "critical" || tone === "warning").length;
  const pending = Boolean(error || diskStates.some(({ disk, stale }) => !disk.ok || stale));
  const summary = lowSpaceCount ? `${lowSpaceCount} 个盘空间紧张` : pending ? "读数待刷新" : status?.configured ? `${status.disks.length} 个磁盘` : status ? "尚未配置" : "正在读取";

  return <div className="storage-control">
    <button type="button" ref={triggerRef} className={`user-filter-trigger storage-trigger ${open ? "filtered" : ""}`} aria-label={`常用盘空间：${summary}`} title={summary} aria-haspopup="dialog" aria-expanded={open} aria-controls="storage-popover" onClick={() => setOpen((current) => !current)}>
      <UiIcon name="disk" className="storage-icon" />
      <strong>常用盘</strong>
      {(lowSpaceCount > 0 || pending) && <span className={`storage-indicator ${lowSpaceCount ? "is-low" : "is-pending"}`} aria-hidden="true" />}
      <UiIcon name="chevron-down" className={`picker-chevron ${open ? "open" : ""}`} />
    </button>
    {open && createPortal(<div className="storage-popover" id="storage-popover" ref={popoverRef} role="dialog" aria-labelledby="storage-title" tabIndex={-1}>
    <div className="storage-heading">
      <div>
        <h2 id="storage-title">常用盘空间</h2>
        <p>{status?.configured ? <><span>{status.sshHost}</span><span aria-hidden="true"> · </span>{intervalSeconds ? `采集后每 ${intervalSeconds} 秒刷新` : "自动刷新已暂停"}</> : "共享存储与系统盘的可用容量"}</p>
      </div>
      <button type="button" className="storage-refresh" disabled={!ready || busy} onClick={() => void pollerRef.current?.refresh()} aria-busy={busy}>
        <UiIcon name="refresh" />{busy ? "读取中…" : "刷新磁盘"}
      </button>
    </div>
    {error && <p className="storage-error" role="alert">{error}{status?.disks.some((disk) => disk.ok) && " 当前保留上次采集的数据。"}</p>}
    {!status && !error && <p className="storage-empty" role="status">正在读取磁盘空间…</p>}
    {status?.configured === false && <p className="storage-empty">尚未配置常用盘。在 <code>data/storage.local.json</code> 中填写 SSH 登录机和磁盘挂载路径后，点击刷新。</p>}
    {status?.configured && <ul className="storage-disks" aria-label="磁盘可用空间">{diskStates.map(({ disk, stale, tone }) => {
      const capacityTone = storageCapacityTone(disk);
      const state = !disk.ok ? "读取失败" : stale ? "上次记录 · 待刷新" : capacityTone === "critical" ? "空间紧张" : capacityTone === "warning" ? "余量偏低" : "空间充足";
      return <li className={`storage-disk is-${tone}`} key={disk.path}>
        <div className="storage-identity"><div><h3>{disk.label}</h3><span className="storage-state">{state}</span></div><code>{disk.path}</code></div>
        <div className="storage-available"><span>{stale ? "上次可用" : "可用空间"}</span><strong>{disk.ok ? formatStorageBytes(disk.availableBytes) : "未知"}</strong></div>
        <div className="storage-usage">
          {disk.ok && <><div className="storage-usage-copy"><span>已用 {disk.usedPercent}%</span><span>总计 {formatStorageBytes(disk.totalBytes)}</span></div>
            <div className="storage-meter" role="meter" aria-label={`${disk.label}${stale ? "上次记录的" : ""}空间使用率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, disk.usedPercent ?? 0)} aria-valuetext={`已用 ${disk.usedPercent}%，可用 ${formatStorageBytes(disk.availableBytes)}`}><span style={{ width: `${Math.min(100, disk.usedPercent ?? 0)}%` }} /></div></>}
          {disk.checkedAt && <p className="storage-time"><time dateTime={disk.checkedAt}>{formatShanghaiTime(disk.checkedAt)}</time>（上海）</p>}
          {disk.error && <p className="storage-disk-error">{disk.error}</p>}
        </div>
      </li>;
    })}</ul>}
    </div>, document.body)}
  </div>;
}
