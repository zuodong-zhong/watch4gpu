"use client";

import { useEffect, useState } from "react";
import { type summarizeMyTasks } from "@/lib/my-tasks.mjs";
import { formatShanghaiTime, formatTaskDuration, TASK_TIME_ZONE } from "@/lib/task-time.mjs";

const COLLAPSED_STORAGE_KEY = "watch4gpu.myTasksCollapsed";

export default function MyTasks({ groups }: { groups: ReturnType<typeof summarizeMyTasks> }) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { setCollapsed(window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true"); } catch { /* Storage is optional. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try { window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next)); } catch { /* Keep the session choice. */ }
  }

  const count = groups.reduce((total, group) => total + group.tasks.length, 0);

  return <section className="my-tasks" aria-labelledby="my-tasks-title">
    <div className="my-tasks-heading">
      <h3 id="my-tasks-title">我的 GPU 任务 <small>{count} 个进程</small></h3>
      <div className="my-gpus-actions my-tasks-actions">
        <span>{TASK_TIME_ZONE} · UTC+08:00</span>
        <button type="button" onClick={toggleCollapsed} aria-expanded={!collapsed} aria-controls="my-tasks-details" aria-label={collapsed ? "展开任务列表" : "收起任务列表"}>{collapsed ? "展开" : "收起"}<span className={`picker-chevron ${collapsed ? "" : "open"}`} aria-hidden="true">⌄</span></button>
      </div>
    </div>
    <div id="my-tasks-details" hidden={collapsed}>
    <p className="my-tasks-help">按 GPU 进程展示；同一进程跨卡合并。开始时间取进程启动时间，无法直接读取时标注估算来源。</p>
    {groups.length ? groups.map(({ node, tasks, stale, checkedAt }) => <div className="my-task-group" key={node.id}>
      <div className="my-task-node"><strong>{node.name}</strong><span>{stale ? "上次记录 · 待刷新" : "最近采集"} · {formatShanghaiTime(checkedAt)}</span></div>
      {tasks.map((task) => <article className={`my-task-row ${stale ? "is-stale" : ""}`} key={task.pid}>
        <div className="my-task-description">
          <div className="my-task-meta"><code>PID {task.pid}</code><span>{task.accounts.map((account) => `@${account}`).join("、")}</span><b>GPU {task.gpuIndices.join(", ")}</b>{task.uncertain ? <small className="my-gpus-uncertain">归属待确认</small> : task.inferred ? <small>归属推断</small> : null}</div>
          <details className="my-task-command"><summary title={task.command}>{task.description ? "查看原始命令" : task.command}</summary><pre>{task.command}</pre></details>
        </div>
        <dl className="my-task-times">
          <div><dt>开始时间{task.timing.source === "related" ? "（关联进程估算）" : task.timing.source === "estimated" ? "（估算）" : ""}</dt><dd>{task.timing.startedAt ? <time dateTime={task.timing.startedAt}>{formatShanghaiTime(task.timing.startedAt)}</time> : "未知"}</dd></div>
          <div><dt>{stale ? "采集时已运行" : "已运行"}{task.timing.source === "related" ? "（关联进程）" : ""}</dt><dd>{formatTaskDuration(task.durationSeconds)}</dd></div>
        </dl>
      </article>)}
    </div>) : <p className="my-gpus-empty">当前采集结果中没有可识别的个人 GPU 任务；节点状态与归属缺失情况见上方提示。</p>}
    </div>
  </section>;
}
