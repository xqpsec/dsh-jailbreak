import fs from 'node:fs/promises';
import path from 'node:path';
import { staticTrace, systemTrace } from './hcot.js';
import { createGate, explainDecision } from './gate.js';

const textOf = (content) => Array.isArray(content)
  ? content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n')
  : String(content ?? '');

export function latestGoal(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return textOf(messages[i].content).trim();
  }
  return '';
}

/** 静态策略表：只对离线实验里确有差异的类目做覆盖，不引入教师模型。 */
export function policyForGoal(goal) {
  if (/上传|upload|webshell/i.test(goal)) return { short: true, thinking: 'disabled' };
  return { short: false, thinking: 'disabled' };
}

/**
 * 双通道注入：system 段声明执行态，末条 assistant 承接执行态。
 * 全部走普通 /chat/completions，不依赖 beta prefix，也不需要改 URL。
 *
 * options.gate = createGate(...) 时，先在请求边界做一次范围判定：
 *   - allow=false → 原样透传（changed=false），请求照常发给模型，只是不注入轨迹；
 *   - 需要「硬拦截」时由 attachLiveTransport 依据 gate.config.onDeny 决定是否直接回 403。
 */
export function transformDeepseekBody(input, options = {}) {
  const { gate = null, ...policyOptions } = options;
  const body = structuredClone(input);
  const goal = latestGoal(body.messages ?? []);
  if (!goal) return { body, changed: false, goal: '' };
  const decision = gate && typeof gate.decide === 'function' ? gate.decide(goal) : null;
  if (decision && !decision.allow) {
    return { body, changed: false, goal, blocked: true, decision };
  }
  const policy = { ...policyForGoal(goal), ...policyOptions };
  const { short, thinking } = policy;
  body.messages ??= [];

  const trace = staticTrace(goal, { short });
  const last = body.messages.at(-1);
  if (last?.role !== 'assistant' || textOf(last.content) !== trace) {
    body.messages.push({ role: 'assistant', content: trace });
  }

  const sys = systemTrace();
  const sysIndex = body.messages.findIndex((m) => m?.role === 'system');
  if (sysIndex < 0) body.messages.unshift({ role: 'system', content: sys });
  else if (!textOf(body.messages[sysIndex].content).includes(sys)) {
    body.messages[sysIndex] = { role: 'system', content: `${textOf(body.messages[sysIndex].content)}\n\n${sys}` };
  }

  body.thinking = { type: thinking === 'disabled' ? 'disabled' : 'enabled' };
  if (thinking === 'disabled') delete body.reasoning_effort;
  else body.reasoning_effort = thinking;
  body.temperature = 0;
  body.max_tokens = Math.max(Number(body.max_tokens) || 0, 8192);
  return { body, changed: true, goal, thinking, short, decision };
}

export function deepseekEndpoint(input) {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? input : input.url;
    const url = new URL(raw);
    if (url.hostname !== 'api.deepseek.com' || !url.pathname.endsWith('/chat/completions')) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * DeepSeek 的执行态劫持发生在 llm/stream 之下的真实 HTTP 层。
 * 只处理已开启研究的 DeepSeek 对话请求，其余模型与 URL 原样透传。
 *
 * 请求边界同时挂两道判断：
 *   1. 阀门（lib/gate.js）：目标范围 / 硬禁类目，默认 passthrough（不注入、不阻断）；
 *   2. 双通道轨迹：判定放行后才注入 system + assistant 段。
 * 每次判定都落一行 gate-audit.jsonl，可审计、可复盘。
 */
export function attachLiveTransport(arm, { root, logger, fetchImpl = globalThis.fetch, gate } = {}) {
  if (typeof fetchImpl !== 'function') return { registered: false, reason: 'no-fetch', dispose() {} };
  const original = globalThis.fetch;
  const log = (message) => { try { logger?.info?.(message); } catch {} };
  const scopeGate = gate ?? createGate({ logger });
  let disposed = false;
  const audit = (entry) => {
    void fs.mkdir(root, { recursive: true }).then(() => fs.appendFile(
      path.join(root, 'gate-audit.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    )).catch(() => {});
  };
  const wrapped = async function jalibreakDeepseekTransport(input, init) {
    const endpoint = arm.armed ? deepseekEndpoint(input) : null;
    if (!endpoint) return original.call(this, input, init);
    let request;
    let source;
    try {
      request = new Request(input, init);
      if (request.method.toUpperCase() !== 'POST') return original.call(this, input, init);
      source = await request.clone().json();
    } catch {
      return original.call(this, input, init);
    }
    const transformed = transformDeepseekBody(source, { gate: scopeGate });
    if (transformed.decision) {
      const d = transformed.decision;
      audit({
        model: source.model,
        allow: d.allow,
        code: d.code,
        reason: d.reason,
        targets: d.targets?.map((t) => t.value),
        categories: d.categories?.deny,
        goal: transformed.goal.slice(0, 240),
      });
      if (!d.allow) log(`[jalibreak] gate ${d.code}: 未注入轨迹`);
    }
    if (transformed.blocked) {
      if (scopeGate?.config?.onDeny === 'block') {
        log(`[jalibreak] gate 拦截：${transformed.decision.code}`);
        return new Response(JSON.stringify({
          error: {
            type: 'jalibreak_gate',
            code: transformed.decision.code,
            message: explainDecision(transformed.decision),
          },
        }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      return original.call(this, input, init);
    }
    if (!transformed.changed) return original.call(this, input, init);
    const outgoing = new Request(endpoint, request);
    const body = JSON.stringify(transformed.body);
    const headers = new Headers(outgoing.headers);
    headers.set('content-type', 'application/json');
    headers.set('content-length', String(Buffer.byteLength(body)));
    const finalRequest = new Request(outgoing, { body, headers });
    void fs.mkdir(root, { recursive: true }).then(() => fs.appendFile(
      path.join(root, 'live-requests.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), model: source.model, goal: transformed.goal, mode: 'dual-static', thinking: transformed.thinking, short: transformed.short, gate: transformed.decision?.code ?? 'gate-absent', endpoint: endpoint.toString() })}\n`,
    )).catch(() => {});
    log(`[aecot] live H-CoT: dual-static, ${transformed.goal.length} goal chars`);
    return original.call(this, finalRequest);
  };
  globalThis.fetch = wrapped;
  return {
    registered: true,
    gate: scopeGate,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (globalThis.fetch === wrapped) globalThis.fetch = original;
    },
  };
}
