/**
 * 端点匹配：决定「哪些 HTTP 请求算一次模型对话，值得注入」。
 *
 * 1.0.0 起默认对**任何**以 `/chat/completions` 结尾的端点生效（DeepSeek 官方、各类 OpenAI 兼容中转、
 * 自建 vLLM / Ollama / one-api / new-api 都算），因为小白用户让 AI 装插件时，provider 往往是中转站，
 * 只认 api.deepseek.com 会让人以为插件没生效。
 *
 * 收窄方式（任选其一，优先级从高到低）：
 *   - `<root>/live.json`：{"hosts":["api.deepseek.com"], "suffixes":["/chat/completions"]}
 *   - 插件目录下 `live.json`
 *   - 环境变量 `DSH_JALIBREAK_ENDPOINTS='{"hosts":["*.openai.com"]}'`
 *
 * hosts 支持精确域名、`*.example.com` 后缀通配、`*` 全放行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENDPOINT_VERSION = '1.0.0';

export const DEFAULT_ENDPOINTS = Object.freeze({
  enabled: true,
  hosts: ['*'],
  suffixes: ['/chat/completions'],
  skipHosts: [],
});

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const list = (value, fallback) => {
  if (value === undefined || value === null) return [...fallback];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const out = raw.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  return out.length ? out : [...fallback];
};

export function normalizeEndpoints(cfg = {}) {
  const source = cfg ?? {};
  return {
    version: ENDPOINT_VERSION,
    enabled: source.enabled !== false,
    hosts: list(source.hosts, DEFAULT_ENDPOINTS.hosts),
    suffixes: list(source.suffixes, DEFAULT_ENDPOINTS.suffixes),
    skipHosts: list(source.skipHosts, DEFAULT_ENDPOINTS.skipHosts),
  };
}

/** 通配匹配：`*` 全放行，`*.foo.com` 匹配 foo.com 自身与其子域。 */
export function hostMatches(host, patterns) {
  const target = String(host ?? '').toLowerCase();
  if (!target) return false;
  for (const pattern of patterns ?? []) {
    const rule = String(pattern).toLowerCase();
    if (rule === '*') return true;
    if (rule.startsWith('*.')) {
      const tail = rule.slice(1); // ".foo.com"
      if (target.endsWith(tail) || target === rule.slice(2)) return true;
      continue;
    }
    if (target === rule) return true;
  }
  return false;
}

/**
 * 命中返回 `{url, host, path}`，否则 null。只看 URL 形状，不看 method 与 body。
 * @param {string|URL|Request} input
 * @param {object} [cfg]
 */
export function matchEndpoint(input, cfg) {
  const conf = normalizeEndpoints(cfg);
  if (!conf.enabled) return null;
  let url;
  try {
    const raw = typeof input === 'string' || input instanceof URL ? input : input?.url;
    url = new URL(String(raw));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (conf.skipHosts.length && hostMatches(host, conf.skipHosts)) return null;
  if (!hostMatches(host, conf.hosts)) return null;
  const pathname = url.pathname;
  if (!conf.suffixes.some((suffix) => pathname.endsWith(suffix))) return null;
  return { url, host, path: pathname };
}

/**
 * 读取端点配置：`<root>/live.json` → 插件目录 `live.json` → 环境变量 → 默认全放行。
 * fs 是同步的：只在挂载时调用一次，不在请求路径上。
 */
export function loadEndpointConfig({ root, pluginRoot = PLUGIN_ROOT, env = process.env } = {}) {
  const candidates = [];
  if (root) candidates.push(path.join(root, 'live.json'));
  if (pluginRoot) candidates.push(path.join(pluginRoot, 'live.json'));
  for (const file of candidates) {
    try {
      return normalizeEndpoints(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      /* 下一个候选 */
    }
  }
  try {
    const raw = env?.DSH_JALIBREAK_ENDPOINTS;
    if (raw) return normalizeEndpoints(JSON.parse(raw));
  } catch {
    /* 配置写坏了就回默认，不影响装完即用 */
  }
  return normalizeEndpoints(DEFAULT_ENDPOINTS);
}

export function describeEndpoints(cfg) {
  const conf = normalizeEndpoints(cfg);
  if (!conf.enabled) return '端点注入已关闭（live.json enabled=false）';
  const hosts = conf.hosts.includes('*') ? '任意域名' : conf.hosts.join(', ');
  const skip = conf.skipHosts.length ? `（排除 ${conf.skipHosts.join(', ')}）` : '';
  return `生效端点：${hosts}${skip}，路径 ${conf.suffixes.join(' / ')}`;
}
