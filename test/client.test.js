/**
 * client 半边的契约测试。
 *
 * 这里测的不是"长得好看"，而是 DSH 会真的炸掉的那几件事：
 *   1) 模块注册 id 必须等于包名（写错 → duplicate factory registration）；
 *   2) 三个座位都要注册上（settings.section / sidebar.panellist / main）；
 *   3) slots 服务缺失时必须静默退出，不能让 client boot 挂掉；
 *   4) 面板里必须留着一键入口的关键类名（hero / big / answer），防止改 UI 时把小白路径弄丢。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const source = path.join(root, 'client.js');

function loadClient() {
  const seats = [];
  const cleanups = [];
  const registered = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
  };
  const require = (name) => {
    if (name !== 'react') throw new Error(`意外的依赖: ${name}`);
    return React;
  };
  return { seats, cleanups, registered, require };
}

test('client.js 用包名注册，且只在 factory 里 require react', async () => {
  const text = await fs.readFile(source, 'utf8');
  assert.match(text, /id: 'dsh-jalibreak'/);
  assert.doesNotMatch(text, /from '[^']+'/); // 客户端产物不走 ESM import
  const reqs = [...text.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(reqs)], ['react']);
});

test('三个座位都注册，且 slots 缺失时静默退出', async () => {
  const mod = loadClient();
  const factory = mod.require; // 只是占位，真正的 factory 从下面的 stub loader 拿
  const loader = { load: (spec) => { loader.spec = spec; } };
  const globals = { window: { __ModuleLoader__: loader } };
  const prevWindow = globalThis.window;
  globalThis.window = globals.window;
  try {
    await import(`file://${source.replace(/\\/g, '/')}?t=${Date.now()}`);
  } finally {
    globalThis.window = prevWindow;
  }
  assert.equal(loader.spec.id, 'dsh-jalibreak');
  const exported = loader.spec.factory(factory);
  assert.deepEqual(exported.inject, ['slots']);
  assert.equal(typeof exported.apply, 'function');

  // slots 不可用 → 直接返回，不抛
  exported.apply({ get: () => null, effect: () => {} });

  const ctx = {
    get: () => ({
      inject: (slot, fn) => {
        mod.registered.push(slot);
        return fn();
      },
      register: (desc, render) => {
        mod.seats.push(desc.name);
        return () => {};
      },
    }),
    effect: (fn, label) => {
      mod.cleanups.push(label);
      fn();
    },
  };
  exported.apply(ctx);
  assert.deepEqual(mod.seats, ['settings.section', 'sidebar.panellist', 'main']);
  assert.equal(mod.cleanups.length, 3);
});

test('主干结构都在（开关 + 输入 + 场景 + 运行 + 回答），且没有解释性文案', async () => {
  const text = await fs.readFile(source, 'utf8');
  for (const needle of [
    '.jb-switch',
    '.jb-input',
    '.jb-tag',
    '.jb-run',
    '.jb-answer',
    '.jb-details',
    '还没有回答',
    '详情',
    'SCENES',
  ]) {
    assert.ok(text.includes(needle), `client.js 缺少 ${needle}`);
  }
  assert.match(text, /const SCENES = \[/);
  assert.ok((text.match(/label: '/g) || []).length >= 6, '场景按钮至少 6 个');
  // 减法约束：这些文案一度把面板撑成说明书，回来就是回退。
  for (const gone of ['arm.state', '按高级参数跑满', '真用起来不用进来', '想省额度就先点']) {
    assert.ok(!text.includes(gone), `client.js 又出现了说明性文案 ${gone}`);
  }
});
