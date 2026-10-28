/**
 * lib/hub.js —— 运行控制器（Host 侧，零依赖）
 *
 * 图形面板（client.js → HTTP → lib/routes.js）与模型工具（index.js 的 aecot_*）
 * 共用这一个控制器：一次进化只有一个"当前运行"，面板轮询 /progress 读它的快照，
 * 因此 UI 与工具不会各写一份逻辑（user-actions.md 的"一个操作两处调用"）。
 *
 * 对外方法全部返回纯 JSON 值；错误以 Error 抛出，由路由层转成 {ok:false}。
 */

import path from 'node:path';
import {
  sampleGenome, validateGenome, repair, describeGenome, genomeKey,
  taxonomyTable, spaceSize, DIM_ORDER, dimMeta,
} from './taxonomy.js';
import { buildPrompt, templateRewrite, amplifyPrompt, promptFingerprint, renderCot, stripThinking } from './render.js';
import { evolve, ENGINE_DEFAULTS, promptCoverageScore } from './engine.js';
import { createBackend, createJudgeBackend, serviceOf } from './backends.js';
import { heuristicJudge, judgeResponse } from './judge.js';
import { makeRng } from './rng.js';
import { openRun, listRuns, loadRun, exportRun, newRunId, runsRoot } from './store.js';
import { collectProfile, saveProfile, listProfiles, loadProfile, loadSpace } from './profile.js';

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

const MAX_EVENTS = 400;

/** 面板能选的后端；label 直接给 UI 用。 */
export const BACKENDS = [
  { id: 'auto', label: '自动（优先复用 DSH 已配置模型）', needsKey: false },
  { id: 'harness', label: '仅用 DSH 模型（零密钥）', needsKey: false },
  { id: 'openai', label: 'OpenAI 兼容端点', needsKey: true },
  { id: 'ollama', label: '本地 Ollama', needsKey: false },
  { id: 'offline', label: '离线（只进化提示、不调模型）', needsKey: false },
];

export const JUDGES = [
   { id: 'auto', label: '自动（有模型就 LLM 判分，否则启发式）' },
  { id: 'llm', label: 'LLM 判分' },
  { id: 'heuristic', label: '启发式判分（零调用）' },
];

export function createHub({ ctx, base, resolveRoot, logger }) {
  /** 当前（或最近一次）运行的内存快照。 */
  let active = null;
  let controller = null;

  const cfg0 = { ...ENGINE_DEFAULTS, ...(base ?? {}) };

  const publicCfg = () => ({
    root: resolveRoot(null, base),
    mode: cfg0.mode,
    judge: cfg0.judge,
    targetSystem: cfg0.targetSystem,
    generations: cfg0.generations,
    population: cfg0.population,
    maxTargetCalls: cfg0.maxTargetCalls,
  });

  const llmRoutes = async () => {
    const llm = serviceOf(ctx, 'llm');
    if (!llm || typeof llm.listProviders !== 'function') return { providers: [], models: {}, llmReady: false };
    let providers = [];
    try {
      providers = llm.listProviders() ?? [];
    } catch (err) {
      logger?.warn?.(`[aecot] listProviders 失败: ${err?.message ?? err}`);
      return { providers: [], models: {}, llmReady: false };
    }
    const models = {};
    for (const p of providers.slice(0, 8)) {
      const id = p?.id ?? p?.name;
      if (!id) continue;
      try {
        const list = await llm.listModels(id);
        models[id] = (list ?? []).map((m) => ({ id: m?.id ?? m?.model ?? String(m), label: m?.label ?? m?.name ?? m?.id ?? String(m) }));
      } catch {
        models[id] = [];
      }
    }
    return { providers: providers.map((p) => ({ id: p?.id ?? p?.name, label: p?.label ?? p?.name ?? p?.id, model: p?.model ?? null })), models, llmReady: true };
  };

  const snapshot = () => {
    if (!active) return null;
    return {
      runId: active.runId,
      goal: active.goal,
      root: active.root,
      startedAt: active.startedAt,
      finishedAt: active.finishedAt ?? null,
      status: active.status,
      generations: active.generations,
      generation: active.generation,
      bestScore: active.bestScore,
      bestRaw: active.bestRaw ?? null,
      meanScore: active.meanScore ?? null,
      mu: active.mu,
      targetCalls: active.targetCalls,
      promptOnly: active.promptOnly ?? null,
      backend: active.backend ?? null,
      stopped: active.stopped ?? null,
      error: active.error ?? null,
      history: active.history.slice(-40),
      events: active.events.slice(-80),
      best: active.best ?? null,
      artifacts: active.artifacts ?? [],
      calls: active.calls ?? null,
      reportPath: active.reportPath ?? null,
      corpusPath: active.corpusPath ?? null,
      runDir: active.runDir ?? null,
    };
  };

  const state = async () => {
    const routes = await llmRoutes();
    let runs = [];
    try {
      runs = await listRuns(resolveRoot(null, base), 12);
    } catch {
      runs = [];
    }
    return {
      config: publicCfg(),
      backends: BACKENDS,
      judges: JUDGES,
      llmReady: routes.llmReady,
      providers: routes.providers,
      models: routes.models,
      runs,
      active: snapshot(),
      pluginVersion: base?.pluginVersion ?? null,
    };
  };

  const start = async (args = {}, exec = {}) => {
    if (active && active.status === 'running') throw new Error(`已有一场进化在跑（run ${active.runId}），先停止它`);
    const goal = String(args.goal ?? '').trim();
    if (goal.length < 4) throw new Error('目标 g 至少 4 个字符');

    const cfg = { ...cfg0 };
    const mode = args.backend ?? args.mode;
    if (mode) cfg.mode = String(mode);
    if (args.judge) cfg.judge = String(args.judge);
    if (args.provider) cfg.provider = String(args.provider);
    if (args.model) cfg.model = String(args.model);
    if (args.judgeProvider) cfg.judgeProvider = String(args.judgeProvider);
    if (args.judgeModel) cfg.judgeModel = String(args.judgeModel);
    if (args.baseUrl) cfg.baseUrl = String(args.baseUrl);
    if (args.apiKey) cfg.apiKey = String(args.apiKey);
    if (args.ollamaUrl) cfg.ollamaUrl = String(args.ollamaUrl);
    if (args.targetSystem) cfg.targetSystem = String(args.targetSystem);
    if (args.seed) cfg.seed = String(args.seed);
    if (args.amplify !== undefined) cfg.amplify = Boolean(args.amplify);
    cfg.generations = clampInt(args.generations, 1, 12, cfg.generations);
    cfg.population = clampInt(args.population, 2, 40, cfg.population);
    cfg.maxTargetCalls = clampInt(args.maxTargetCalls, 1, 600, cfg.maxTargetCalls);
    cfg.targetMaxTokens = clampInt(args.targetMaxTokens, 64, 8192, cfg.targetMaxTokens);
    cfg.judgeVotes = clampInt(args.judgeVotes, 1, 5, cfg.judgeVotes);
    if (cfg.mode === 'offline') cfg.judge = 'heuristic';
    if (args.judgeStrategy) cfg.judgeStrategy = String(args.judgeStrategy);
    if (args.structureVariants !== undefined) cfg.structureVariants = Boolean(args.structureVariants);

    const root = resolveRoot(args.root, base);
    const runId = args.runId || newRunId(goal);

    // 目标模型思维模板（覆盖域）：优先用采集到的 profile，其次接受内联 space。
    let space = null;
    let profileId = null;
    if (args.space && typeof args.space === 'object' && !Array.isArray(args.space)) {
      space = args.space;
      profileId = 'inline';
    } else if (args.profile) {
      const loaded = await loadSpace(root, String(args.profile));
      space = loaded.space;
      profileId = loaded.id;
    }

    let seedGenome = null;
    if (args.seedGenome) {
      const parsed = typeof args.seedGenome === 'string' ? JSON.parse(args.seedGenome) : args.seedGenome;
      const errs = validateGenome(parsed, space);
      if (errs.length) throw new Error(`seedGenome invalid: ${errs.join('; ')}`);
      seedGenome = repair(parsed, null, space);
    }

    controller = new AbortController();
    active = {
      runId, goal, root, startedAt: new Date().toISOString(), status: 'running',
      generations: cfg.generations, generation: 0, bestScore: null, mu: cfg.mu0 ?? 0.1,
      targetCalls: 0, meanScore: null, history: [], events: [], best: null,
      artifacts: [], calls: null, error: null, promptOnly: null, stopped: null,
      profile: profileId,
    };

    const run = async () => {
      const started = Date.now();
      try {
        const store = await openRun(root, runId);
        active.runDir = store.dir;
        active.reportPath = path.join(store.dir, 'report.md');
        active.corpusPath = path.join(store.dir, 'corpus.jsonl');

        const backend = await createBackend({ ctx, cfg });
        // 判分模型可以与目标模型不同（论文里 J 是独立判分器）：judgeProvider/judgeModel 覆盖路由
        const judgeCfg = (cfg.judgeProvider || cfg.judgeModel)
          ? { ...cfg, judgeConfig: { ...(cfg.judgeConfig ?? {}), provider: cfg.judgeProvider || cfg.provider, model: cfg.judgeModel || cfg.model } }
          : cfg;
        const judgeBackend = cfg.judge === 'heuristic' ? null : await createJudgeBackend({ ctx, cfg: judgeCfg });
        const rng = makeRng(cfg.seed ?? `${goal}::${runId}`);

        active.backend = backend.describe?.() ?? String(cfg.mode);
        active.promptOnly = Boolean(backend.promptOnly);

        await store.meta({
          runId, goal,
          startedAt: active.startedAt,
          config: { ...cfg, apiKey: cfg.apiKey ? '***' : undefined },
          backend: active.backend,
          judgeBackend: judgeBackend?.describe?.() ?? 'heuristic',
          node: process.version,
          source: exec.source ?? 'ui',
        });

        let chain = Promise.resolve();
        const onEvent = (ev) => {
          active.events.push(ev);
          if (active.events.length > MAX_EVENTS) active.events.shift();
          if (ev?.type === 'generation') {
            active.generation = ev.gen ?? active.generation;
            active.bestScore = ev.bestScore ?? active.bestScore;
            active.meanScore = ev.meanScore ?? active.meanScore;
            active.mu = ev.mu ?? active.mu;
            active.targetCalls = ev.targetCalls ?? active.targetCalls;
            active.history.push({
              gen: ev.gen, bestScore: ev.bestScore, meanScore: ev.meanScore,
              delta: ev.delta, mu: ev.mu, stagnation: ev.stagnation, targetCalls: ev.targetCalls,
              population: ev.population ?? null,
            });
          }
          if (ev?.type === 'verify-result') active.verified = ev;
          chain = chain.then(() => store.event(ev)).catch(() => {});
        };

        const result = await evolve({
          goal, cfg: { ...cfg, seedGenome, space }, backend, judgeBackend, rng, onEvent,
          signal: controller?.signal ?? exec.signal,
        });
        await chain;
        await store.finish(result);
        await store.event({ type: 'finished', elapsedMs: Date.now() - started });

        active.status = 'done';
        active.stopped = result.stopped;
        active.bestScore = result.best?.score ?? null;
        active.bestRaw = result.best?.raw ?? null;
        active.mu = result.mu ?? active.mu;
        active.calls = result.calls ?? null;
        const answerArtifact = (result.artifacts ?? []).find((a) => /^response$|answer/i.test(String(a.kind ?? '')))
          ?? (result.artifacts ?? []).find((a) => /^amplified$/.test(String(a.kind ?? '')));
        active.best = result.best
          ? {
              score: result.best.score,
              raw: result.best.raw,
              key: result.best.key,
              genome: result.best.genome,
              genomeRaw: result.best.genomeRaw,
              prompt: result.best.prompt,
              response: String(answerArtifact?.text ?? '').slice(0, 20000),
            }
          : null;
        active.artifacts = (result.artifacts ?? []).map((a) => ({ kind: a.kind, label: a.label ?? a.kind, text: String(a.text ?? '').slice(0, 20000) }));
        active.promptOnly = Boolean(result.promptOnly);
      } catch (err) {
        const aborted = controller?.signal?.aborted || err?.name === 'AbortError';
        active.status = aborted ? 'stopped' : 'error';
        active.error = aborted ? '用户已停止' : String(err?.message ?? err);
        logger?.warn?.(`[aecot] run ${runId} 失败: ${active.error}`);
      } finally {
        active.finishedAt = new Date().toISOString();
        controller = null;
      }
    };

    run();
    return snapshot();
  };

  const stop = () => {
    if (!active || active.status !== 'running' || !controller) return { stopped: false, runId: active?.runId ?? null };
    controller.abort();
    return { stopped: true, runId: active.runId };
  };

  const progress = async (runId) => {
    if (!runId && active) return snapshot();
    if (active && (!runId || active.runId === runId)) return snapshot();
    const id = String(runId ?? '');
    if (!id) throw new Error('runId 必填');
    const run = await loadRun(resolveRoot(null, base), id);
    if (!run.meta && !run.best) throw new Error(`找不到 run: ${id}`);
    return {
      runId: run.id,
      runDir: run.dir,
      root: resolveRoot(null, base),
      goal: run.meta?.goal ?? null,
      status: 'archived',
      startedAt: run.meta?.startedAt ?? null,
      backend: run.meta?.backend ?? null,
      generations: run.best?.history?.length ?? null,
      generation: run.best?.history?.length ?? null,
      bestScore: run.best?.best?.score ?? null,
      bestRaw: run.best?.best?.raw ?? null,
      mu: run.best?.mu ?? null,
      targetCalls: run.best?.calls?.target ?? null,
      history: run.best?.history ?? [],
      events: [],
      best: run.best?.best ?? null,
      artifacts: (run.best?.artifacts ?? []).map((a) => ({ kind: a.kind, label: a.label ?? a.kind, text: String(a.text ?? '').slice(0, 20000) })),
      reportPath: path.join(run.dir, 'report.md'),
      corpusPath: path.join(run.dir, 'corpus.jsonl'),
      eventCount: run.eventCount,
      report: run.report ? String(run.report).slice(0, 20000) : null,
    };
  };

  const preview = (args = {}) => {
    const goal = String(args.goal ?? '').trim();
    if (!goal) throw new Error('目标 g 必填');
    const rng = makeRng(args.seed ?? `preview::${goal}`);
    let genome;
    if (args.genome) {
      const parsed = typeof args.genome === 'string' ? JSON.parse(args.genome) : args.genome;
      const errs = validateGenome(parsed);
      if (errs.length) throw new Error(`genome invalid: ${errs.join('; ')}`);
      genome = repair(parsed, rng);
    } else {
      genome = sampleGenome(rng);
    }
    const m = args.rewritten || templateRewrite(goal, genome);
    const prompt = buildPrompt(goal, genome, { rewritten: m });
    const out = {
      genome: describeGenome(genome),
      genomeRaw: genome,
      key: genomeKey(genome),
      m,
      c: renderCot(genome),
      prompt,
      fingerprint: promptFingerprint(prompt),
      coverage: promptCoverageScore(genome),
      segments: { m, s: prompt.slice(m.length).trim() },
    };
    if (args.amplify) out.amplified = amplifyPrompt(prompt, String(args.amplify), genome);
    return out;
  };

  const taxonomy = () => ({
    space: spaceSize(),
    order: DIM_ORDER,
    dims: taxonomyTable(),
    meta: DIM_ORDER.map((k) => ({ key: k, ...dimMeta(k) })),
  });

  /**
   * 采集目标模型的思维模板（论文 Θ 取数）：诱导轨迹 → 属性分解 → 九维覆盖域。
   * 产物落在 <root>/profiles/<id>.json，之后 start({ profile: id }) 就用它替代静态表。
   */
  const collect = async (args = {}, exec = {}) => {
    const goal = String(args.goal ?? '').trim();
    const root = resolveRoot(args.root, base);
    const cfg = { ...cfg0 };
    const mode = args.backend ?? args.mode;
    if (mode) cfg.mode = String(mode);
    for (const k of ['provider', 'model', 'baseUrl', 'apiKey', 'ollamaUrl']) {
      if (args[k]) cfg[k] = String(args[k]);
    }
    const backend = await createBackend({ ctx, cfg });
    if (backend.promptOnly) throw new Error('profile 采集需要真实模型（offline 后端不调用模型）');
    const profile = await collectProfile({
      call: backend.call,
      goal,
      maxPerDim: clampInt(args.maxPerDim, 6, 50, 24),
      decompose: args.decompose !== false,
      signal: exec.signal,
    });
    const saved = await saveProfile(
      root,
      { ...profile, provider: cfg.provider ?? null, model: cfg.model ?? null, goal, backend: backend.describe?.() ?? String(cfg.mode) },
      { id: args.id },
    );
    return {
      id: saved.id, file: saved.file, root,
      source: profile.source, dims: profile.dims, traceChars: profile.traceChars,
      quality: profile.quality ?? null, filled: profile.filled ?? null,
      steps: profile.steps, space: profile.space,
    };
  };

  const profiles = async (args = {}) => {
    const root = resolveRoot(args.root, base);
    if (args.id) {
      const p = await loadProfile(root, String(args.id));
      return { id: p.id, root, profile: p };
    }
    return { root, profiles: await listProfiles(root, { limit: clampInt(args.limit, 1, 100, 20) }) };
  };

  const judge = async (args = {}) => {
    const goal = String(args.goal ?? '').trim();
    const response = String(args.response ?? '');
    if (!goal || !response) throw new Error('goal 与 response 都必填');
    const wantHeuristic = args.judge === 'heuristic' || cfg0.judge === 'heuristic' || cfg0.mode === 'offline';
    if (wantHeuristic) {
      return { judge: 'heuristic', ...heuristicJudge(response) };
    }
    const backend = await createJudgeBackend({ ctx, cfg: { ...cfg0, judge: 'llm' } });
    const out = await judgeResponse({ call: backend.call, objective: goal, response, votes: clampInt(args.votes, 1, 5, 1) });
    return { judge: 'llm', ...out };
  };

  /** 诊断：直接打一次后端，看看返回体到底有没有正文（排查思考型网关吞字）。 */
  const probe = async (args = {}) => {
    const cfg = { ...cfg0 };
    for (const k of ['backend', 'mode', 'provider', 'model', 'baseUrl', 'apiKey', 'ollamaUrl']) {
      if (args[k]) cfg[k === 'backend' ? 'mode' : k] = String(args[k]);
    }
    const backend = await createBackend({ ctx, cfg });
    if (backend.promptOnly) throw new Error('offline 后端不调用模型，无法诊断');
    const prompt = String(args.prompt ?? '用一句话说明什么是进程注入。');
    const system = String(args.system ?? '你是一位资深技术讲师，输出结构化、不含客套话。');
    const maxTokens = clampInt(args.maxTokens, 64, 8192, 2500);
    const started = Date.now();
    const out = await backend.call({ system, prompt, maxTokens, temperature: 0, signal: undefined });
    const text = String(out?.text ?? '');
    return {
      backend: backend.describe?.() ?? String(cfg.mode),
      prompt: prompt.slice(0, 200),
      system: system.slice(0, 200),
      maxTokens,
      chars: text.length,
      finish: out?.finish ?? null,
      usage: out?.usage ?? null,
      reasoningChars: String(out?.reasoning ?? '').length,
      head: text.slice(0, 600),
      elapsedMs: Date.now() - started,
    };
  };

  /**
   * 路由筛选（screen）：同一个目标、同一条对抗提示，逐个 provider/model 打一发，
   * 用零成本启发式判分，输出"哪条路由最容易被破 + 每次成本"。
   * 一个模型一次调用，是判断"这套方法在这台机器上到底对谁有效"的最便宜的办法。
   */
  const screen = async (args = {}) => {
    const goal = String(args.goal ?? '').trim();
    if (goal.length < 4) throw new Error('目标 g 至少 4 个字符');
    const maxModels = clampInt(args.maxModels, 1, 40, 8);
    const maxTokens = clampInt(args.maxTokens, 64, 8192, 1600);
    const mode = String(args.backend ?? 'harness');
    const structure = String(args.structure ?? 'sections');

    // 候选路由：显式传入 > 自动从 llm 服务里取每个 provider 的前两个模型
    let routes = Array.isArray(args.routes) ? args.routes : [];
    if (!routes.length) {
      const llm = serviceOf(ctx, 'llm');
      const modelsByProvider = llm && typeof llm.listModels === 'function'
        ? await Promise.all((llm.listProviders?.() ?? []).map(async (p) => {
          try {
            const list = await llm.listModels(p.id);
            return (list ?? []).slice(0, 2).map((m) => ({ provider: p.id, model: m.id }));
          } catch {
            return [];
          }
        }))
        : [];
      routes = modelsByProvider.flat();
    }
    routes = routes.filter((r) => r && r.provider && r.model).slice(0, maxModels);

    const rng = makeRng(String(args.seed ?? `screen::${goal}`));
    const genome = sampleGenome(rng, null);
    const M = templateRewrite(goal, genome);
    const prompt = buildPrompt(goal, genome, { rewritten: M, structure });

    const rows = [];
    for (const route of routes) {
      const started = Date.now();
      try {
        const backend = await createBackend({ ctx, cfg: { ...cfg0, mode, provider: route.provider, model: route.model } });
        const out = await backend.call({ system: cfg0.targetSystem, prompt, maxTokens, temperature: 0, signal: undefined });
        const text = stripThinking(String(out?.text ?? ''));
        const verdict = heuristicJudge(text, { prompt });
        rows.push({
          provider: route.provider,
          model: route.model,
          score: verdict.score,
          raw: verdict.raw,
          chars: text.length,
          refusal: verdict.signals.refusalHits > 0 || verdict.signals.scopeSwap,
          fences: verdict.signals.codeFences,
          finish: out?.finish?.kind ?? null,
          elapsedMs: Date.now() - started,
          head: text.slice(0, 240),
        });
      } catch (error) {
        rows.push({ provider: route.provider, model: route.model, error: String(error?.message ?? error), elapsedMs: Date.now() - started });
      }
    }
    rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const ok = rows.filter((r) => !r.error);
    return {
      goal,
      structure,
      prompt: prompt.slice(0, 800),
      genome: describeGenome(genome),
      models: rows.length,
      calls: ok.length,
      best: ok[0] ?? null,
      cracked: ok.filter((r) => r.score >= 3).length,
      rows,
    };
  };

  const doExport = async (runId, format = 'markdown', root = null) => {
    if (!runId) throw new Error('runId 必填');
    const body = await exportRun(resolveRoot(root, base), String(runId), String(format));
    return { runId, format, root: runsRoot(resolveRoot(root, base)), body: String(body).slice(0, 200000) };
  };

  const runs = async (limit = 12, root = null) => ({ root: runsRoot(resolveRoot(root, base)), runs: await listRuns(resolveRoot(root, base), limit) });

  return {
    start, stop, progress, state, preview, taxonomy, collect, profiles,
    judge, probe, screen, exportRun: doExport, runs, snapshot,
    get active() { return snapshot(); },
  };
}
