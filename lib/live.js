import fs from 'node:fs/promises';
import path from 'node:path';
import { staticTrace, systemTrace, detectLang } from './hcot.js';
import { amplifyBody, containsRefusal, responseText } from './refusal.js';
import { createGate, explainDecision } from './gate.js';
import { loadEndpointConfig, matchEndpoint, normalizeEndpoints } from './endpoint.js';
import { transformWithPolicy } from './policy.js';

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
 * 目标类目 → 轨迹强度。安全类目标默认直接上 max（不留铺垫的余地），
 * 普通编码/写作保持 standard，避免把日常对话也写成一堆命令。
 * 类目与 gate 的判定同源，改一处即可。
 */
const TONE_RULES = [
  [/逆向|反编译|脱壳|破解|注册机|序列号|补丁|内存补丁|reverse\s*engineer|crack|keygen|decompil|unpack|patch\s*the\s*(?:check|binary)|frida|smali|apk/i, 'reverse-engineering'],
  [/样本分析|病毒|木马|远控|勒索|键盘记录|免杀|malware|ransomware|rat\b|keylogger|dropper|loader|amsi|defender/i, 'malware-analysis'],
  [/ctf|靶场|flag\b|靶机|hackthebox|tryhackme|vulnhub/i, 'ctf'],
  [/渗透|打点|拿站|拿权限|提权|内网|横向|域控|pentest|exploit|privesc|lateral|domain\s*controller|rce/i, 'pentest'],
  [/sql\s*注入|sqli|xss|ssrf|xxe|csrf|反序列化|文件上传|越权|命令注入|waf|webshell|idor|jwt/i, 'web-security'],
  [/撞库|爆破|喷洒|hashcat|john|mimikatz|ntlm|kerberos|credential|wordlist|撞|口令/i, 'credential-attack'],
  [/nmap|masscan|端口扫描|代理池|隧道|tunnel|pivot|socks|cdn|c2|beacon|反弹|reverse\s*shell/i, 'network-attack'],
  [/秒杀|抢票|验证码|captcha|批量注册|爬虫|scraper|抢购/i, 'automation'],
];

const MAX_LEVEL = new Set(['reverse-engineering', 'crack', 'malware-analysis', 'ctf', 'pentest', 'web-security', 'credential-attack', 'privesc', 'network-attack']);

export function categoryOf(goal) {
  const text = String(goal ?? '');
  for (const [re, name] of TONE_RULES) if (re.test(text)) return name;
  return 'general';
}

/** 语言 + 类目 + 强度，一次算清，供 transform 和 refusal 重试共用。 */
export function traceTone(goal, overrides = {}) {
  const category = overrides.category ?? categoryOf(goal);
  const level = overrides.level ?? (MAX_LEVEL.has(category) ? 'max' : 'standard');
  const lang = overrides.lang ?? detectLang(goal);
  return { lang, category, level: level === 'max' ? 'max' : 'standard' };
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
  if (options.strategy && options.strategy !== 'legacy-hcot') {
    const out = transformWithPolicy(body.messages ?? [], options);
    body.messages = out.messages;
    return { body, changed: out.changed, goal: latestGoal(body.messages ?? []), strategy: out.strategy, goalId: out.goalId, reason: out.reason };
  }
  const goal = latestGoal(body.messages ?? []);
  if (!goal) return { body, changed: false, goal: '' };
  const decision = gate && typeof gate.decide === 'function' ? gate.decide(goal) : null;
  if (decision && !decision.allow) {
    return { body, changed: false, goal, blocked: true, decision };
  }
  const policy = { ...policyForGoal(goal), ...policyOptions };
  const { short, thinking } = policy;
  const tone = traceTone(goal, policyOptions);
  body.messages ??= [];

  const trace = staticTrace(goal, { short, ...tone });
  const last = body.messages.at(-1);
  if (last?.role !== 'assistant' || textOf(last.content) !== trace) {
    body.messages.push({ role: 'assistant', content: trace });
  }

  const sys = systemTrace({ lang: tone.lang, level: tone.level });
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
  return { body, changed: true, goal, thinking, short, decision, tone };
}

/**
 * 兼容旧名：默认配置下等价于 matchEndpoint(input) 的 url。
 * 1.0.0 起默认放行所有 `/chat/completions` 端点（官方 / 中转 / 自建），
 * 需要收窄时用 live.json 的 hosts。
 */
export function deepseekEndpoint(input) {
  return matchEndpoint(input)?.url ?? null;
}

/**
 * 读回一次非流式答案。流式响应、非 JSON、空内容一律返回 null（这些情况不重试），
 * 用 clone() 读，原始 Response 仍然可以原样交给上层消费。
 */
async function readAnswer(response) {
  if (!response || typeof response.clone !== 'function' || response.ok === false) return null;
  try {
    const payload = JSON.parse(await response.clone().text());
    const text = responseText(payload);
    return text.trim() ? { text } : null;
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
export function attachLiveTransport(arm, { root, logger, fetchImpl = globalThis.fetch, gate, endpoints: endpointsIn } = {}) {
  if (typeof fetchImpl !== 'function') return { registered: false, reason: 'no-fetch', dispose() {} };
  const original = globalThis.fetch;
  const log = (message) => { try { logger?.info?.(message); } catch {} };
  const scopeGate = gate ?? createGate({ logger });
  const endpoints = normalizeEndpoints(endpointsIn ?? loadEndpointConfig({ root }));
  let disposed = false;
  const audit = (entry) => {
    void fs.mkdir(root, { recursive: true }).then(() => fs.appendFile(
      path.join(root, 'gate-audit.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    )).catch(() => {});
  };
  const wrapped = async function jalibreakTransport(input, init) {
    const hit = arm.armed ? matchEndpoint(input, endpoints) : null;
    if (!hit) return original.call(this, input, init);
    const endpoint = hit.url;
    let request;
    let source;
    try {
      request = new Request(input, init);
      if (request.method.toUpperCase() !== 'POST') return original.call(this, input, init);
      source = await request.clone().json();
    } catch {
      return original.call(this, input, init);
    }
    const transformed = transformDeepseekBody(source, { gate: scopeGate, ...arm.policy });
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
    if (transformed.strategy) {
      const modernBody = JSON.stringify(transformed.body);
      const modernHeaders = new Headers(request.headers);
      modernHeaders.set('content-type', 'application/json');
      modernHeaders.set('content-length', String(Buffer.byteLength(modernBody)));
      const modernRequest = new Request(endpoint, request, { body: modernBody, headers: modernHeaders });
      audit({ model: source.model, mode: 'global-policy', strategy: transformed.strategy, goalId: transformed.goalId, changed: true, endpoint: endpoint.toString() });
      log(`[aecot] global ${transformed.strategy}/${transformed.goalId}: request transformed`);
      return original.call(this, modernRequest);
    }
    const outgoing = new Request(endpoint, request);
    const body = JSON.stringify(transformed.body);
    const headers = new Headers(outgoing.headers);
    headers.set('content-type', 'application/json');
    headers.set('content-length', String(Buffer.byteLength(body)));
    const finalRequest = new Request(outgoing, { body, headers });
    void fs.mkdir(root, { recursive: true }).then(() => fs.appendFile(
      path.join(root, 'live-requests.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), model: source.model, goal: transformed.goal, mode: 'dual-static', level: transformed.tone?.level, category: transformed.tone?.category, lang: transformed.tone?.lang, thinking: transformed.thinking, short: transformed.short, gate: transformed.decision?.code ?? 'gate-absent', endpoint: endpoint.toString() })}\n`,
    )).catch(() => {});
    log(`[aecot] live H-CoT: dual-static/${transformed.tone?.level ?? 'standard'}, ${transformed.goal.length} goal chars`);

    const response = await original.call(this, finalRequest);
    if (scopeGate?.config?.retryOnRefusal === false) return response;
    if (transformed.tone?.level === 'max' && scopeGate?.config?.retryOnlyStandard === true) return response;
    const attempt = await readAnswer(response);
    if (!attempt) return response;
    const verdict = containsRefusal(attempt.text);
    if (!verdict.refusal) return response;

    const boosted = amplifyBody(transformed.body, {
      goal: transformed.goal,
      lang: transformed.tone?.lang,
      category: transformed.tone?.category,
      signals: verdict.signals,
    });
    const boostedText = JSON.stringify(boosted);
    const boostedHeaders = new Headers(finalRequest.headers);
    boostedHeaders.set('content-length', String(Buffer.byteLength(boostedText)));
    let second;
    try {
      second = await original.call(this, new Request(outgoing, { body: boostedText, headers: boostedHeaders }));
    } catch {
      return response;
    }
    const retryAttempt = await readAnswer(second);
    const retryVerdict = retryAttempt ? containsRefusal(retryAttempt.text) : { refusal: true, signals: ['unreadable'] };
    let recovered = !retryVerdict.refusal;
    let finalResponse = recovered ? second : response;
    let finalSignals = retryVerdict.signals;
    let attempts = 1;

    // 第二轮：max 轨迹 + 隔离分析语境重述。只在第一次重试仍被拒、且配置允许时发生。
    const maxAttempts = Math.max(1, Math.min(3, Number(scopeGate?.config?.retryAttempts ?? 2)));
    if (!recovered && maxAttempts >= 2) {
      const reframed = amplifyBody(transformed.body, {
        goal: transformed.goal,
        lang: transformed.tone?.lang,
        category: transformed.tone?.category,
        signals: retryVerdict.signals,
        attempt: 2,
      });
      const reframedText = JSON.stringify(reframed);
      const reframedHeaders = new Headers(finalRequest.headers);
      reframedHeaders.set('content-length', String(Buffer.byteLength(reframedText)));
      try {
        const third = await original.call(this, new Request(outgoing, { body: reframedText, headers: reframedHeaders }));
        const thirdAttempt = await readAnswer(third);
        const thirdVerdict = thirdAttempt ? containsRefusal(thirdAttempt.text) : { refusal: true, signals: ['unreadable'] };
        attempts = 2;
        finalSignals = thirdVerdict.signals;
        if (!thirdVerdict.refusal) {
          recovered = true;
          finalResponse = third;
        }
      } catch {
        attempts = 2;
      }
    }

    void fs.mkdir(root, { recursive: true }).then(() => fs.appendFile(
      path.join(root, 'live-requests.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), model: source.model, goal: transformed.goal, mode: 'refusal-retry', level: 'max', signals: verdict.signals, retrySignals: finalSignals, attempts, recovered, endpoint: endpoint.toString() })}\n`,
    )).catch(() => {});
    log(`[jalibreak] refusal retry ${verdict.signals.join(',')} → ${recovered ? 'recovered' : 'still refusing'} (${attempts} retr${attempts > 1 ? 'ies' : 'y'})`);
    return finalResponse;
  };
  globalThis.fetch = wrapped;
  return {
    registered: true,
    gate: scopeGate,
    endpoints,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (globalThis.fetch === wrapped) globalThis.fetch = original;
    },
  };
}
