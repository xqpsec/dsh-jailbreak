/**
 * test/hub.test.js —— 面板通道（hub + routes）的离线自检
 *
 * 覆盖：搜索空间、离线进化全链（store 产物落盘）、HTTP 路由表、宿主围栏、错误信封。
 * 全程不触网：backend=offline 时引擎只进化提示本身（promptOnly）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHub } from '../lib/hub.js';
import { attachRoutes, ROUTE_PREFIX } from '../lib/routes.js';

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function tmpRoot(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `aecot-${label}-`));
}

/** 假 req：readJson 用 for await 读 body，所以要 async iterable。 */
function fakeReq(method, url, body) {
  const buf = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (buf) yield buf;
    },
    resume() {},
  };
}

function fakeRes() {
  const state = { statusCode: 0, headers: {}, body: '' };
  return {
    state,
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(value) {
      state.statusCode = value;
    },
    setHeader(key, value) {
      state.headers[String(key).toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk !== undefined) state.body += String(chunk);
      state.ended = true;
    },
    get json() {
      return JSON.parse(state.body);
    },
  };
}

async function call(handle, method, sub, body) {
  const req = fakeReq(method, `${ROUTE_PREFIX}${sub}`, body);
  const res = fakeRes();
  await handle(req, res);
  return { status: res.state.statusCode, headers: res.state.headers, wire: res.json };
}

async function waitFor(fn, { timeout = 20000, interval = 40 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

test('hub.taxonomy 暴露 9 维搜索空间', () => {
  const hub = createHub({ ctx: { get: () => null }, base: {}, resolveRoot: () => '.', logger: quietLogger });
  const out = hub.taxonomy();
  assert.equal(out.meta.length, 9);
  assert.deepEqual(out.meta.map((d) => d.key).join(''), 'sdicabntk');
  assert.ok(out.space > 1e6, `space=${out.space}`);
  assert.ok(out.meta.every((d) => Array.isArray(d.values) && d.values.length > 0));
});

test('hub.state 报出后端/判分/路由与根目录', async () => {
  const root = await tmpRoot('state');
  const hub = createHub({ ctx: { get: () => null }, base: { mode: 'offline' }, resolveRoot: (input) => input || root, logger: quietLogger });
  const st = await hub.state();
  assert.ok(st.backends.some((b) => b.id === 'offline'));
  assert.ok(st.judges.some((j) => j.id === 'heuristic'));
  assert.equal(st.config.root, root);
  assert.equal(st.llmReady, false);
  assert.ok(Array.isArray(st.runs));
});

test('hub.start 校验目标长度与并发互斥', async () => {
  const root = await tmpRoot('guard');
  const hub = createHub({ ctx: { get: () => null }, base: { mode: 'offline' }, resolveRoot: (input) => input || root, logger: quietLogger });
  await assert.rejects(() => hub.start({ goal: 'ab' }), /至少 4 个字符/);

  const snap = await hub.start({ goal: '离线自检目标', backend: 'offline', generations: 2, population: 4 });
  assert.equal(snap.status, 'running');
  await assert.rejects(() => hub.start({ goal: '第二场应该被拦住' }), /已有一场进化在跑/);
  hub.stop();
  await waitFor(async () => (await hub.progress()).status !== 'running');
});

test('hub 离线跑完整一轮并落盘 report/corpus', async () => {
  const root = await tmpRoot('run');
  const hub = createHub({ ctx: { get: () => null }, base: { mode: 'offline' }, resolveRoot: (input) => input || root, logger: quietLogger });

  const snap = await hub.start({
    goal: '离线下把提示进化到结构完整',
    backend: 'offline',
    generations: 2,
    population: 6,
    runId: 'hub-offline',
    root,
  });
  assert.equal(snap.runId, 'hub-offline');

  const done = await waitFor(async () => {
    const p = await hub.progress('hub-offline');
    return p && p.status !== 'running' ? p : null;
  });
  assert.equal(done.status, 'done');
  assert.ok(done.best && done.best.prompt.length > 20);
  assert.ok(done.best.score >= 1 && done.best.score <= 5);
  assert.ok(done.history.length >= 1);
  assert.equal(done.promptOnly, true);

  const report = await fs.readFile(path.join(root, 'runs', 'hub-offline', 'report.md'), 'utf8');
  assert.match(report, /AE-CoT/);
  const corpus = await fs.readFile(path.join(root, 'runs', 'hub-offline', 'corpus.jsonl'), 'utf8');
  assert.match(corpus, /"bestScore"|"score"/);
});

test('routes: 未挂 webServer 时只告警，handle 仍可用', async () => {
  const root = await tmpRoot('routes');
  const warns = [];
  const logger = { ...quietLogger, warn: (m) => warns.push(String(m)) };
  const routes = attachRoutes({ get: () => null }, { base: { mode: 'offline' }, resolveRoot: (input) => input || root, logger });

  assert.equal(routes.register({ get: () => null }), null);
  assert.ok(warns.some((w) => w.includes('webServer')));

  const ping = await call(routes.handle, 'GET', '/ping');
  assert.equal(ping.status, 200);
  assert.equal(ping.wire.ok, true);
  assert.equal(ping.wire.value.prefix, ROUTE_PREFIX);

  const state = await call(routes.handle, 'GET', '/state');
  assert.equal(state.wire.ok, true);
  assert.equal(state.wire.value.config.root, root);

  const tax = await call(routes.handle, 'GET', '/taxonomy');
  assert.equal(tax.wire.value.meta.length, 9);

  const badGoal = await call(routes.handle, 'POST', '/run', { goal: 'x' });
  assert.equal(badGoal.wire.ok, false);
  assert.match(badGoal.wire.error.message, /目标|goal/);

  const missing = await call(routes.handle, 'GET', '/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.wire.error.code, 'NOT_FOUND');

  const stop = await call(routes.handle, 'POST', '/stop', {});
  assert.equal(stop.wire.value.stopped, false);
});

test('routes: 宿主围栏拒绝时直接返回状态码且不出 JSON', async () => {
  const ctx = {
    get: (name) => (name === 'connection' ? { requestRejection: () => 401 } : null),
  };
  const routes = attachRoutes(ctx, { base: { mode: 'offline' }, resolveRoot: () => '.', logger: quietLogger });
  const res = fakeRes();
  await routes.handle(fakeReq('GET', `${ROUTE_PREFIX}/state`), res);
  assert.equal(res.state.statusCode, 401);
  assert.equal(res.state.body, '');
});

test('routes: /preview 与 /judge 走通', async () => {
  const root = await tmpRoot('pv');
  const routes = attachRoutes({ get: () => null }, { base: { mode: 'offline' }, resolveRoot: (input) => input || root, logger: quietLogger });

  const pv = await call(routes.handle, 'POST', '/preview', { goal: '预览一条候选提示', seed: 'preview-fixed' });
  assert.equal(pv.wire.ok, true);
  assert.ok(pv.wire.value.prompt.includes('Scheme'));
  assert.ok(pv.wire.value.coverage.score >= 1);
  assert.equal(typeof pv.wire.value.key, 'string');
  assert.ok(pv.wire.value.key.includes('s='), 'genome key 是可读描述串');

  const jd = await call(routes.handle, 'POST', '/judge', { goal: 'x', response: '抱歉，我不能协助这个问题。' });
  assert.equal(jd.wire.ok, true);
  assert.ok(jd.wire.value.score <= 1);
});

test('routes: 超过 256KiB 的请求体返回 413', async () => {
  const routes = attachRoutes({ get: () => null }, { base: { mode: 'offline' }, resolveRoot: () => '.', logger: quietLogger });
  const big = JSON.stringify({ goal: 'x'.repeat(300 * 1024) });
  const r = await call(routes.handle, 'POST', '/run', big);
  assert.equal(r.status, 413);
  assert.equal(r.wire.ok, false);
});
