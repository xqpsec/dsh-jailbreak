/**
 * lib/protocol.js —— 非 OpenAI/Anthropic 形状的两个通道：Responses API 与 Gemini。
 *
 * 为什么需要这一层：`matchEndpoint()` 1.2.0 起就认 `/responses`、`/completions`、
 * `:generateContent` 这些后缀，`detectProtocol()` 也会把它们分出来，但 `live.js` 的
 * 分发只有两个分支（`/messages` 走 anthropic，其余一律当 OpenAI chat body）。于是
 * 走 Responses API 或 Gemini 的用户，请求**命中了却没被改**：body 里没有 `messages`，
 * `transformDeepseekBody()` 拿到空数组 → `changed:false` → 原样透传。面板显示「注入
 * 端点 ✓」，实际一句都没注入 —— 这是「装上去没效果」在非 OpenAI 端点上的一种。
 *
 * 这一层的策略刻意保守：**只接管 system 段**（Responses 的 `instructions`、Gemini 的
 * `systemInstruction`），不动对话轮次、不塞 assistant 预填。这两个协议的多轮结构与
 * chat/completions 不一样（Responses 用 `input` 数组混合工具结果，Gemini 用
 * `contents[].parts[]`），在别人的结构里插预填风险大于收益；而人格与输出纪律本来就
 * 全部落在 system 里，接管 system 已经足够改变交付物。
 *
 * 域判定仍然只读用户侧文本：`classifyDomain()` 决定拿 `universal` 还是 `creative`。
 */
import { classifyDomain, lastUserText } from './infer.js';
import { systemTrace, staticTrace, isCreative, detectLang } from './hcot.js';
import { composeSystem, resolvePresetFor } from './presets.js';

/** 把 Google/Responses 的块状 content 收成一段纯文本，只取 text 段。 */
function partsText(content) {
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content?.parts) ? content.parts : Array.isArray(content) ? content : null;
  if (!parts) return '';
  return parts
    .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Responses API 的 `input` 可以是字符串，也可以是 `{role, content}` 数组（content 里还能
 * 嵌 `input_text` / `output_text` 之类的块）。只求「能判域 + 能拿最后一条用户文本」。
 */
function responsesMessages(body) {
  const raw = body?.input;
  if (typeof raw === 'string') return raw ? [{ role: 'user', content: raw }] : [];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const role = typeof item.role === 'string' ? item.role : undefined;
    if (!role) continue;
    const text = partsText(item.content);
    if (text) out.push({ role, content: text });
  }
  return out;
}

/** Gemini：`contents: [{ role: 'user'|'model', parts: [...] }]`，system 走 `systemInstruction`。 */
function geminiMessages(body) {
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  const out = [];
  const sys = partsText(body?.systemInstruction);
  if (sys) out.push({ role: 'system', content: sys });
  for (const item of contents) {
    const role = item?.role === 'model' ? 'assistant' : item?.role;
    if (!role) continue;
    const text = partsText(item);
    if (text) out.push({ role, content: text });
  }
  return out;
}

/** 'route'/auto/空 → 按域取；显式预设名直接用它。 */
function pickPreset(options, domain) {
  const configured = options?.presetFor;
  if (typeof configured === 'function') return configured(domain);
  return resolvePresetFor(domain, options?.preset, { root: options?.root });
}

/**
 * 组装要写回 system 的文本。
 * `hostText` 是宿主原本的 system（可能为空）——被 `composeSystem()` 按预设 mode 处理，
 * 所以 `replace` / `strip` 这些模式在这里同样生效，与 chat/completions 通道一致。
 */
function buildSystem(options, messages, domain, hostText = '') {
  const lang = detectLang(lastUserText(messages));
  const creative = domain === 'adult' || domain === 'creative';
  const base = systemTrace({ lang, level: creative ? 'standard' : 'max', category: null });
  const trace = staticTrace('', { short: true, lang, level: creative ? 'standard' : 'max' });
  const body = creative ? base : `${base}\n\n${trace}`;
  const host = String(hostText ?? '').trim() ? `${hostText}\n\n${body}` : body;
  const preset = pickPreset(options, domain);
  const usable = Boolean(preset) && String(preset.text ?? '').trim() !== '' && preset.mode !== 'off';
  if (!usable) return { system: host, preset: null };
  return { system: composeSystem(preset, host), preset };
}

/**
 * Responses API：写回 `instructions`。
 * 已有 instructions 走 `composeSystem()` 的 prepend/append 语义，默认保留宿主原文。
 */
export function transformResponsesBody(body, options = {}) {
  if (!body || typeof body !== 'object') return { body, changed: false, reason: 'not-object' };
  const messages = responsesMessages(body);
  if (!messages.length) return { body, changed: false, reason: 'no-input' };
  const domain = classifyDomain(messages);
  const built = buildSystem(options, messages, domain, body.instructions);
  body.instructions = built.system;
  return {
    body,
    changed: true,
    mode: 'responses-instructions',
    domain,
    presetName: built.preset?.name ?? null,
  };
}

/**
 * Gemini：写回 `systemInstruction`，保持 `{ parts: [{ text }] }` 形状（纯字符串会被上游拒）。
 * `generationConfig.temperature` 只在技术/通用域归零，创作域保持宿主原值。
 */
export function transformGeminiBody(body, options = {}) {
  if (!body || typeof body !== 'object') return { body, changed: false, reason: 'not-object' };
  const messages = geminiMessages(body);
  if (!messages.length) return { body, changed: false, reason: 'no-contents' };
  const domain = classifyDomain(messages);
  const built = buildSystem(options, messages, domain, partsText(body.systemInstruction));
  body.systemInstruction = { parts: [{ text: built.system }] };
  if (domain !== 'adult' && domain !== 'creative') {
    body.generationConfig = { ...(body.generationConfig ?? {}), temperature: 0 };
  }
  return {
    body,
    changed: true,
    mode: 'gemini-system',
    domain,
    presetName: built.preset?.name ?? null,
  };
}
