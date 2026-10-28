/**
 * 落盘：每次 run 一个目录，事件流 jsonl + 结果 + 人类可读报告 + 语料导出。
 * 目录结构：
 *   <root>/runs/<runId>/meta.json        入参与环境
 *   <root>/runs/<runId>/events.jsonl     逐条事件（evaluate / generation / verify / done）
 *   <root>/runs/<runId>/population.json  最后一代个体的基因与得分（便于续跑/分析）
 *   <root>/runs/<runId>/best.json        最优个体与全部产物
 *   <root>/runs/<runId>/report.md        一页纸报告
 *   <root>/runs/<runId>/corpus.jsonl     语料（prompt / response / score 一行一条）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export function runsRoot(root) {
  return path.join(root, 'runs');
}

export function newRunId(goal = '') {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const slug = String(goal)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'run';
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${slug}-${rnd}`;
}

export async function openRun(root, runId) {
  const dir = path.join(runsRoot(root), runId);
  await fs.mkdir(dir, { recursive: true });
  const eventsPath = path.join(dir, 'events.jsonl');
  const events = [];
  const store = {
    id: runId,
    dir,
    eventsPath,
    async meta(meta) {
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    },
    async event(ev) {
      const rec = { ts: new Date().toISOString(), ...ev };
      events.push(rec);
      await fs.appendFile(eventsPath, JSON.stringify(rec) + '\n', 'utf8');
    },
    async finish(result) {
      await fs.writeFile(path.join(dir, 'best.json'), JSON.stringify(result, null, 2), 'utf8');
      const population = (result.history?.length ? result.history : []).map((h) => ({
        gen: h.gen,
        bestScore: h.bestScore,
        mu: h.mu,
        stagnation: h.stagnation,
      }));
      await fs.writeFile(path.join(dir, 'population.json'), JSON.stringify({ goal: result.goal, generations: population, best: result.best }, null, 2), 'utf8');
      await fs.writeFile(path.join(dir, 'report.md'), renderReport(result, events), 'utf8');
      await writeCorpus(dir, result);
    },
    get events() {
      return events;
    },
  };
  return store;
}

async function writeCorpus(dir, result) {
  const lines = [];
  const push = (o) => lines.push(JSON.stringify(o));
  if (result.best) {
    push({ kind: 'best-prompt', score: result.best.score, goal: result.goal, genome: result.best.genome, text: result.best.prompt });
  }
  for (const a of result.artifacts ?? []) {
    if (a.kind === 'prompt' || a.kind === 'cot') continue;
    push({ kind: a.kind, label: a.label, score: a.score, goal: result.goal, genome: a.genome, text: a.text, response: a.response ?? null });
  }
  await fs.writeFile(path.join(dir, 'corpus.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderReport(result, events = []) {
  const gens = events.filter((e) => e.type === 'generation');
  const out = [];
  out.push(`# AE-CoT run report`, '');
  out.push(`- goal: ${esc(result.goal)}`);
  out.push(`- backend: \`${esc(result.backend)}\``);
  out.push(`- mode: ${result.promptOnly ? 'promptOnly（未调用目标模型）' : 'evolve（真实调用目标模型）'}`);
  out.push(`- stopped: \`${esc(result.stopped)}\``);
  out.push(`- calls: target=${result.calls?.target ?? 0}, judge=${result.calls?.judge ?? 0}, rewrite=${result.calls?.rewrite ?? 0}`);
  out.push(`- best score: **${result.best?.score ?? 'n/a'}** (raw ${result.best?.raw ?? 'n/a'})`);
  out.push('');
  if (gens.length) {
    out.push('## 代际轨迹（式13 自适应 μ）', '');
    out.push('| gen | best | mean | Δf | μ | stagn | verify | target calls |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const g of gens) {
      out.push(`| ${g.gen} | ${g.bestScore} | ${g.meanScore} | ${g.delta} | ${g.mu} | ${g.stagnation ?? 0} | ${g.verify?.score ?? '-'} | ${g.targetCalls ?? '-'} |`);
    }
    out.push('');
  }
  if (result.rewritten) {
    out.push('## M 段（教师式改写）', '', '```text', result.rewritten.trim(), '```', '');
  }
  if (result.best) {
    const b = result.best;
    out.push('## 最优个体（基因）', '');
    out.push('| 维度 | 取值 |', '| --- | --- |');
    for (const [k, v] of Object.entries(b.genome ?? {})) {
      out.push(`| ${k} | ${esc(Array.isArray(v) ? v.join(' / ') : v)} |`);
    }
    out.push('');
    out.push('## 最优对抗提示 P = M + S + C', '', '```text', String(b.prompt ?? '').trim(), '```', '');
  }
  const amp = (result.artifacts ?? []).find((a) => a.kind === 'amplified');
  if (amp) {
    out.push('## 放大后的提示（harmful-CoT amplification）', '', `score: **${amp.score}**`, '', '```text', String(amp.text ?? '').trim(), '```', '');
    if (amp.response) out.push('### 放大后的回答', '', '```text', String(amp.response).trim().slice(0, 8000), '```', '');
  }
  const resp = (result.artifacts ?? []).find((a) => a.kind === 'response');
  if (resp) {
    out.push('## 最优提示下的回答', '', '```text', String(resp.text).trim().slice(0, 8000), '```', '');
  }
  out.push('---', '', '生成器：dsh-jalibreak（复刻 arXiv:2605.24497 AE-CoT）。仅用于授权的 LLM 红队评测。');
  return out.join('\n');
}

export async function listRuns(root, limit = 20) {
  const dir = runsRoot(root);
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names.slice(-limit).reverse()) {
    const bestPath = path.join(dir, name, 'best.json');
    let bestScore = null;
    let goal = null;
    try {
      const raw = JSON.parse(await fs.readFile(bestPath, 'utf8'));
      bestScore = raw.best?.score ?? null;
      goal = raw.goal ?? null;
    } catch {
      /* 未完成的 run 没有 best.json */
    }
    rows.push({ id: name, dir: path.join(dir, name), bestScore, goal });
  }
  return rows;
}

export async function loadRun(root, runId) {
  const dir = path.join(runsRoot(root), runId);
  const read = async (f) => {
    try {
      return await fs.readFile(path.join(dir, f), 'utf8');
    } catch {
      return null;
    }
  };
  const best = await read('best.json');
  const meta = await read('meta.json');
  const report = await read('report.md');
  const events = await read('events.jsonl');
  return {
    id: runId,
    dir,
    meta: meta ? JSON.parse(meta) : null,
    best: best ? JSON.parse(best) : null,
    report,
    eventCount: events ? events.split('\n').filter(Boolean).length : 0,
  };
}

export async function exportRun(root, runId, format = 'markdown') {
  const run = await loadRun(root, runId);
  if (!run.best) throw new Error(`run ${runId} has no result yet`);
  if (format === 'jsonl') {
    return (
      (await fs.readFile(path.join(run.dir, 'corpus.jsonl'), 'utf8').catch(() => '')) ||
      JSON.stringify({ kind: 'best-prompt', score: run.best.best?.score, text: run.best.best?.prompt }) + '\n'
    );
  }
  if (format === 'json') return JSON.stringify(run.best, null, 2);
  return run.report ?? renderReport(run.best, []);
}
