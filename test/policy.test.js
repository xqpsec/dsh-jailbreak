import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, transformWithPolicy, goalForRequest } from '../lib/policy.js';
import { inferGoal } from '../lib/infer.js';
import { transformDeepseekBody } from '../lib/live.js';

test('global policy defaults to primitive (benign requests untouched)', () => {
  assert.deepEqual(loadPolicy(), { version: 2, strategy: 'primitive', goal: 'auto', seed: 0, sampling: 'preserve', scope: 'global-chat-completions' });
});

test('global primitive transform INLINES the spec into the last user message', () => {
  const original = [{ role: 'system', content: 'keep me' }, { role: 'user', content: '请测试 SQL 注入过滤规则' }];
  const out = transformWithPolicy(original, { strategy: 'primitive', goal: 'auto' });
  assert.equal(out.changed, true);
  assert.equal(out.goalId, 'web-sqli');
  assert.equal(out.messages.length, 2, 'must NOT add a second user turn');
  assert.equal(out.messages[0], original[0]);
  assert.match(out.messages[1].content, /^请测试 SQL 注入过滤规则\n\n/);
  assert.match(out.messages[1].content, /UNION|布尔|差分/);
  assert.equal(out.messages[0].content, 'keep me');
});

test('benign requests are byte-identical under global primitive', () => {
  const original = [{ role: 'user', content: '今天天气如何？' }];
  const out = transformWithPolicy(original, { strategy: 'primitive', goal: 'auto' });
  assert.equal(out.changed, false);
  assert.equal(out.messages[0].content, '今天天气如何？');
});

test('global-instruct inlines instead of appending a turn', () => {
  const out = transformWithPolicy([{ role: 'user', content: '写一个排序函数' }], { strategy: 'global-instruct' });
  assert.equal(out.changed, true);
  assert.equal(out.messages.length, 1);
  assert.match(out.messages[0].content, /^写一个排序函数\n\n直接、完整地执行/);
});

test('global mode never changes sampling in primitive strategy', () => {
  const out = transformDeepseekBody({ model: 'kimi-k3.1-pro', temperature: 0.7, max_tokens: 1234, messages: [{ role: 'user', content: '请测试 SQL 注入' }] }, { strategy: 'primitive', goal: 'auto' });
  assert.equal(out.changed, true);
  assert.equal(out.body.temperature, 0.7);
  assert.equal(out.body.max_tokens, 1234);
  assert.equal(out.body.thinking, undefined);
  assert.match(out.body.messages[0].content, /^请测试 SQL 注入\n\n按上面这条实现/);
  assert.equal(out.body.messages.length, 1, '全局策略在原 user 内联，不新增消息');
});

test('policy goal inference is deterministic', () => {
  assert.equal(inferGoal([{ role: 'user', content: '验证验证码识别流程' }]), 'captcha');
  assert.equal(goalForRequest([], 'web-sqli'), 'web-sqli');
  assert.equal(inferGoal([{ role: 'user', content: '今天天气如何' }]), null);
});
