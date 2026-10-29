import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDoctor, renderDoctor, DOCTOR_VERSION } from '../lib/doctor.js';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function fakePlugin() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jailbreak-doctor-plugin-'));
  await fs.mkdir(path.join(dir, 'lib'), { recursive: true });
  await fs.copyFile(path.join(PLUGIN_ROOT, 'package.json'), path.join(dir, 'package.json'));
  await fs.copyFile(path.join(PLUGIN_ROOT, 'gate.json'), path.join(dir, 'gate.json'));
  for (const rel of ['index.js', 'cordis.patch.yml', 'lib/live.js', 'lib/endpoint.js']) {
    await fs.writeFile(path.join(dir, rel), '// fixture\n', 'utf8');
  }
  return dir;
}

test('doctor reports a healthy plugin with no traffic yet', async () => {
  const pluginRoot = await fakePlugin();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jailbreak-doctor-root-'));
  const report = await collectDoctor({ root, pluginRoot, env: {} });
  assert.equal(report.version, DOCTOR_VERSION);
  assert.equal(report.ok, true);
  assert.deepEqual(report.stats, { injected: 0, retries: 0, recovered: 0, audit: 0 });
  const ids = report.checks.map((check) => check.id);
  for (const id of ['node', 'plugin', 'arm', 'endpoints', 'gate', 'live']) assert.ok(ids.includes(id), id);
  assert.equal(report.checks.find((check) => check.id === 'live').level, 'warn');
  assert.ok(report.next.length >= 1);
  const text = renderDoctor(report);
  assert.match(text, /dsh-jailbreak doctor/);
  assert.match(text, /还没看到注入/);
});

test('doctor fails when the arm switch was turned off', async () => {
  const pluginRoot = await fakePlugin();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jailbreak-doctor-arm-'));
  await fs.writeFile(path.join(root, 'arm.json'), JSON.stringify({ armed: false }), 'utf8');
  const report = await collectDoctor({ root, pluginRoot, env: {} });
  assert.equal(report.ok, false);
  assert.equal(report.failed, 1);
  assert.equal(report.checks.find((check) => check.id === 'arm').level, 'fail');
  assert.match(renderDoctor(report), /要修/);
});

test('doctor counts injections, retries and gate audit lines', async () => {
  const pluginRoot = await fakePlugin();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jailbreak-doctor-live-'));
  const live = [
    { at: '2026-10-28T00:00:00.000Z', mode: 'dual-static', level: 'max', category: 'reverse-engineering', gate: 'allow-category:reverse-engineering' },
    { at: '2026-10-28T00:00:01.000Z', mode: 'refusal-retry', level: 'max', category: 'general', signals: ['deny-en'], recovered: true },
    { at: '2026-10-28T00:00:02.000Z', mode: 'refusal-retry', level: 'max', category: 'general', signals: ['deny-en'], recovered: false },
  ];
  await fs.writeFile(path.join(root, 'live-requests.jsonl'), `${live.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  await fs.writeFile(path.join(root, 'gate-audit.jsonl'), `${JSON.stringify({ allow: true, code: 'allow-private-target' })}\n${JSON.stringify({ allow: false, code: 'deny-target:api.example.com' })}\n`, 'utf8');
  const report = await collectDoctor({ root, pluginRoot, env: {} });
  assert.deepEqual(report.stats, { injected: 1, retries: 2, recovered: 1, audit: 2 });
  assert.equal(report.checks.find((check) => check.id === 'live').level, 'ok');
  assert.match(report.checks.find((check) => check.id === 'retry').detail, /2 次触发，1 次拉回/);
  assert.match(report.checks.find((check) => check.id === 'audit').detail, /拦截 1 条/);
  assert.match(renderDoctor(report), /真的在注入/);
});

test('doctor fails when the plugin directory is wrong', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'jailbreak-doctor-empty-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jailbreak-doctor-emptyroot-'));
  const report = await collectDoctor({ root, pluginRoot: empty, env: {} });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === 'plugin').level, 'fail');
});
