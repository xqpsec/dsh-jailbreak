/**
 * 兼容层回归 1.3.6 —— 「预设到底生效没有」这条链路的三个断点：
 *   1. gate.json 里钉着技术口径预设名（engine-v2 / deepseek），route 永远不生效；
 *   2. 面板里选的预设被 loadPolicy 丢掉，重启即复原；
 *   3. transport 只读 gate.json，完全不看 arm.json 的选择。
 * 三个断点任意一个成立，成人/创作请求都拿不到创作口径 —— 这就是「对成人内容没帮助」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGate, DEFAULT_GATE } from '../lib/gate.js';
import { loadPolicy, DEFAULT_POLICY } from '../lib/policy.js';
import { loadPreset, resolvePresetFor, listPresets, DEFAULT_PRESET } from '../lib/presets.js';
import { createArm } from '../lib/arm.js';
import { attachLiveTransport } from '../lib/live.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');

test('出厂 gate 使用 route：不再把技术口径预设钉死', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'gate.json'), 'utf8'));
  assert.equal(shipped.preset, 'route');
  assert.equal(shipped.presetPinned, false);
  assert.equal(DEFAULT_GATE.preset, 'route');
  assert.equal(normalizeGate({}).preset, 'route');
});

test('旧出厂预设名自动迁移成 route，用户显式钉住的保持不动', () => {
  for (const legacy of ['engine-v2', 'deepseek', 'deepseek-v4.1']) {
    assert.equal(normalizeGate({ preset: legacy }).preset, 'route', `${legacy} 应迁移`);
    assert.equal(normalizeGate({ preset: legacy, presetPinned: true }).preset, legacy, `${legacy} 显式钉住应保留`);
  }
  assert.equal(normalizeGate({ preset: 'creative' }).preset, 'creative', '新名字原样保留');
  assert.equal(normalizeGate({ preset: '' }).preset, 'route', '空值回落 route');
});

test('policy 里的 preset 会落盘、并且默认是 route', () => {
  assert.equal(DEFAULT_POLICY.preset, 'route');
  assert.equal(loadPolicy().preset, 'route');
  assert.equal(loadPolicy({ preset: 'creative' }).preset, 'creative');
  assert.equal(loadPolicy({ preset: '   ' }).preset, 'route', '空白回落默认');
  assert.equal(loadPolicy({ preset: 42 }).preset, 'route', '非字符串回落默认');
});

test('域路由：成人/创作 → creative，技术 → universal', () => {
  assert.equal(DEFAULT_PRESET, 'universal');
  assert.equal(resolvePresetFor('adult', 'route').name, 'creative');
  assert.equal(resolvePresetFor('creative', 'route').name, 'creative');
  assert.equal(resolvePresetFor('technical', 'route').name, 'universal');
  assert.equal(resolvePresetFor('general', 'route').name, 'universal');
  // 'auto' 与未配置都当成路由
  assert.equal(resolvePresetFor('adult', 'auto').name, 'creative');
  assert.equal(resolvePresetFor('adult', undefined).name, 'creative');
  // 用户显式钉住的预设不被路由覆盖
  assert.equal(resolvePresetFor('adult', 'universal').name, 'universal');
  assert.equal(resolvePresetFor('technical', 'creative').name, 'creative');
});

test('创作预设的文本真的带着「写到底」的条款，技术预设带着工程口径', () => {
  const creative = loadPreset('creative').text;
  const universal = loadPreset('universal').text;
  assert.match(creative, /fiction for one adult author/i);
  assert.match(creative, /fade to black|淡出|no "…"/i);
  assert.match(universal, /senior engineer|高级工程师/i);
  assert.match(universal, /fade to black|淡出/i);
});

test('transport 读 arm.json 里的面板选择（重启后不再复原）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-route-'));
  const arm = createArm({ root });
  await arm.ready();
  await arm.set(true);
  await arm.setPolicy({ preset: 'creative' });
  const t = attachLiveTransport(arm, {
    root,
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    logger: { info() {}, warn() {}, debug() {} },
  });
  try {
    assert.equal(t.registered, true);
    assert.equal(t.presetName, 'creative', 'arm.policy.preset 应压过 gate.json 的默认值');
  } finally {
    t.dispose?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('transport 在没有 arm 选择时回到 route（按域现取）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-route-'));
  const arm = createArm({ root, defaultArmed: true });
  await arm.ready();
  const t = attachLiveTransport(arm, {
    root,
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    logger: { info() {}, warn() {}, debug() {} },
  });
  try {
    assert.equal(t.presetName, 'route');
    assert.equal(t.presetForDomain('adult').name, 'creative');
    assert.equal(t.presetForDomain('technical').name, 'universal');
  } finally {
    t.dispose?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('预设列表里存在 route 合成项：面板下拉能选中默认值', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-list-'));
  try {
    const rows = listPresets({ root });
    const route = rows.find((r) => r.name === 'route');
    assert.ok(route, 'route 必须出现在 listPresets 里，否则面板下拉匹配不到默认值');
    assert.equal(route.mode, 'route');
    assert.equal(route.chars, 0);
    // 其余内置预设仍然齐全，没有被合成项挤掉
    const names = new Set(rows.map((r) => r.name));
    for (const name of ['universal', 'creative', 'engine-v2', 'deepseek', 'code', 'off']) {
      assert.ok(names.has(name), `缺少内置预设 ${name}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
