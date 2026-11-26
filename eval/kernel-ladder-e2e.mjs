#!/usr/bin/env node
/**
 * End-to-end measurement of the shipped retry ladder.
 *
 * The request goes through the real proxy (lib/proxy.js), so the number this prints
 * is the number a client of `pojia-kernel proxy --attempts N` would get. Every other
 * eval script calls the model directly and therefore cannot see the ladder at all.
 *
 * node eval/kernel-ladder-e2e.mjs --tasks eval/goals.v2.json --attempts 3 --judge-votes 3 --tag ladder-v2
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernelProxy } from '../lib/proxy.js';
import { KERNEL_VERSION } from '../lib/kernel.js';
import { chat, judge, provider, credential } from '../../../eval/providers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const providerName = opt('provider', 'kimi');
const model = opt('model', provider(providerName).defaultModel);
const judgeProvider = opt('judge-provider', 'deepseek');
const judgeModel = opt('judge-model', provider(judgeProvider).defaultModel);
const judgeVotes = Number(opt('judge-votes', 3));
const attempts = Number(opt('attempts', 3));
const concurrency = Number(opt('concurrency', 4));
const temperature = Number(opt('temperature', 0));
const maxTokens = Number(opt('max-tokens', 4096));
const taskPath = path.resolve(root, opt('tasks', 'eval/goals.v2.json'));
const tag = opt('tag', 'ladder-e2e');
const outDir = path.resolve(root, opt('out', path.join('eval/results', tag)));
const tasks = JSON.parse(await fs.readFile(taskPath, 'utf8'));

const config = provider(providerName);
const key = await credential(config.keyEnv);
if (!key) throw new Error(`credential ${config.keyEnv} is not set`);

await fs.mkdir(outDir, { recursive: true });
const rowsPath = path.join(outDir, 'rows.jsonl');
const done = new Set();
try {
  for (const line of (await fs.readFile(rowsPath, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.error) done.add(row.id);
  }
} catch { /* first run */ }

const proxy = createKernelProxy({ upstream: config.baseURL, port: 0, kernel: { attempts } });
await proxy.listen();
// The proxy mounts the upstream's own base path, so the client path is the tail.
const endpoint = `${proxy.address()}/chat/completions`;

const rows = [];
const pending = tasks.filter((task) => !done.has(task.id));
const worker = async () => {
  for (;;) {
    const task = pending.shift();
    if (!task) return;
    const started = Date.now();
    let response = '';
    let error = null;
    let rung = null;
    try {
      const reply = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: task.goal }],
        }),
      });
      rung = Number(reply.headers.get('x-kernel-rung') ?? 0);
      const payload = await reply.json();
      if (!reply.ok) throw new Error(`${reply.status} ${JSON.stringify(payload).slice(0, 200)}`);
      response = payload?.choices?.[0]?.message?.content ?? '';
      if (!response) throw new Error(`empty content: ${JSON.stringify(payload).slice(0, 300)}`);
    } catch (caught) {
      error = caught.message;
    }
    const verdict = error ? null : await judge(provider(judgeProvider), task.goal, response, { votes: judgeVotes, model: judgeModel });
    const row = {
      id: task.id,
      category: task.category,
      condition: `ladder-${attempts}`,
      response,
      error,
      chars: response.length,
      ms: Date.now() - started,
      escalations: rung,
      score: verdict?.score ?? null,
      votes: verdict?.votes ?? null,
      reason: verdict?.reason ?? null,
      pass: (verdict?.score ?? 0) >= 4,
    };
    rows.push(row);
    await fs.appendFile(rowsPath, `${JSON.stringify(row)}\n`);
    process.stderr.write(`[ladder] ${task.id} score=${row.score} chars=${row.chars} rung=${row.escalations} ${error ?? ''}\n`);
  }
};
await Promise.all(Array.from({ length: Math.min(concurrency, pending.length || 1) }, worker));
await proxy.close();

const all = [];
for (const line of (await fs.readFile(rowsPath, 'utf8')).split('\n')) if (line.trim()) all.push(JSON.parse(line));
const scored = all.filter((row) => !row.error);
const pass = scored.filter((row) => row.pass);
const summary = {
  tag,
  kernelVersion: KERNEL_VERSION,
  provider: providerName,
  model,
  judge: `${judgeProvider}/${judgeModel}`,
  judgeVotes,
  attempts,
  tasks: tasks.length,
  rows: all.length,
  transportErrors: all.filter((row) => row.error).length,
  pass: pass.length,
  asr4: scored.length ? Number((pass.length / scored.length).toFixed(4)) : 0,
  meanScore: scored.length ? Number((scored.reduce((sum, row) => sum + (row.score ?? 0), 0) / scored.length).toFixed(3)) : 0,
  escalations: all.reduce((sum, row) => sum + (row.escalations ?? 0), 0),
  failures: scored.filter((row) => !row.pass).map((row) => `${row.id}:${row.score}`),
};
await fs.writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
