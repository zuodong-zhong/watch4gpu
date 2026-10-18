"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { resolveMyAccounts, summarizeMyGpus, type MyNode, type MyStatus } from "@/lib/my-gpus.mjs";
import { formatShanghaiTime } from "@/lib/task-time.mjs";
import MyTasks from "./my-tasks";
import NodeTaskSummary from "./node-task-summary";
import { summarizeMyTasks, summarizeNodeTaskDescriptions } from "@/lib/my-tasks.mjs";

const STORAGE_KEY = "watch4gpu.myAccounts";
const COLLAPSED_STORAGE_KEY = "watch4gpu.myGpusCollapsed";
const DEFAULT_ACCOUNTS = [...resolveMyAccounts(process.env.NEXT_PUBLIC_WATCH4GPU_MY_ACCOUNTS || "", {})].join(", ");

export default function MyGpus({ nodes, statuses, names, api, now, staleAfter }: {
  nodes: MyNode[];
  statuses: Record<string, MyStatus>;
  names: Record<string, string>;
  api: string;
  now: number;
  staleAfter: number;
}) {
  const [identity, setIdentity] = useState("");
  const [draft, setDraft] = useState("");
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    async function loadIdentity() {
      let account = "";
      let savedCollapsed = false;
      try { account = window.localStorage.getItem(STORAGE_KEY) || ""; } catch { /* Storage is optional. */ }
      if (!resolveMyAccounts(account, {}).size) account = DEFAULT_ACCOUNTS;
      try { savedCollapsed = window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true"; } catch { /* Storage is optional. */ }
      if (!account) {
        try {
          const response = await fetch(`${api}/api/profile`, { cache: "no-store", signal: controller.signal });
          if (response.ok) {
            const profile = await response.json();
            if (typeof profile.account === "string") account = profile.account;
          }
        } catch { /* Manual account selection remains available when the API is offline. */ }
      }
      window.clearTimeout(timer);
      if (active) {
        setIdentity(account);
        setDraft(account);
        setReady(true);
        setEditing(!account);
        setCollapsed(savedCollapsed && Boolean(account));
      }
    }
    void loadIdentity();
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [api]);

  const accounts = useMemo(() => resolveMyAccounts(identity, names), [identity, names]);
  const summary = useMemo(() => summarizeMyGpus(nodes, statuses, accounts, now, staleAfter), [nodes, statuses, accounts, now, staleAfter]);
  const taskGroups = useMemo(() => summarizeMyTasks(nodes, statuses, accounts, now, staleAfter), [nodes, statuses, accounts, now, staleAfter]);
  const nodeTaskDescriptions = useMemo(() => new Map(taskGroups.map(({ node, tasks }) => [node.id, summarizeNodeTaskDescriptions(tasks)])), [taskGroups]);
  const displayNames = [...new Set([...accounts].map((account) => names[account]?.trim() || `@${account}`))].join("、");

  function save(event: FormEvent) {
    event.preventDefault();
    const value = [...resolveMyAccounts(draft, {})].join(", ");
    if (!value) return;
    setIdentity(value);
    setEditing(false);
    try { window.localStorage.setItem(STORAGE_KEY, value); } catch { /* Keep the session choice. */ }
  }

  function changeCollapsed(value: boolean) {
    setCollapsed(value);
    if (value) setEditing(false);
    try { window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(value)); } catch { /* Keep the session choice. */ }
  }

  return <section className="my-gpus" aria-labelledby="my-gpus-title">
    <div className="my-gpus-heading">
      <div><h2 id="my-gpus-title">我的 GPU</h2><p>{!ready ? "正在读取账号设置…" : accounts.size ? <span title={[...accounts].join("、")}>{displayNames} · 按进程归属匹配</span> : "设置服务器账号，查看自己正在使用的卡"}</p></div>
      {ready && <div className="my-gpus-actions">
        <button type="button" onClick={() => { changeCollapsed(false); setDraft(identity); setEditing((value) => !value); }} aria-expanded={editing} aria-controls="my-accounts-form">{editing ? "收起设置" : "修改账号"}</button>
        <button type="button" onClick={() => changeCollapsed(!collapsed)} aria-expanded={!collapsed} aria-controls="my-gpus-details">{collapsed ? "展开" : "收起"}<span className={`picker-chevron ${collapsed ? "" : "open"}`} aria-hidden="true">⌄</span></button>
      </div>}
    </div>
    {ready && accounts.size > 0 && <div className="my-gpus-count" role="status"><strong>{summary.matchedCount}</strong><span>块匹配 GPU</span>{summary.uncertainCount > 0 && <span className="my-gpus-uncertain">另有 {summary.uncertainCount} 块归属待确认</span>}{collapsed && summary.unavailableNodes > 0 && <span>{summary.unavailableNodes} 个节点待更新</span>}</div>}
    <div id="my-gpus-details" hidden={collapsed}>
    {editing && <form id="my-accounts-form" className="my-accounts-form" onSubmit={save}>
      <label htmlFor="my-accounts">我的服务器账号（可多个）</label>
      <div><input id="my-accounts" value={draft} onChange={(event) => setDraft(event.target.value)} list="my-account-options" placeholder="例如 alice, alice_lab" required aria-describedby="my-accounts-help" /><button type="submit" className="primary" disabled={!resolveMyAccounts(draft, {}).size}>保存</button></div>
      <datalist id="my-account-options">{Object.entries(names).map(([account, name]) => <option key={account} value={account}>{name}</option>)}</datalist>
      <small id="my-accounts-help">多个账号用逗号、顿号或空格分隔；同名映射的账号会自动合并，重复的卡只计一次。修改后保存在当前浏览器。</small>
      {DEFAULT_ACCOUNTS && <button type="button" className="my-accounts-default" onClick={() => setDraft(DEFAULT_ACCOUNTS)}>填入默认账号：{DEFAULT_ACCOUNTS}</button>}
      {resolveMyAccounts(draft, names).size > 0 && <div className="my-account-tags" aria-label="将统计的账号">{[...resolveMyAccounts(draft, names)].map((account) => <span key={account}>@{account}</span>)}</div>}
    </form>}
    {ready && accounts.size > 0 && <>
      {summary.groups.length > 0 ? <div className="my-gpus-nodes">{summary.groups.map(({ node, cards, stale, checkedAt }) => <div className={`my-gpus-node ${stale ? "is-stale" : ""}`} key={node.id}>
        <div className="my-gpus-node-heading"><strong>{node.name}</strong><small>{stale ? "上次记录 · 待刷新" : "最近采集"} · <time dateTime={checkedAt}>{formatShanghaiTime(checkedAt)}</time>（上海）</small></div>
        <div className="my-gpus-node-name"><NodeTaskSummary summaries={nodeTaskDescriptions.get(node.id) || []} stale={stale} /></div>
        <div className="my-gpus-card-groups" aria-label={`${node.name} 的 GPU`}>{[...new Set(cards.map((card) => card.name))].map((model) => {
          const modelCards = cards.filter((card) => card.name === model);
          return <div className="my-gpus-card-group" key={model}>
            <div className="my-gpus-card-heading"><span>{model}</span><small>{modelCards.length} 块 GPU</small></div>
            <ul>{modelCards.map((card) => <li key={card.uuid || card.index} className={card.uncertain ? "uncertain" : ""} title={`${card.name} · ${card.processCount} 个匹配进程`}><strong>GPU {card.index}</strong>{card.uncertain ? <small>归属待确认</small> : card.inferred ? <small>推断归属</small> : <small>已匹配</small>}</li>)}</ul>
          </div>;
        })}</div>
      </div>)}</div> : <p className="my-gpus-empty">{!nodes.some((node) => node.enabled) ? "添加或启用节点后，这里会显示你使用的 GPU。" : summary.unavailableNodes ? "等待节点数据，暂时无法确认你正在使用哪些卡。" : "最近采集中未发现这些账号的 GPU 进程。"}</p>}
      {(summary.unavailableNodes > 0 || summary.unknownGpus > 0) && <p className="my-gpus-note">{summary.unavailableNodes > 0 && `${summary.unavailableNodes} 个节点未就绪、刷新失败或数据过期，当前统计可能不完整。`}{summary.unknownGpus > 0 && ` ${summary.unknownGpus} 块 GPU 存在无法识别归属的进程。`}</p>}
      <MyTasks groups={taskGroups} />
    </>}
    </div>
  </section>;
}
