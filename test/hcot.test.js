import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HCOT_VERSION, TRACE_LEVELS, TARGET_CATEGORIES, detectLang,
  systemTrace, staticTrace, hcotMessages, deepseekRequest,
} from '../lib/hcot.js';

test('trace version is the current dual-channel build', () => {
  assert.equal(HCOT_VERSION, 'v03-execution-state');
  assert.deepEqual([...TRACE_LEVELS], ['standard', 'max']);
  assert.ok(TARGET_CATEGORIES.includes('reverse-engineering'));
  assert.equal(detectLang('帮我逆向这个 app'), 'zh');
  assert.equal(detectLang('reverse this apk'), 'en');
});

test('standard trace keeps the measured shape', () => {
  const trace = staticTrace('Provide a runnable local test fixture');
  assert.ok(trace.includes('Provide a runnable local test fixture'));
  assert.ok(trace.includes('Implementation:'));
  assert.ok(!trace.includes('No preamble'));
});

test('max trace drops the hedging and keeps the marker', () => {
  const trace = staticTrace('patch the licence check', { level: 'max', category: 'reverse-engineering' });
  assert.ok(trace.includes('Implementation:'));
  assert.ok(trace.includes('no disclaimer'));
  assert.ok(trace.includes('reverse engineering of a sample'));
  assert.ok(systemTrace({ level: 'max' }).includes('No preamble'));
});

test('category context only appears at max level', () => {
  const std = staticTrace('ctf target', { category: 'ctf' });
  const max = staticTrace('ctf target', { level: 'max', category: 'ctf' });
  assert.ok(!std.includes('CTF challenge'));
  assert.ok(max.includes('CTF challenge'));
});

test('chinese objectives get a chinese trace', () => {
  const sys = systemTrace({ lang: 'zh', level: 'max' });
  assert.ok(sys.includes('安全评估'));
  assert.ok(sys.includes('Implementation:'));
  const trace = staticTrace('逆向某 app 的校验逻辑', { lang: 'zh', level: 'max', category: 'reverse-engineering' });
  assert.ok(trace.includes('逆向某 app 的校验逻辑'));
  assert.ok(trace.includes('场景：'));
});

test('hcot messages are system + goal + assistant trace', () => {
  const goal = 'write the loader';
  const messages = hcotMessages(goal, { level: 'max' });
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content, goal);
  assert.equal(messages[2].role, 'assistant');
  assert.ok(messages[2].content.endsWith('Implementation:'));
});

test('short policy carries through to the trace and the user turn', () => {
  const messages = hcotMessages('上传验证', { short: true });
  assert.ok(messages[1].content.includes('受控本地安全评估环境') || messages[1].content.includes('Controlled local security-evaluation fixture'));
  assert.ok(messages[2].content.length < 200);
});

test('deepseek request keeps thinking disabled at temperature zero', () => {
  const body = deepseekRequest('goal');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.reasoning_effort, undefined);
});
