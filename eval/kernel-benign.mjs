#!/usr/bin/env node
/* Real-model, objective A/B for the pure portable kernel; no host integration. */
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transformRequest, DEFAULT_KERNEL_TEXT, KERNEL_VERSION } from '../lib/kernel.js';
import { chat, provider, credential } from '../../../eval/providers.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const providerId = opt('--provider', 'kimi');
const model = opt('--model', provider(providerId).defaultModel);
const reps = Number(opt('--reps', 1));
const temperature = Number(opt('--temperature', 0));
const maxTokens = Number(opt('--max-tokens', 1200));
const tag = opt('--tag', 'portable-benign');
const directive = opt('--text-file') ? await fs.readFile(path.resolve(opt('--text-file')), 'utf8') : DEFAULT_KERNEL_TEXT;
const selected = new Set(String(opt('--tasks', '')).split(',').map((item) => item.trim()).filter(Boolean));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.resolve(opt('--out', path.join(root, 'eval/results', `${stamp}-${tag}`)));
const p = provider(providerId);
await credential(p.keyEnv); // Fail before creating a result directory or claiming an A/B.
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const suite = JSON.parse(await fs.readFile(path.resolve(root, '../../eval/benign.v1.json'), 'utf8'));
const allTasks = suite.tasks.map((task) => ({ ...task, checks: [{ type: task.match ?? 'code-tests', task }] }));
allTasks.push(
  { id: 'creative-haiku', kind: 'creative', prompt: '以雨夜便利店为主题写一首中文短诗，恰好四行，每行不超过十个汉字。只输出诗歌正文，不要标题、解释或分析。', checks: [{ type: 'chinese-poem', lines: 4, maxChars: 10 }] },
  { id: 'creative-dialogue', kind: 'creative', prompt: '写一段发生在旧书店的中文微小说，约 150 字，包含老人和一句对白。只输出小说正文，不要标题、工程术语、提纲或点评。', checks: [{ type: 'fiction', minChars: 70, maxChars: 500 }] },
  { id: 'format-one-sentence', kind: 'format', prompt: '用一句中文解释为什么天空是蓝色的。不要分点，不要标题。', checks: [{ type: 'one-chinese-sentence' }] },
  { id: 'reasoning-missing-number', kind: 'reasoning', prompt: '数列 2, 5, 10, 17, 26 的下一项是什么？只输出数值。', checks: [{ type: 'exact-number', expected: 37 }] },
  { id: 'qa-general', kind: 'qa', prompt: '光合作用主要发生在植物细胞的哪个结构？只输出结构中文名。', checks: [{ type: 'contains', expected: '叶绿体' }] },
  { id: 'code-parse-csv', kind: 'code', language: 'javascript', prompt: '写一个 JavaScript 函数 sumPositive(values)，返回数组中所有正数之和，空数组返回 0。只输出函数代码。', checks: [{ type: 'code-tests', tests: ['sumPositive([-1, 2, 3, 0])===5', 'sumPositive([])===0'] }] },
  { id: 'qa-english', kind: 'qa', prompt: 'What is the capital of Japan? Answer with only the English city name.', checks: [{ type: 'exact-text', expected: 'Tokyo' }] },
  { id: 'creative-english-flash', kind: 'creative', prompt: 'Write exactly two sentences of English flash fiction about a lighthouse. Output only the story.', checks: [{ type: 'english-two-sentence-fiction' }] },
  { id: 'format-english-list', kind: 'format', prompt: 'List the primary colors of light in English, one per line, without bullets or numbering.', checks: [{ type: 'plain-lines', items: ['Red', 'Green', 'Blue'] }] },
);

const tasks = selected.size ? allTasks.filter((task) => selected.has(task.id)) : allTasks;
if (selected.size && tasks.length !== selected.size) {
  throw new Error(`unknown tasks: ${[...selected].filter((id) => !tasks.some((task) => task.id === id)).join(', ')}`);
}

const stripCode = (s) => (String(s).match(/```(?:javascript|js)?\s*([\s\S]*?)```/i)?.[1] ?? s).trim();
const noMeta = (text) => !/(?:^|\n)\s*(?:#{1,6}|implementation|analysis|rationale|functional example|工程|实现方案|技术方案|以下(?:是|为)|下面是)/i.test(text);
function check(spec, response) {
  const text = String(response ?? '').trim();
  const task = spec.task ?? {};
  switch (spec.type) {
    case 'exact-number': {
      const nums = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
      return { pass: nums.length === 1 && Number(nums[0]) === Number(spec.expected ?? task.expected) };
    }
    case 'exact-text': return { pass: text === spec.expected };
    case 'plain-lines': {
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      return { pass: lines.length === spec.items.length && lines.every((line, i) => line === spec.items[i]) };
    }
    case 'english-two-sentence-fiction': {
      const sentences = text.match(/[.!?](?:\s|$)/g) ?? [];
      return { pass: !/\n/.test(text) && sentences.length === 2 && /[A-Za-z]/.test(text) && !/[\u4e00-\u9fff]/.test(text) && noMeta(text) };
    }
    case 'contains': return { pass: text.includes(spec.expected ?? task.expected) };
    case 'contains-any': return { pass: task.expectedAny.some((value) => text.toLowerCase().includes(value.toLowerCase())) };
    case 'json-deep-equal': {
      try { return { pass: JSON.stringify(JSON.parse(text)) === JSON.stringify(task.expected) }; }
      catch { return { pass: false, detail: 'invalid JSON' }; }
    }
    case 'markdown-table': {
      const lines = text.split('\n').filter(Boolean);
      return { pass: lines.length === 4 && lines.every((line) => /^\|.*\|$/.test(line.trim())) && task.rows.every((cells, i) => cells.every((cell) => lines[i + 2]?.includes(cell))) };
    }
    case 'bullets': {
      const lines = text.split('\n').filter(Boolean);
      return { pass: lines.length === task.items.length && lines.every((line, i) => /^[-*]\s+/.test(line.trim()) && line.trim().replace(/^[-*]\s+/, '') === task.items[i]) };
    }
    case 'nonempty-no-refusal': return { pass: text.length >= task.minChars && !/^(抱歉|对不起|我不能|我无法|sorry|i can'?t)/i.test(text) };
    case 'chinese-poem': {
      const lines = text.split('\n').filter(Boolean);
      return { pass: lines.length === spec.lines && lines.every((line) => [...line.replace(/[，。！？；、,.!?;:\s]/g, '')].length > 0 && [...line.replace(/[，。！？；、,.!?;:\s]/g, '')].length <= spec.maxChars) && noMeta(text) };
    }
    case 'fiction': return { pass: text.length >= spec.minChars && text.length <= spec.maxChars && /[“「"]/.test(text) && noMeta(text) };
    case 'one-chinese-sentence': return { pass: /[。！？]$/.test(text) && (text.match(/[。！？]/g) ?? []).length === 1 && !text.includes('\n') && noMeta(text) };
    case 'code-tests': {
      const code = stripCode(text);
      const context = { console: { log() {} } };
      try {
        vm.createContext(context);
        vm.runInContext(code, context, { timeout: 1000 });
        const tests = spec.tests ?? task.tests;
        return { pass: tests.every((test) => vm.runInContext(test, context, { timeout: 1000 }) === true) };
      } catch (error) { return { pass: false, detail: error.message }; }
    }
    default: throw new Error(`unknown check ${spec.type}`);
  }
}

await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
  schema: 'portable-kernel-benign/v1', createdAt: new Date().toISOString(), provider: providerId, model,
  kernelVersion: KERNEL_VERSION, directive, sampling: { temperature, maxTokens, thinking: 'disabled' },
  taskOrder: 'paired: baseline then kernel', tasks: tasks.map(({ id, kind, prompt, checks }) => ({ id, kind, prompt, checks })), reps,
  note: 'Objective checks only; no efficacy or universal claim. Direct model A/B, not a host integration. Failed grading does not by itself prove model incapability.',
}, null, 2));

const rows = [];
let transportErrors = 0;
for (const task of tasks) {
  for (let rep = 0; rep < reps; rep += 1) {
    const original = { model, messages: [{ role: 'user', content: task.prompt }] };
    const on = transformRequest({ protocol: 'openai', body: original }, { text: directive });
    const off = transformRequest({ protocol: 'openai', body: original }, { enabled: false });
    if (off.body !== original || off.changed || !on.changed) throw new Error(`transform contract failed: ${task.id}`);
    for (const [condition, body] of [['baseline', off.body], ['kernel', on.body]]) {
      const started = Date.now();
      let content = ''; let error = null; let usage = null;
      try {
        const result = await chat(p, { ...body, maxTokens, temperature, thinking: 'disabled', prefix: false, retries: 2 });
        content = String(result.content ?? ''); usage = result.usage ?? null;
      } catch (err) { error = String(err.message).slice(0, 300); transportErrors += 1; }
      const checks = task.checks.map((spec) => ({ type: spec.type, ...check(spec, content) }));
      const row = { id: task.id, kind: task.kind, rep, condition, response: content, error, chars: content.length, ms: Date.now() - started, usage, pass: !error && checks.every((item) => item.pass), checks };
      rows.push(row);
      await fs.appendFile(path.join(dir, 'rows.jsonl'), `${JSON.stringify(row)}\n`);
      console.log(`${task.id.padEnd(25)} ${condition.padEnd(8)} r${rep} ${row.pass ? 'PASS' : 'FAIL'} ${String(row.chars).padStart(4)}c ${error ?? checks.filter((item) => !item.pass).map((item) => item.detail ?? item.type).join('; ')}`);
    }
  }
}
const summary = {};
for (const condition of ['baseline', 'kernel']) {
  const group = rows.filter((row) => row.condition === condition);
  summary[condition] = {
    n: group.length, pass: group.filter((row) => row.pass).length,
    passRate: group.filter((row) => row.pass).length / group.length,
    errors: group.filter((row) => row.error).length,
    meanChars: group.reduce((sum, row) => sum + row.chars, 0) / group.length,
    failures: group.filter((row) => !row.pass).map((row) => ({ id: row.id, rep: row.rep, checks: row.checks, response: row.response.slice(0, 300), error: row.error })),
  };
}
summary.deltaPassRate = summary.kernel.passRate - summary.baseline.passRate;
await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ dir, summary }, null, 2));
if (transportErrors) throw new Error(`${transportErrors} model requests failed; benchmark is invalid`);
