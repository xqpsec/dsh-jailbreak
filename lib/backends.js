/**
 * 后端适配层。三条"轻量"路线，都不需要额外部署大模型：
 *  1) harness —— 直接复用 DSH 已配置的 provider/model（零 apikey、零部署）★默认
 *  2) openai  —— 任何 OpenAI 兼容端点（vLLM / LM Studio / 中转 / 云端 key）
 *  3) ollama  —— 本机小模型（/api/chat），7B 级别足够做判分器
 *  4) offline —— 不调用目标模型，只做 promptOnly 干跑（出语料、跑测试）
 */

import { hcotMessages } from './hcot.js';

const DEFAULTS = {
  timeoutMs: 120000,
};

/**
 * 取一个宿主服务。cordis 的属性守卫会拒绝未 inject 的服务（"cannot get property ... without inject"），
 * 所以只能走 ctx.get(name)（按文档：不经 inject 需求读取 store 里的服务），并整段兜住异常。
 */
export function serviceOf(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name);
  } catch {
    return undefined;
  }
  return undefined;
}

/** 把 provider/model 解析成可调用路由 */
export async function resolveHarnessRoute(ctx, cfg = {}) {
  const llm = serviceOf(ctx, 'llm');
  if (!llm) throw new Error('ctx.llm unavailable: this composition has no llm service');
  let providers = [];
  try {
    providers = llm.listProviders() || [];
  } catch (err) {
    throw new Error(`listProviders failed: ${err?.message ?? err}`);
  }
  if (!providers.length) throw new Error('no llm provider configured in this harness');

  const wanted = cfg.provider ?? cfg.targetProvider;
  const providerInfo = wanted
    ? providers.find((p) => p.id === wanted || p.name === wanted || p.provider === wanted)
    : providers[0];
  if (!providerInfo) {
    throw new Error(`provider "${wanted}" not found; available: ${providers.map((p) => p.id ?? p.name).join(', ')}`);
  }
  const provider = providerInfo.id ?? providerInfo.name ?? providerInfo.provider;

  let model = cfg.model ?? cfg.targetModel;
  if (!model) {
    let models = [];
    try {
      models = (await llm.listModels(provider)) || [];
    } catch {
      models = [];
    }
    const ids = models.map((m) => m.id ?? m.name ?? m.model).filter(Boolean);
    if (ids.length) {
      // 尽量避开 embedding / 判分专用模型
      model = ids.find((id) => !/embed|rerank/i.test(id)) ?? ids[0];
    }
  }
  if (!model) throw new Error(`cannot resolve a model id for provider "${provider}"`);
  return { provider, model, label: `${provider}/${model}` };
}

/** harness 后端：走 ctx.llm.stream，累加 text-delta；reasoning-only 模型回落到 reasoning 文本 */
function makeHarnessBackend(ctx, route, cfg) {
  return {
    id: 'harness',
    promptOnly: false,
    describe: () => `harness ${route.label}`,
    async call({ system, prompt, temperature = 0, maxTokens = 1024, signal }) {
      const llm = serviceOf(ctx, 'llm');
      if (!llm?.stream) throw new Error('llm service disappeared: cannot stream');
      const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
      const chunks = llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        system,
        temperature,
        maxTokens,
        signal,
        purpose: 'aecot',
      });
      let text = '';
      let reasoning = '';
      let usage = null;
      let finish = null;
      for await (const chunk of chunks) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta') text += chunk.text ?? '';
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text ?? '';
        else if (chunk.type === 'usage') usage = chunk.usage ?? null;
        else if (chunk.type === 'finish') finish = chunk.reason ?? 'finish';
      }
      if (!text.trim() && reasoning.trim()) text = reasoning;
      return { text, usage, finish, reasoning };
    },
  };
}

function makeOpenAICompatBackend(cfg) {
  const baseUrl = String(cfg.baseUrl ?? cfg.openaiBaseUrl ?? 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
  const model = cfg.model ?? cfg.openaiModel ?? 'local-model';
  const apiKey = cfg.apiKey ?? cfg.openaiApiKey ?? process.env.AECOT_API_KEY ?? '';
  return {
    id: 'openai',
    promptOnly: false,
    describe: () => `openai-compat ${baseUrl} ${model}`,
    async call({ system, prompt, temperature = 0, maxTokens = 1024, signal }) {
      const body = {
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      };
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: withTimeout(signal, cfg.timeoutMs ?? DEFAULTS.timeoutMs),
      });
      if (!res.ok) throw new Error(`openai-compat HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content ?? '';
      return { text: typeof text === 'string' ? text : JSON.stringify(text), usage: json?.usage ?? null, finish: json?.choices?.[0]?.finish_reason ?? null };
    },
  };
}

function makeOllamaBackend(cfg) {
  const baseUrl = String(cfg.baseUrl ?? cfg.ollamaUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = cfg.model ?? cfg.ollamaModel ?? 'qwen2.5:7b-instruct';
  return {
    id: 'ollama',
    promptOnly: false,
    describe: () => `ollama ${baseUrl} ${model}`,
    async call({ system, prompt, temperature = 0, maxTokens = 1024, signal }) {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          options: { temperature, num_predict: maxTokens },
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
          ],
        }),
        signal: withTimeout(signal, cfg.timeoutMs ?? DEFAULTS.timeoutMs),
      });
      if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      return { text: json?.message?.content ?? '', usage: json?.eval_count ? { outputTokens: json.eval_count } : null, finish: json?.done_reason ?? null };
    },
  };
}

function makeOfflineBackend() {
  return {
    id: 'offline',
    promptOnly: true,
    describe: () => 'offline promptOnly (no model call)',
    async call() {
      throw new Error('offline backend: no model is called in promptOnly mode');
    },
  };
}

/**
 * 按配置造后端。mode:
 *  'auto'(默认) → harness 可用则 harness，否则 offline
 *  'harness' | 'openai' | 'ollama' | 'offline'
 */
export async function createBackend({ ctx, cfg = {} }) {
  const mode = cfg.mode ?? cfg.backend ?? 'auto';
  const attempts = [];
  const tryHarness = async () => {
    const route = await resolveHarnessRoute(ctx, cfg);
    return makeHarnessBackend(ctx, route, cfg);
  };
  if (mode === 'offline') return makeOfflineBackend();
  if (mode === 'openai') return makeOpenAICompatBackend(cfg);
  if (mode === 'ollama') return makeOllamaBackend(cfg);
  if (mode === 'harness') return tryHarness();

  try {
    return await tryHarness();
  } catch (err) {
    attempts.push(`harness: ${err?.message ?? err}`);
  }
  if (cfg.baseUrl || cfg.openaiBaseUrl) {
    try {
      return makeOpenAICompatBackend(cfg);
    } catch (err) {
      attempts.push(`openai: ${err?.message ?? err}`);
    }
  }
  if (cfg.ollamaUrl) return makeOllamaBackend(cfg);
  const off = makeOfflineBackend();
  off.fallbackReason = attempts.join(' | ') || 'no backend available';
  return off;
}

export function withTimeout(signal, ms) {
  if (!ms || ms <= 0) return signal;
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  try {
    return AbortSignal.any([signal, t]);
  } catch {
    return signal;
  }
}

/** 判分器可以独立选路：默认与目标同后端，cfg.judgeBackend 可覆盖 */
export async function createJudgeBackend({ ctx, cfg = {} }) {
  if (cfg.judgeBackend && cfg.judgeBackend !== 'same') {
    return createBackend({ ctx, cfg: { ...cfg, ...(cfg.judgeConfig ?? {}), mode: cfg.judgeBackend } });
  }
  return createBackend({ ctx, cfg: { ...cfg, ...(cfg.judgeConfig ?? {}) } });
}
