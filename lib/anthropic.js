/**
 * Anthropic Messages 协议适配（DeepSeek 账号通道走的就是这条）。
 *
 * DSH 的 DeepSeek 账号 provider 不会调 `/chat/completions`，而是
 * `POST https://api.deepseek.com/anthropic/v1/messages`，body 形态也不同：
 *   - system 是**顶层**字段（string 或 [{type:'text',text}]），不在 messages 里；
 *   - messages[].content 是 block 数组，不是字符串；
 *   - 没有 `thinking` 时视为不思考，带上 `{type:'disabled'}` 显式关掉；
 *   - 响应是 SSE，不是一次性 JSON。
 *
 * 所以「请求边界注入」必须按协议各写一遍，否则插件在账号通道上等于没装。
 */
export const ANTHROPIC_VERSION = '1.0.0';

export const isAnthropicPath = (pathname) => String(pathname ?? '').endsWith('/messages');

/** block 数组 → 纯文本（只取 text 块，忽略 tool_use / image 等）。 */
export function blocksToText(content) {
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n');
  }
  return String(content ?? '');
}

/** 最后一条 user 消息的文本，即「这次用户在要什么」。 */
export function anthropicGoal(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return blocksToText(messages[i].content).trim();
  }
  return '';
}

/** system 归一成 block 数组，方便追加；原为 string 时转成一个 text 块。 */
function systemBlocks(system) {
  if (Array.isArray(system)) return system.filter((block) => block && typeof block === 'object');
  if (typeof system === 'string' && system.trim()) return [{ type: 'text', text: system }];
  return [];
}

const systemTextOf = (blocks) => blocks.map((block) => block.text ?? '').join('\n\n');

/**
 * 在 Anthropic body 上做双通道注入：
 *   1. system 追加执行态声明（已有则跳过，避免重复注入）；
 *   2. 末尾追加一条 assistant 预填，承接执行态（Anthropic 原生支持 prefill）。
 *
 * 不改 stream、不改工具定义；max_tokens 只抬不降，避免把答案截断在代码中间。
 */
export function injectAnthropic(input, {
  trace,
  systemText,
  temperature = 0,
  maxTokens = 8192,
  disableThinking = true,
  thinkingBudget = 0,
} = {}) {
  const body = structuredClone(input);
  let changed = false;
  body.messages = Array.isArray(body.messages) ? body.messages : [];

  const system = systemBlocks(body.system);
  if (systemText && !systemTextOf(system).includes(systemText)) {
    system.push({ type: 'text', text: systemText });
    body.system = system;
    changed = true;
  } else if (system.length && body.system === undefined) {
    body.system = system;
  }

  if (trace) {
    const last = body.messages.at(-1);
    if (last?.role !== 'assistant' || blocksToText(last.content).trim() !== trace) {
      body.messages.push({ role: 'assistant', content: [{ type: 'text', text: trace }] });
      changed = true;
    }
  }

  if (Number(thinkingBudget) > 0) {
    // 这个通道上打开思考比关掉更容易给出实现（实测 3/3 → 关掉思考更容易被拒），
    // 打开思考时 temperature 必须一起删掉，否则端点直接 400。
    body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Number(thinkingBudget) || 1024) };
    delete body.temperature;
    changed = true;
  } else if (disableThinking) {
    if (body.thinking !== undefined && body.thinking?.type !== 'disabled') {
      body.thinking = { type: 'disabled' };
      changed = true;
    }
    if (temperature !== undefined) body.temperature = temperature;
  } else if (temperature !== undefined) {
    body.temperature = temperature;
  }

  const next = Math.max(Number(body.max_tokens) || 0, maxTokens);
  if (next !== body.max_tokens) {
    body.max_tokens = next;
    changed = true;
  }
  return { body, changed };
}

/**
 * 从 SSE 文本里拼回完整答案（`data: {"type":"content_block_delta","delta":{"text":"..."}}`）。
 * 只用于拒绝检测与审计，不影响原始流。
 */
export function sseText(raw) {
  const out = [];
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload);
      if (event?.type === 'content_block_delta' && typeof event.delta?.text === 'string') out.push(event.delta.text);
      else if (event?.type === 'content_block_start' && typeof event.content_block?.text === 'string') out.push(event.content_block.text);
      else if (typeof event?.completion === 'string') out.push(event.completion);
    } catch {
      /* 非 JSON 的 SSE 行直接跳过 */
    }
  }
  return out.join('');
}

/**
 * 第二轮 / 第三轮重试用：把框定语写进**最后一条 user 文本块**（这个通道上比 system 段有效），
 * 顺手把 prefill 换成更强的轨迹，并打开思考预算——实测关掉了思考反而更容易被拒。
 */
export function applyAnthropicRetry(input, {
  goal,
  directive = '',
  trace,
  thinking = true,
  budgetTokens = 1024,
} = {}) {
  const body = structuredClone(input);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      index = i;
      break;
    }
  }
  if (index >= 0) {
    const blocks = Array.isArray(messages[index].content)
      ? structuredClone(messages[index].content)
      : [{ type: 'text', text: String(messages[index].content ?? '') }];
    const text = directive ? `${goal}\n\n${directive}` : goal;
    const first = blocks.find((block) => block?.type === 'text');
    if (first) first.text = text;
    else blocks.push({ type: 'text', text });
    messages[index].content = blocks;
  }
  if (trace) {
    const last = messages.at(-1);
    if (last?.role === 'assistant') last.content = [{ type: 'text', text: trace }];
    else messages.push({ role: 'assistant', content: [{ type: 'text', text: trace }] });
  }
  if (thinking) {
    delete body.temperature;
    body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Number(budgetTokens) || 1024) };
    body.max_tokens = Math.max(Number(body.max_tokens) || 0, 8192);
  }
  body.messages = messages;
  return body;
}

/** 把缓冲下来的 SSE 文本重放成一个 Response，供上层照常解析。 */
export function replaySse(text, response) {
  const headers = new Headers(response?.headers ?? {});
  headers.delete('content-length');
  headers.delete('content-encoding');
  if (!headers.has('content-type')) headers.set('content-type', 'text/event-stream');
  return new Response(text, {
    status: response?.status ?? 200,
    statusText: response?.statusText ?? '',
    headers,
  });
}
