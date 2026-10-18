import assert from "node:assert/strict";
import test from "node:test";
import { describeTaskCommand } from "../lib/task-description.mjs";
import { parseProbe } from "../server.mjs";
import { summarizeMyTasks, summarizeNodeTaskDescriptions } from "../lib/my-tasks.mjs";

const script = "/shared/alice/project/ms-swift/swift/cli/sft.py";
const entry = `/envs/train/bin/python -u ${script}`;

test("node summaries merge identical descriptions, preserve distinct evaluations and flag uncertain processes", () => {
  const evaluation = describeTaskCommand('python -m lmms_eval --model qwen2_5_vl --tasks mme');
  const otherEvaluation = describeTaskCommand('python -m lmms_eval --model qwen2_5_vl --tasks ocrbench');
  const training = describeTaskCommand(`${entry} --model_type internvl_chat`);
  const summaries = summarizeNodeTaskDescriptions([
    { description: evaluation, gpuIndices: [2, 0], uncertain: false },
    { description: evaluation, gpuIndices: [2, 3], uncertain: true },
    { description: otherEvaluation, gpuIndices: [4], uncertain: false },
    { description: training, gpuIndices: [5], uncertain: false },
    { description: null, gpuIndices: [6], uncertain: false },
  ]);
  assert.equal(summaries.length, 3);
  assert.deepEqual(summaries[0].gpuIndices, [0, 2, 3]);
  assert.equal(summaries[0].processCount, 2);
  assert.equal(summaries[0].uncertainCount, 1);
  assert.deepEqual(summaries[1].description.evaluationTasks, ["ocrbench"]);
  assert.equal(summaries[2].description.kind, "训练任务");
});

test("overview timing reports earliest process and longest duration without hiding estimates or unknowns", () => {
  const description = describeTaskCommand('python -m lmms_eval --model qwen2_5_vl');
  const task = (startedAt, durationSeconds, source = "process") => ({ description, gpuIndices: [0], uncertain: false, timing: { startedAt, source }, durationSeconds });
  const [summary] = summarizeNodeTaskDescriptions([
    task("2026-09-22T10:00:00+08:00", 0),
    task("2026-09-22T01:00:00Z", 3600, "estimated"),
    task(null, null, null),
  ]);
  assert.equal(summary.earliestStartedAt, "2026-09-22T01:00:00Z");
  assert.equal(summary.longestDurationSeconds, 3600);
  assert.equal(summary.estimatedTiming, true);
  assert.equal(summary.missingTimingCount, 1);
  const [fresh] = summarizeNodeTaskDescriptions([task("2026-09-22T10:00:00+08:00", 0)]);
  assert.equal(fresh.longestDurationSeconds, 0);
  assert.equal(fresh.estimatedTiming, false);
  const [unknown] = summarizeNodeTaskDescriptions([task(null, null, null)]);
  assert.equal(unknown.earliestStartedAt, null);
  assert.equal(unknown.longestDurationSeconds, null);
});

test("summarizes lmms_eval with model, checkpoint, benchmarks and only key run options", () => {
  const description = describeTaskCommand('/envs/eval/bin/python -m lmms_eval --model qwen2_5_vl --model_args pretrained=/models/Qwen2.5-VL-7B-Instruct,device_map=auto,max_num_frames=32 --tasks mme,mmmu_val,ocrbench --batch_size 1 --num_fewshot 0 --limit 100 --output_path /outputs/eval --log_samples');
  assert.equal(description.kind, "评测任务");
  assert.equal(description.modelType, "qwen2_5_vl");
  assert.equal(description.modelName, "Qwen2.5-VL-7B-Instruct");
  assert.deepEqual(description.evaluationTasks, ["mme", "mmmu_val", "ocrbench"]);
  assert.deepEqual(description.parameters, [{ label: "批大小", value: "1" }, { label: "Few-shot", value: "0" }, { label: "样本限制（limit）", value: "100" }]);
  assert.equal(description.outputDir, "");
});

test("recognizes evaluation launchers, quoted checkpoints and equal-form options", () => {
  for (const entry of ["python3.12 -m lmms_eval", "accelerate launch --num_processes 8 -m lmms_eval", "python -m accelerate.commands.launch --num_processes 8 -m lmms_eval", "torchrun --nproc_per_node 8 --module lmms_eval"]) {
    const description = describeTaskCommand(`${entry} --model=qwen2_5_vl --model_args="pretrained=/models/my experiment/checkpoint-300,device_map=auto" --tasks='mme,ocrbench,mme'`);
    assert.equal(description.kind, "评测任务", entry);
    assert.equal(description.modelName, "my experiment/checkpoint-300");
    assert.deepEqual(description.evaluationTasks, ["mme", "ocrbench"]);
  }
});

test("evaluation recognition avoids unrelated scripts and does not invent missing options", () => {
  for (const command of ["python train.py -m lmms_eval --model qwen2_5_vl", "echo -m lmms_eval --model qwen2_5_vl", "python -m unrelated --note '-m lmms_eval'", "python -m lmms_eval_tools --model qwen2_5_vl"]) assert.equal(describeTaskCommand(command), null, command);
  const description = describeTaskCommand("python -m lmms_eval --model qwen2_5_vl");
  assert.equal(description.modelType, "qwen2_5_vl");
  assert.deepEqual(description.evaluationTasks, []);
  assert.deepEqual(description.parameters, []);
  assert.equal(description.modelName, "");
});

test("explains an ms-swift SFT task from its actual model, training, freezing and dataset options", () => {
  const description = describeTaskCommand(`${entry} --model /models/InternVL2-2B --model_type internvl_chat --template custom_internvl2 --tuner_type full --freeze_llm false --freeze_vit true --freeze_aligner false --num_train_epochs 1 --learning_rate 2e-6 --per_device_train_batch_size 1 --gradient_accumulation_steps 16 --max_length 8192 --torch_dtype bfloat16 --bf16 true --fp16 false --deepspeed zero2 --gradient_checkpointing true --lr_scheduler_type cosine --warmup_ratio 0.03 --save_steps 300 --external_plugins /plugins/custom_sft.py --output_dir /outputs/experiment/20260922 --dataset /datasets/grounding.jsonl#5336 /datasets/video.jsonl#81804`);
  assert.equal(description.kind, "训练任务");
  assert.equal(description.modelType, "internvl_chat");
  assert.equal(description.modelName, "InternVL2-2B");
  const parameters = Object.fromEntries(description.parameters.map(({ label, value }) => [label, value]));
  assert.equal(parameters["训练方式"], "全参数微调（full）");
  assert.equal(parameters["每卡批大小"], "1");
  assert.equal(parameters["梯度累积步数"], "16");
  assert.equal(parameters["学习率"], "2e-6");
  assert.equal(parameters["最大序列长度"], "8192");
  assert.equal(parameters["FP16"], "关闭");
  assert.equal(parameters["DeepSpeed"], "zero2");
  assert.deepEqual(description.frozen, ["语言模型不冻结", "视觉编码器冻结", "对齐层不冻结"]);
  assert.deepEqual(description.datasets.map((dataset) => dataset.name), ["grounding.jsonl#5336", "video.jsonl#81804"]);
  assert.equal(description.plugins[0].name, "custom_sft.py");
  assert.equal(description.outputDir, "/outputs/experiment/20260922");
});

test("supports equal signs, quoted paths, hyphenated flags, duplicate options and module launch", () => {
  const description = describeTaskCommand(`python3.12 -m swift.cli.sft --model='/models/Model With Spaces/' --model-type=custom --train_type=lora --learning_rate 1e-5 --learning-rate=2e-5 --freeze_vit=False --gradient_checkpointing --output_dir="/outputs/a b" --dataset '/data/a b.jsonl#12' /data/c.jsonl --gradient_checkpointing_kwargs '{"use_reentrant": false}'`);
  assert.equal(description.modelName, "Model With Spaces");
  assert.equal(description.modelType, "custom");
  assert.equal(description.outputDir, "/outputs/a b");
  assert.equal(description.datasets[0].path, "/data/a b.jsonl#12");
  assert.equal(description.parameters.find((item) => item.label === "学习率").value, "2e-5");
  assert.equal(description.parameters.find((item) => item.label === "梯度检查点").value, "启用");
  assert.deepEqual(description.frozen, ["视觉编码器不冻结"]);
});

test("does not misclassify scripts, arguments, or inline code as SFT training", () => {
  for (const command of ["python train.py --model_type internvl_chat", `cat ${script}`, `python inspect.py --file ${script}`, `python -c 'print("${script}")'`, `python --config ${script}`, "python /other/sft.py --model_type custom", ""]) {
    assert.equal(describeTaskCommand(command), null, command);
  }
  assert.equal(describeTaskCommand(`torchrun --nproc_per_node 8 ${script} --model_type custom`).kind, "训练任务");
});

test("missing and incomplete parameters stay unknown without inventing defaults", () => {
  const description = describeTaskCommand(`${entry} --model_type --learning_rate --dataset "/unfinished`);
  assert.equal(description.modelType, "模型类型未提供");
  assert.deepEqual(description.parameters, []);
  assert.deepEqual(description.datasets, []);
  assert.deepEqual(description.frozen, []);
  assert.equal(description.modelName, "");
  assert.equal(describeTaskCommand(`${entry} --tuner_type __proto__`).parameters[0].value, "__proto__");
});

test("preserves full matching commands so parameters after a capped workload are described", () => {
  const prefix = `${entry} --model_type internvl_chat --model /models/InternVL2-2B`;
  const command = `${prefix} --output_dir /outputs/experiment --learning_rate 2e-6 --dataset /data/train.jsonl`;
  const output = ["__WATCH4GPU_HOST__", "test-host", "__WATCH4GPU_GPUS__", "0, Test GPU, GPU-0, 40, 50, 2000, 80000, 100, 400", "__WATCH4GPU_PROCESSES__", "GPU-0, 123, python, 2000", "__WATCH4GPU_OWNERS__", `alice 123 01:00:00 ${command}`, "__WATCH4GPU_WORKLOADS__", `alice\t123\t1\t123\t123\t01:00:00\t123\t/shared/alice/project\t0\t0\t0\t1\t${prefix}`, "__WATCH4GPU_NAMESPACES__", "__WATCH4GPU_DEVICES__", "__WATCH4GPU_DEVICE_PROCESSES__", "__WATCH4GPU_DONE__"].join("\n");
  const parsed = parseProbe(output, "2026-09-22T01:00:00Z");
  assert.equal(parsed.gpus[0].processes[0].command, command);
  const groups = summarizeMyTasks([{ id: "a", name: "Node A", enabled: true }], { a: { ...parsed, ok: true, checkedAt: "2026-09-22T01:00:00Z" } }, new Set(["alice"]), Date.parse("2026-09-22T01:00:00Z"), 75000);
  assert.equal(groups[0].tasks[0].description.datasets[0].path, "/data/train.jsonl");
  assert.equal(groups[0].tasks[0].description.parameters.find((item) => item.label === "学习率").value, "2e-6");
});
