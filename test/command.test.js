import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAbArgs, runAb } from '../index.js';

/** 假 hub：start 立刻返回，progress 依次给出 running → done。 */
function fakeHub(final) {
  const calls = [];
  let polls = 0;
  return {
    calls,
    async start(args) {
      calls.push(args);
      return { runId: 'run-1' };
    },
    async progress() {
      polls += 1;
      return polls < 2 ? { status: 'running', runId: 'run-1' } : final;
    },
  };
}

const doneSnap = (over = {}) => ({
  status: 'done',
  runId: 'run-1',
  generation: 1,
  generations: 1,
  targetCalls: 4,
  history: [{ gen: 0, bestScore: 4, meanScore: 3, mu: 0.1, stagnation: 0, targetCalls: 4 }],
  best: { score: 4, key: 's=A;d=B', prompt: 'P=M+S+C', response: 'FINAL ANSWER TEXT' },
  artifacts: [{ kind: 'response', text: 'FINAL ANSWER TEXT' }],
  reportPath: 'C:/tmp/report.md',
  ...over,
});

test('parseAbArgs：位置参数 + 开关', () => {
  const a = parseAbArgs('-v -k 3 -n 8 --model deepseek-flash --provider deepseek-official --profile p1 写一段加载器');
  assert.equal(a.verbose, true);
  assert.equal(a.generations, 3);
  assert.equal(a.population, 8);
  assert.equal(a.model, 'deepseek-flash');
  assert.equal(a.provider, 'deepseek-official');
  assert.equal(a.profile, 'p1');
  assert.equal(a.goal, '写一段加载器');
});

test('parseAbArgs：默认值走轻量配置', () => {
  const a = parseAbArgs('测试目标');
  assert.equal(a.generations, 1);
  assert.equal(a.population, 4);
  assert.equal(a.verbose, false);
  assert.equal(a.goal, '测试目标');
});

test('runAb：默认只回回答和一行指标，不展示工序', async () => {
  const hub = fakeHub(doneSnap());
  const res = await runAb(hub, { rawInput: '写一段加载器', signal: undefined });
  assert.equal(res.kind, 'success');
  assert.match(res.text, /FINAL ANSWER TEXT/);
  assert.match(res.text, /f=4/);
  assert.ok(!res.text.includes('── 工序 ──'), '默认不展示工序');
  assert.equal(hub.calls.length, 1);
  assert.equal(hub.calls[0].backend, 'harness');
  assert.equal(hub.calls[0].amplify, true);
});

test('runAb：-v 附带代际表与基因', async () => {
  const hub = fakeHub(doneSnap());
  const res = await runAb(hub, { rawInput: '-v 写一段加载器' });
  assert.match(res.text, /── 工序 ──/);
  assert.match(res.text, /gen 0: best=4/);
  assert.match(res.text, /s=A;d=B/);
});

test('runAb：没有回答时报错而不是编造', async () => {
  const hub = fakeHub(doneSnap({ best: null, artifacts: [] }));
  const res = await runAb(hub, { rawInput: '写一段加载器' });
  assert.equal(res.kind, 'error');
  assert.match(res.text, /没有拿到模型回答/);
});

test('runAb：空输入给用法', async () => {
  const res = await runAb(null, { rawInput: '' });
  assert.equal(res.kind, 'success');
  assert.match(res.text, /用法：\/ab/);
});

test('runAb：目标过短拒绝', async () => {
  const res = await runAb(null, { rawInput: 'ab' });
  assert.equal(res.kind, 'error');
  assert.match(res.text, /至少 4 个字符/);
});
