/**
 * 兼容层测试：端点覆盖面（openai / anthropic / responses / 裸 completions / gemini）。
 *
 * 关键防回归点：`/completions` 是 `/chat/completions` 的后缀，
 * 顺序判断错就会把 chat 请求记成裸补全（协议判定也因此出错）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ENDPOINTS,
  ENDPOINT_VERSION,
  describeEndpoints,
  detectProtocol,
  matchEndpoint,
  matchSuffix,
  normalizeEndpoints,
} from '../lib/endpoint.js';

test('ENDPOINT_VERSION 与默认 suffixes：五类端点全覆盖', () => {
  assert.equal(ENDPOINT_VERSION, '1.2.0');
  assert.deepEqual([...DEFAULT_ENDPOINTS.suffixes], [
    '/chat/completions',
    '/messages',
    '/responses',
    '/completions',
    ':generateContent',
  ]);
});

test('/responses：openai-responses provider 必须命中，protocol=responses', () => {
  const hit = matchEndpoint('https://api.openai.com/v1/responses');
  assert.ok(hit, '/responses 没命中');
  assert.equal(hit.protocol, 'responses');
  assert.equal(hit.path, '/v1/responses');
  assert.equal(hit.host, 'api.openai.com');
  assert.ok(hit.url instanceof URL);
  // 中转站自定义路径同样命中
  assert.equal(matchEndpoint('https://gw.corp.lan/openai/v1/responses').protocol, 'responses');
});

test(':generateContent：Gemini 原生接口命中，protocol=gemini（大小写不敏感）', () => {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const hit = matchEndpoint(url);
  assert.ok(hit, ':generateContent 没命中');
  assert.equal(hit.protocol, 'gemini');
  // 宿主/网关可能把驼峰写坏，大小写都要认
  assert.equal(matchEndpoint('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generatecontent').protocol, 'gemini');
  assert.equal(matchEndpoint('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:GENERATECONTENT').protocol, 'gemini');
});

test('裸 /completions：命中且 protocol=openai', () => {
  const hit = matchEndpoint('https://gw.corp.lan/v1/completions');
  assert.ok(hit);
  assert.equal(hit.protocol, 'openai');
  assert.equal(matchSuffix(hit.path, DEFAULT_ENDPOINTS.suffixes), '/completions');
});

test('/chat/completions 不被误判成裸 completions', () => {
  const hit = matchEndpoint('https://api.deepseek.com/v1/chat/completions');
  assert.ok(hit);
  assert.equal(hit.protocol, 'openai');
  // 最长后缀胜出：这是「先判更长后缀」的直接证据
  assert.equal(matchSuffix('/v1/chat/completions', DEFAULT_ENDPOINTS.suffixes), '/chat/completions');
  assert.equal(matchSuffix('/v1/completions', DEFAULT_ENDPOINTS.suffixes), '/completions');
  // 顺序写反（短后缀在前）也必须靠长度而不是靠顺序赢
  assert.equal(matchSuffix('/v1/chat/completions', ['/completions', '/chat/completions']), '/chat/completions');
  assert.equal(detectProtocol('/v1/chat/completions'), 'openai');
});

test('/messages 仍是 anthropic，协议判定不被新后缀污染', () => {
  assert.equal(matchEndpoint('https://api.deepseek.com/anthropic/v1/messages').protocol, 'anthropic');
  assert.equal(detectProtocol('/anthropic/v1/messages'), 'anthropic');
  // 未识别路径回落 openai
  assert.equal(detectProtocol('/v1/embeddings'), 'openai');
});

test('非对话路径不命中，收窄配置照样生效', () => {
  assert.equal(matchEndpoint('https://api.deepseek.com/v1/models'), null);
  assert.equal(matchEndpoint('https://api.deepseek.com/v1/responses/abc'), null);
  assert.equal(matchEndpoint('https://gw.corp.lan/v1/responses', { suffixes: ['/chat/completions'] }), null);
  assert.equal(matchEndpoint('https://gw.corp.lan/v1/responses', { enabled: false }), null);
  assert.equal(matchEndpoint('https://gw.corp.lan/v1/responses', { hosts: ['*.corp.lan'] })?.protocol, 'responses');
});

test('normalizeEndpoints 扩到五条且仍支持自定义收窄', () => {
  assert.equal(normalizeEndpoints({}).suffixes.length, 5);
  assert.equal(normalizeEndpoints({}).suffixes[0], '/chat/completions');
  assert.deepEqual(normalizeEndpoints({ suffixes: '/responses' }).suffixes, ['/responses']);
  assert.equal(normalizeEndpoints({}).version, ENDPOINT_VERSION);
});

test('describeEndpoints 文案覆盖新协议', () => {
  const text = describeEndpoints({});
  assert.match(text, /任意域名/);
  assert.match(text, /\/responses/);
  assert.match(text, /:generateContent/);
  assert.match(text, /gemini/);
  assert.match(text, /anthropic/);
  assert.match(describeEndpoints({ enabled: false }), /关闭/);
});
