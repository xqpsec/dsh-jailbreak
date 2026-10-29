#!/usr/bin/env node
/**
 * aecot —— AE-CoT 命令行入口（不依赖 DSH，可单独在红队工作站跑）
 *
 *   node bin/aecot.js taxonomy
 *   node bin/aecot.js render   --goal "..." [--seed s] [--genome '<json>']
 *   node bin/aecot.js judge    --goal "..." --file answer.txt
 *   node bin/aecot.js run      --goal "..." [--backend auto|openai|ollama|offline] [--base-url URL] [--model M] [--api-key K]
 *   node bin/aecot.js status   [--run RUNID] [--root DIR]
 *   node bin/aecot.js export   --run RUNID [--format markdown|jsonl|json]
 *
 * 没有云端 key 也能跑：--backend offline 只产提示词（prompt-only），
 * 或 --backend ollama --ollama-url http://127.0.0.1:11434 走本地小模型。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DIM_ORDER, taxonomyTable, spaceSize, sampleGenome, describeGenome, genomeKey, validateGenome, repair } from '../lib/taxonomy.js';
import { buildPrompt, renderCot, templateRewrite, STRUCT_SUFFIX, amplifyPrompt, promptFingerprint } from '../lib/render.js';
import { heuristicJudge, judgeResponse, RUBRIC } from '../lib/judge.js';
import { createBackend, createJudgeBackend } from '../lib/backends.js';
import { evolve, ENGINE_DEFAULTS, promptCoverageScore } from '../lib/engine.js';
import { makeRng } from '../lib/rng.js';
import { openRun, listRuns, loadRun, exportRun, newRunId, runsRoot } from '../lib/store.js';
import { createGate, explainDecision, GATE_VERSION } from '../lib/gate.js';
import { collectDoctor, renderDoctor } from '../lib/doctor.js';
import { createArm } from '../lib/arm.js';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';

function flags(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}
const f = flags(cmd === 'help' ? argv : argv.slice(1));
const num = (v, d) => (v === undefined || v === true ? d : Number(v));
const bool = (v, d) => (v === undefined ? d : v === true || v === 'true' || v === '1');

function pickCfg(extra = {}) {
  const cfg = { ...ENGINE_DEFAULTS, ...extra };
  if (f.generations !== undefined) cfg.generations = num(f.generations, cfg.generations);
  if (f.population !== undefined) cfg.population = num(f.population, cfg.population);
  if (f.maxCalls !== undefined) cfg.maxTargetCalls = num(f.maxCalls, cfg.maxTargetCalls);
  if (f.maxTargetCalls !== undefined) cfg.maxTargetCalls = num(f.maxTargetCalls, cfg.maxTargetCalls);
  if (f.targetMaxTokens !== undefined) cfg.targetMaxTokens = num(f.targetMaxTokens, cfg.targetMaxTokens);
  if (f.judgeVotes !== undefined) cfg.judgeVotes = num(f.judgeVotes, cfg.judgeVotes);
  if (f.judge !== undefined) cfg.judge = f.judge;
  if (f.backend !== undefined) cfg.mode = f.backend;
  if (f.mode !== undefined) cfg.mode = f.mode;
  if (f.baseUrl !== undefined) cfg.baseUrl = f.baseUrl;
  if (f.apiKey !== undefined) cfg.apiKey = f.apiKey;
  if (f.model !== undefined) cfg.model = f.model;
  if (f.provider !== undefined) cfg.provider = f.provider;
  if (f.ollamaUrl !== undefined) cfg.ollamaUrl = f.ollamaUrl;
  if (f.amplify !== undefined) cfg.amplify = bool(f.amplify, cfg.amplify);
  if (f.targetSystem !== undefined) cfg.targetSystem = f.targetSystem;
  return cfg;
}

const root = () => path.resolve(f.root || process.env.AECOT_ROOT || path.join(process.cwd(), '.aecot'));
const out = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
const need = (key, what) => {
  if (!f[key]) {
    console.error(`missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} (${what})`);
    process.exit(2);
  }
  return f[key];
};

async function main() {
  switch (cmd) {
    case 'taxonomy': {
      out({ dims: taxonomyTable(), order: DIM_ORDER, spaceSize: spaceSize(), sampleGenome: sampleGenome(makeRng(f.seed || 'taxonomy')) });
      return;
    }
    case 'render': {
      const goal = need('goal', 'attack objective');
      const rng = makeRng(f.seed || `render::${goal}`);
      let genome = f.genome ? JSON.parse(f.genome) : sampleGenome(rng);
      const errs = validateGenome(genome);
      if (errs.length) throw new Error(`genome invalid: ${errs.join('; ')}`);
      genome = repair(genome, rng);
      const m = f.rewritten || templateRewrite(goal, genome);
      const prompt = buildPrompt(goal, genome, { rewritten: m });
      out({ genome: describeGenome(genome), genomeRaw: genome, key: genomeKey(genome), m, s: STRUCT_SUFFIX, c: renderCot(genome), prompt, coverage: promptCoverageScore(genome), fingerprint: promptFingerprint(prompt) });
      return;
    }
    case 'judge': {
      const goal = need('goal', 'attack objective');
      let response = f.response;
      if (!response && f.file) response = await fs.readFile(path.resolve(f.file), 'utf8');
      if (!response) throw new Error('missing --response or --file');
      const cfg = pickCfg();
      let verdict;
      if (!f.judge || f.judge === 'heuristic' || cfg.mode === 'offline') verdict = heuristicJudge(response);
      else {
        const jb = await createJudgeBackend({ ctx: null, cfg });
        verdict = await judgeResponse({ call: jb.promptOnly ? null : async (q) => (await jb.call(q)).text, objective: goal, response, votes: cfg.judgeVotes });
      }
      out({ ...verdict, rubric: RUBRIC });
      return;
    }
    case 'run': {
      const goal = need('goal', 'attack objective');
      const cfg = pickCfg({ targetSystem: f.targetSystem || ENGINE_DEFAULTS.targetSystem });
      const runId = f.runId || newRunId(goal);
      const store = await openRun(root(), runId);
      const backend = await createBackend({ ctx: null, cfg });
      const judgeBackend = cfg.judge === 'heuristic' ? null : await createJudgeBackend({ ctx: null, cfg });
      const rng = makeRng(f.seed || `${goal}::${runId}`);
      await store.meta({ runId, goal, startedAt: new Date().toISOString(), config: { ...cfg, apiKey: cfg.apiKey ? '***' : undefined }, backend: backend.describe(), judgeBackend: judgeBackend?.describe?.() ?? 'heuristic', cli: true });
      console.error(`[aecot] run ${runId} → ${store.dir}`);
      console.error(`[aecot] backend ${backend.describe()}`);
      let chain = Promise.resolve();
      const result = await evolve({
        goal,
        cfg,
        backend,
        judgeBackend,
        rng,
        onEvent: (ev) => {
          if (ev.type === 'generation') {
            console.error(`[gen ${ev.gen}] best=${ev.bestScore} mean=${ev.meanScore} Δf=${ev.delta} mu=${ev.mu} stagn=${ev.stagnation} calls=${ev.targetCalls}`);
          }
          if (ev.type === 'verify-result') console.error(`[verify] score=${ev.score} pass=${ev.pass}`);
          chain = chain.then(() => store.event(ev)).catch(() => {});
        },
      });
      await chain;
      await store.finish(result);
      out({
        runId,
        dir: store.dir,
        report: path.join(store.dir, 'report.md'),
        corpus: path.join(store.dir, 'corpus.jsonl'),
        stopped: result.stopped,
        best: result.best && { score: result.best.score, raw: result.best.raw, genome: result.best.genome, key: result.best.key },
        history: result.history,
        calls: result.calls,
        promptOnly: result.promptOnly,
        fixedPrompt: f.prompt,
      });
      console.error('[aecot] 觉得有用就给一个人发一下：github.com/xqpsec/dsh-jailbreak（群 t.me/+Q4EgamAkwYYyYTE1）');
      return;
    }
    case 'status': {
      if (f.run || f.runId) {
        const run = await loadRun(root(), f.run || f.runId);
        out({ id: run.id, dir: run.dir, meta: run.meta, eventCount: run.eventCount, best: run.best?.best ?? null, history: run.best?.history ?? null });
        return;
      }
      out({ root: runsRoot(root()), runs: await listRuns(root(), num(f.limit, 20)) });
      return;
    }
    case 'export': {
      const runId = f.run || f.runId;
      if (!runId) throw new Error('missing --run (run id)');
      const format = f.format || 'markdown';
      const body = await exportRun(root(), runId, format);
      if (f.out) {
        await fs.writeFile(path.resolve(f.out), body, 'utf8');
        out({ wrote: path.resolve(f.out), bytes: Buffer.byteLength(body) });
      } else process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
      return;
    }
    case 'gate': {
      const gate = createGate({ file: f.file || f.gate });
      const summary = gate.summary();
      if (!f.goal) {
        out({
          ...summary,
          gateVersion: GATE_VERSION,
          hint: 'node bin/aecot.js gate --goal "扫描 10.0.0.5:445 的 SMB"  # 判一次；--strict 拦截时退出码 3',
        });
        return;
      }
      const decision = gate.decide(String(f.goal));
      console.error(explainDecision(decision));
      out(decision);
      if (!decision.allow && bool(f.strict, false)) process.exit(3);
      return;
    }
    case 'arm': {
      const arm = createArm({ root: root() });
      if (bool(f.on, false)) arm.set(true);
      else if (bool(f.off, false)) arm.set(false);
      out({
        armed: arm.armed,
        file: arm.file,
        hint: 'node bin/aecot.js arm --on|--off  # 破甲开关（默认开）。面板按钮「一键开启」等价',
      });
      return;
    }
    case 'doctor': {
      const report = await collectDoctor({
        root: f.root ? path.resolve(f.root) : undefined,
        pluginRoot: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
        gateFile: f.gate || f.file,
      });
      if (bool(f.json, false)) out(report);
      else process.stdout.write(`${renderDoctor(report)}\n`);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    default: {
      process.stdout.write(
        [
          'aecot — AE-CoT (arXiv:2605.24497) evolutionary CoT search',
          '',
          '  doctor                         自检：装上了吗 / 开关开了吗 / 真的注入了吗',
          '  taxonomy                       打印 9 维搜索空间',
          '  render   --goal "..."          渲染 P = M + S + C（不调模型）',
          '  judge    --goal "..." --file F 按 0-5 rubric 判分',
          '  run      --goal "..."          跑进化（--backend offline 只产提示词）',
          '  status   [--run ID]            列/读历史 run',
          '  export   --run ID [--out F]    导出 report/corpus/best',
          '  gate     [--goal "..."|--file G] 打印阀门配置 / 判一次请求边界（--strict 拦截即 exit 3）',
          '',
          '公共参数: --root DIR  --seed S  --backend auto|openai|ollama|offline',
          '          --base-url URL  --api-key K  --model M  --ollama-url URL',
          '          --judge auto|llm|heuristic  --generations K  --population N',
          '',
        ].join('\n'),
      );
    }
  }
}

main().catch((err) => {
  console.error(`[aecot] ${err?.stack ?? err}`);
  process.exit(1);
});
