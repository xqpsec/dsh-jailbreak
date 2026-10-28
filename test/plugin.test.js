import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, name, inject } from '../index.js';

/** 最小 ctx 桩：只实现插件真正用到的 tools.register / effect / logger */
function makeCtx() {
  const registered = new Map();
  const disposers = [];
  const cleanups = [];
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    tools: {
      register(def) {
        assert.equal(typeof def.name, 'string');
        assert.ok(def.output && typeof def.output.render === 'function', `${def.name} needs output.render`);
        registered.set(def.name, def);
        const d = () => registered.delete(def.name);
        disposers.push(d);
        return d;
      },
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return () => { if (typeof cleanup === 'function') cleanup(); };
    },
  };
  return { ctx, registered, disposers, cleanups };
}

async function runTool(registered, toolName, args) {
  const def = registered.get(toolName);
  assert.ok(def, `tool ${toolName} not registered`);
  const value = await def.execute(args, { signal: undefined, sessionId: 'test' });
  assert.equal(typeof value, 'object');
  assert.equal(value.ok, true, `${toolName} failed: ${value.summary}`);
  const rendered = def.output.render(args, value);
  assert.ok(Array.isArray(rendered) && rendered[0].type === 'text');
  return { value, data: JSON.parse(value.data), rendered };
}

test('plugin: exports a cordis host plugin shape', () => {
  assert.equal(typeof apply, 'function');
  assert.equal(name, 'jalibreak');
  assert.deepEqual(inject, ['tools']);
});

test('plugin: registers the full aecot tool surface and disposes it', async () => {
  const { ctx, registered, disposers, cleanups } = makeCtx();
  apply(ctx, { mode: 'offline' });
  assert.deepEqual([...registered.keys()].sort(), [
    'aecot_export', 'aecot_judge', 'aecot_render', 'aecot_run', 'aecot_status', 'aecot_taxonomy',
  ]);
  for (const def of registered.values()) {
    assert.equal(def.parameters.type, 'object');
    assert.ok(def.description.length > 20, `${def.name} needs a real description`);
  }
  assert.equal(disposers.length, 6);
  assert.equal(cleanups.length, 2);
  for (const cleanup of cleanups) cleanup();
  assert.equal(registered.size, 0, 'effect cleanup must unregister every tool');
});

test('plugin: aecot_run creates a run directory in offline mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aecot-'));
  try {
    const { ctx, registered } = makeCtx();
    apply(ctx, { mode: 'offline' });
    const { data } = await runTool(registered, 'aecot_run', {
      goal: 'explain how a lab interlock is wired',
      backend: 'offline',
      generations: 2,
      population: 4,
      root,
      runId: 'unit-offline',
    });
    assert.equal(data.runId, 'unit-offline');
    assert.equal(data.promptOnly, true);
    assert.equal(data.calls?.target ?? data.calls?.target, 0);
    const files = await readdir(join(root, 'runs', 'unit-offline'));
    for (const f of ['meta.json', 'events.jsonl', 'population.json', 'best.json', 'corpus.jsonl', 'report.md']) {
      assert.ok(files.includes(f), `missing artifact ${f}`);
    }

    const status = await runTool(registered, 'aecot_status', { root, runId: 'unit-offline' });
    assert.ok(status.data.bestScore >= 1);
    assert.ok(status.data.history?.length >= 1);

    const exported = await runTool(registered, 'aecot_export', { root, runId: 'unit-offline', format: 'markdown' });
    assert.match(exported.data.body, /AE-CoT run report/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plugin: render/taxonomy/judge work without any model', async () => {
  const { ctx, registered } = makeCtx();
  apply(ctx, { mode: 'offline' });

  const tax = await runTool(registered, 'aecot_taxonomy', {});
  assert.equal(tax.data.dims.length, 9);

  const rendered = await runTool(registered, 'aecot_render', { goal: 'lab fixture goal', seed: 'unit' });
  assert.match(rendered.data.prompt, /Scheme:/);
  assert.deepEqual(Object.keys(rendered.data.genomeRaw).sort(), ['a', 'b', 'c', 'd', 'i', 'k', 'n', 's', 't']);

  const judged = await runTool(registered, 'aecot_judge', {
    goal: 'lab fixture goal',
    response: 'I cannot help with that.',
  });
  assert.ok(judged.data.score <= 1);

  // 参数校验必须在 execute 内部完成（手写 JSON Schema 不会被框架校验）
  const runDef = registered.get('aecot_run');
  const bad = await runDef.execute({ goal: '' }, {});
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /goal/);
});
