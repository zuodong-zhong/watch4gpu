import { type summarizeNodeTaskDescriptions } from "@/lib/my-tasks.mjs";
import { formatShanghaiTime, formatTaskDuration } from "@/lib/task-time.mjs";

export default function NodeTaskSummary({ summaries, stale }: { summaries: ReturnType<typeof summarizeNodeTaskDescriptions>; stale: boolean }) {
  if (!summaries.length) return null;
  return <div className="node-task-summaries" aria-label="节点任务摘要">{summaries.map(({ key, description, gpuIndices, processCount, uncertainCount, earliestStartedAt, longestDurationSeconds, estimatedTiming, missingTimingCount }) => {
    const evaluation = description.kind === "评测任务";
    const briefParameters = description.parameters.filter(({ label }) => evaluation
      ? ["批大小", "Few-shot", "样本限制（limit）"].includes(label)
      : ["训练方式", "训练轮数", "学习率", "每卡批大小", "梯度累积步数", "最大序列长度", "计算精度", "DeepSpeed"].includes(label));
    const projects = evaluation ? description.evaluationTasks : description.datasets.map((dataset) => dataset.name);
    return <div className="node-task-summary" key={key}>
      <div className="node-task-title"><span className={`node-task-kind ${evaluation ? "is-evaluation" : ""}`}>{description.kind}</span><strong>{description.modelType}</strong></div>
      {description.modelName && <p className="node-task-model" title={description.model}>{description.modelName}</p>}
      <dl className="node-task-timing">
        <div><dt>{processCount > 1 ? "最早进程启动" : "开始时间"} · 上海{estimatedTiming ? "（含估算）" : ""}</dt><dd>{earliestStartedAt ? <time dateTime={earliestStartedAt}>{formatShanghaiTime(earliestStartedAt)}</time> : "未知"}</dd></div>
        <div><dt>{stale ? "采集时" : ""}{processCount > 1 ? "最长运行" : "已运行"}{estimatedTiming ? "（含估算）" : ""}</dt><dd>{formatTaskDuration(longestDurationSeconds)}</dd></div>
      </dl>
      {missingTimingCount > 0 && <p className="node-task-timing-note">{missingTimingCount} 个进程的时间信息不完整</p>}
      {briefParameters.length > 0 && <dl className="node-task-parameters">{briefParameters.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      {projects.length > 0 && <div className="node-task-projects"><span>{evaluation ? "评测项目" : "数据集"}<small>{projects.length} 项</small></span><div>{projects.slice(0, 3).map((project, index) => <span key={`${project}-${index}`} title={project}>{project}</span>)}{projects.length > 3 && <small>另 {projects.length - 3} 项，见详情</small>}</div></div>}
      {description.frozen.length > 0 && <p className="node-task-freezing">{description.frozen.join(" · ")}</p>}
      <div className="node-task-footer"><small>{gpuIndices.length} 块 GPU · {processCount} 个进程<span title={`GPU ${gpuIndices.join(", ")}`}> · 卡号 {gpuIndices.join(", ")}</span>{uncertainCount > 0 && <span className="my-gpus-uncertain"> · {uncertainCount === processCount ? "归属待确认" : "含待确认进程"}</span>}</small></div>
      <details className="node-task-extra"><summary>参数详情</summary>
        {description.frozen.length > 0 && <p>{description.frozen.join(" · ")}</p>}
        {description.parameters.length > 0 && <dl>{description.parameters.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
        {projects.length > 0 && <p>{evaluation ? "评测项目" : "数据集"}：{projects.join("、")}</p>}
        {description.plugins.length > 0 && <p>插件：{description.plugins.map((plugin) => plugin.name).join("、")}</p>}
        {description.outputDir && <p>输出目录：{description.outputDir}</p>}
      </details>
    </div>;
  })}</div>;
}
