/** Tokenize a displayed command without executing it or expanding shell expressions.
 * @param {string} command
 */
function commandTokens(command) {
  const tokens = [];
  let value = "";
  let quote = "";
  let present = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === "\\" && quote !== "'" && index + 1 < command.length) {
      const next = command[index + 1];
      if (!quote || ['"', "\\", "$", "`", "\n"].includes(next)) {
        value += next;
        present = true;
        index++;
        continue;
      }
    }
    if (quote) {
      if (char === quote) quote = "";
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      present = true;
    } else if (/\s/.test(char)) {
      if (present) tokens.push(value);
      value = "";
      present = false;
    } else {
      value += char;
      present = true;
    }
  }
  // An unfinished quoted value can be a truncated command; do not present it as complete.
  if (present && !quote) tokens.push(value);
  return tokens;
}

/** @param {string} path */
function shortPath(path) {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** Recognize training/evaluation entry points and explain only supplied options.
 * @param {string} command
 */
export function describeTaskCommand(command) {
  const tokens = commandTokens(command);
  const executable = shortPath(tokens[0] || "");
  const scriptIndex = tokens.findIndex((token) => /\.py$/.test(token));
  const isSftScript = scriptIndex >= 0 && /(?:^|\/)swift\/cli\/sft\.py$/.test(tokens[scriptIndex]);
  const python = /^python(?:\d+(?:\.\d+)*)?$/.test(executable);
  const launcher = ["torchrun", "deepspeed", "accelerate"].includes(executable);
  const moduleIndex = python ? tokens.indexOf("-m") : -1;
  const isSftModule = moduleIndex >= 0 && (scriptIndex < 0 || scriptIndex > moduleIndex) && tokens[moduleIndex + 1] === "swift.cli.sft";
  const evalIndex = tokens.findIndex((token, index) => token === "lmms_eval" && ["-m", "--module"].includes(tokens[index - 1]));
  const moduleLauncher = moduleIndex >= 0 && ["accelerate.commands.launch", "torch.distributed.run", "torch.distributed.launch"].includes(tokens[moduleIndex + 1]);
  const isEvaluation = evalIndex >= 0 && (scriptIndex < 0 || scriptIndex > evalIndex) && (
    (python && (evalIndex === moduleIndex + 1 || moduleLauncher)) ||
    (executable === "accelerate" && tokens[1] === "launch") || executable === "torchrun"
  );
  if (tokens.includes("-c") || !(isEvaluation || isSftModule || (isSftScript && (scriptIndex === 0 || python || launcher)))) return null;
  if (isSftScript && scriptIndex > 0 && tokens[scriptIndex - 1].startsWith("--")) return null;

  const start = isEvaluation ? evalIndex + 1 : isSftModule ? moduleIndex + 2 : scriptIndex + 1;
  /** @type {Map<string, string[]>} */
  const options = new Map();
  for (let index = start; index < tokens.length; index++) {
    const match = tokens[index].match(/^--([\w-]+)(?:=(.*))?$/s);
    if (!match) continue;
    const key = match[1].replaceAll("-", "_");
    const values = match[2] == null ? [] : [match[2]];
    while (index + 1 < tokens.length && !tokens[index + 1].startsWith("--")) values.push(tokens[++index]);
    options.set(key, values);
  }
  /** @param {string} key */
  const get = (key) => options.get(key)?.join(" ").trim() || "";
  /** @param {string} key */
  const bool = (key) => {
    if (!options.has(key)) return null;
    const value = get(key).toLowerCase();
    if (["", "true", "1", "yes"].includes(value)) return true;
    if (["false", "0", "no"].includes(value)) return false;
    return null;
  };
  if (isEvaluation) {
    // Keep evaluation summaries deliberately short: model, benchmarks, a few run settings.
    const modelArgs = new Map(get("model_args").split(/,(?=\s*[A-Za-z_]\w*\s*=)/).map((argument) => {
      const separator = argument.indexOf("=");
      return separator < 0 ? ["", ""] : [argument.slice(0, separator).trim(), argument.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/s, "$2")];
    }));
    const model = modelArgs.get("pretrained") || "";
    const modelName = /^checkpoint-\d+$/.test(shortPath(model)) ? model.replace(/\/+$/, "").split("/").slice(-2).join("/") : shortPath(model);
    return {
      kind: "评测任务", modelType: get("model") || "模型类型未提供", model, modelName,
      evaluationTasks: [...new Set((options.get("tasks") || []).flatMap((value) => value.split(/[,\s]+/)).filter(Boolean))],
      parameters: [["批大小", get("batch_size")], ["Few-shot", get("num_fewshot")], ["样本限制（limit）", get("limit")]]
        .filter(([, value]) => value).map(([label, value]) => ({ label, value })),
      frozen: [], datasets: [], plugins: [], outputDir: "",
    };
  }
  const modelType = get("model_type");
  const model = get("model");
  const tuning = get("tuner_type") || get("train_type") || get("sft_type");
  /** @type {{ label: string, value: string }[]} */
  const parameters = [];
  /** @param {string} label @param {string} value */
  const add = (label, value) => { if (value) parameters.push({ label, value }); };
  const tuningNames = new Map([["full", "全参数微调（full）"], ["lora", "LoRA 微调"], ["qlora", "QLoRA 微调"]]);
  add("训练方式", tuningNames.get(tuning) || tuning);
  add("对话模板", get("template"));
  add("训练轮数", get("num_train_epochs"));
  add("最大步数", get("max_steps"));
  add("学习率", get("learning_rate"));
  add("每卡批大小", get("per_device_train_batch_size"));
  add("梯度累积步数", get("gradient_accumulation_steps"));
  add("最大序列长度", get("max_length"));
  add("计算精度", get("torch_dtype") || get("dtype"));
  for (const [key, label] of [["bf16", "BF16"], ["fp16", "FP16"], ["gradient_checkpointing", "梯度检查点"], ["packing", "样本打包"]]) {
    const value = bool(key);
    if (value != null) add(label, value ? "启用" : "关闭");
  }
  add("注意力实现", get("attn_impl"));
  add("DeepSpeed", get("deepspeed"));
  add("序列并行数", get("sequence_parallel_size"));
  add("优化器", get("optim"));
  add("学习率调度", get("lr_scheduler_type"));
  add("预热比例", get("warmup_ratio"));
  add("权重衰减", get("weight_decay"));
  add("保存策略", get("save_strategy"));
  add("保存间隔（步）", get("save_steps"));
  add("保留检查点数", get("save_total_limit"));
  add("随机种子", get("seed"));
  const frozen = [];
  for (const [key, label] of [["freeze_llm", "语言模型"], ["freeze_vit", "视觉编码器"], ["freeze_aligner", "对齐层"]]) {
    const value = bool(key);
    if (value != null) frozen.push(`${label}${value ? "冻结" : "不冻结"}`);
  }
  const datasets = (options.get("dataset") || []).filter(Boolean).map((path) => ({ name: shortPath(path), path }));
  const plugins = (options.get("external_plugins") || []).filter(Boolean).map((path) => ({ name: shortPath(path), path }));
  return {
    kind: "训练任务", modelType: modelType || "模型类型未提供", model, modelName: shortPath(model),
    parameters, frozen, datasets, plugins, outputDir: get("output_dir"), evaluationTasks: [],
  };
}
