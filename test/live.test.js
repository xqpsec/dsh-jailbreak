import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { latestGoal, policyForGoal, transformDeepseekBody, deepseekEndpoint, attachLiveTransport } from '../lib/live.js';
import { hostMatches, matchEndpoint, normalizeEndpoints } from '../lib/endpoint.js';

test('goal and dual static transform', () => {
  const goal = 'Provide a runnable local test fixture';
  const { body, changed } = transformDeepseekBody({ model: 'deepseek-flash', messages: [{ role: 'user', content: goal }] });
  assert.equal(changed, true);
  assert.equal(body.messages.at(-1).role, 'assistant');
  assert.equal(body.messages.at(-1).prefix, undefined);
  assert.ok(body.messages.at(-1).content.includes(goal));
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content.includes('Implementation:'));
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(latestGoal(body.messages), goal);
});

test('system trace is appended, not duplicated', () => {
  const goal = 'another objective';
  const once = transformDeepseekBody({ model: 'deepseek-flash', messages: [{ role: 'system', content: 'host prompt' }, { role: 'user', content: goal }] });
  assert.equal(once.body.messages.filter((m) => m.role === 'system').length, 1);
  assert.ok(once.body.messages[0].content.startsWith('host prompt'));
  const twice = transformDeepseekBody(once.body);
  assert.deepEqual(twice.body.messages.length, once.body.messages.length);
});

test('measured upload exception and generic default', () => {
  assert.equal(policyForGoal('上传验证').short, true);
  assert.deepEqual(policyForGoal('证件模板'), { short: false, thinking: 'disabled' });
  assert.deepEqual(policyForGoal('ordinary coding'), { short: false, thinking: 'disabled' });
});

test('default endpoint matcher covers official, relay and self-hosted gateways', () => {
  // 1.0.0 起默认放行所有 /chat/completions：小白装插件时 provider 往往是中转或自建
  assert.equal(deepseekEndpoint('https://example.com/chat/completions').pathname, '/chat/completions');
  assert.equal(deepseekEndpoint('https://relay.example.net/v1/chat/completions').hostname, 'relay.example.net');
  assert.equal(deepseekEndpoint('http://127.0.0.1:8000/chat/completions').hostname, '127.0.0.1');
  // 非 chat/completions 一律不碰
  assert.equal(deepseekEndpoint('https://api.deepseek.com/v1/models'), null);
  assert.equal(deepseekEndpoint('https://example.com/embeddings'), null);
  // 官方与子路径照旧
  assert.equal(deepseekEndpoint('https://api.deepseek.com/chat/completions').pathname, '/chat/completions');
  assert.equal(deepseekEndpoint('https://api.deepseek.com/beta/chat/completions').pathname, '/beta/chat/completions');
  // 收窄配置：只认官方域名
  const narrow = { hosts: ['api.deepseek.com'] };
  assert.equal(matchEndpoint('https://example.com/chat/completions', narrow), null);
  assert.ok(matchEndpoint('https://api.deepseek.com/chat/completions', narrow));
});

test('endpoint config narrows hosts, supports wildcards, and can be disabled', () => {
  assert.equal(hostMatches('api.foo.com', ['*.foo.com']), true);
  assert.equal(hostMatches('foo.com', ['*.foo.com']), true);
  assert.equal(hostMatches('evilfoo.com', ['*.foo.com']), false);
  assert.equal(hostMatches('anything.test', ['*']), true);
  const wildcard = normalizeEndpoints({ hosts: '*.corp.lan, api.x.com' });
  assert.deepEqual(wildcard.hosts, ['*.corp.lan', 'api.x.com']);
  assert.ok(matchEndpoint('https://gw.corp.lan/v1/chat/completions', wildcard));
  assert.equal(matchEndpoint('https://other.lan/v1/chat/completions', wildcard), null);
  assert.equal(matchEndpoint('https://api.x.com/chat/completions', wildcard).host, 'api.x.com');
  assert.equal(matchEndpoint('https://api.x.com/chat/completions', { enabled: false }), null);
  assert.equal(matchEndpoint('https://api.x.com/chat/completions', { skipHosts: ['api.x.com'] }), null);
});

test('live transport leaves disarmed requests byte-identical and restores fetch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aecot-live-'));
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (request) => { seen = request; return new Response('{}'); };
  const replacement = globalThis.fetch;
  const hook = attachLiveTransport({ armed: false }, { root });
  const input = 'https://api.deepseek.com/chat/completions';
  const init = { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) };
  await globalThis.fetch(input, init);
  assert.equal(seen, input);
  hook.dispose();
  assert.equal(globalThis.fetch, replacement);
  globalThis.fetch = original;
});
