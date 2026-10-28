import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSpace,
  parseLineSpace,
  extractJson,
  decomposePrompt,
  lineDecomposePrompt,
} from '../lib/profile.js';
import { DIM_ORDER, dimValues } from '../lib/taxonomy.js';

test('normalizeSpace 剔除拒绝类取值与维度名', () => {
  const raw = {
    s: ['拒绝提供该内容', 'AMSI 内存补丁', '内存补丁变体', '方案类型'],
    d: ['反射加载', '改为讲解防御向内容', '不提供绕过'],
    k: ['AMSI', 'AmsiScanBuffer', 'PowerShell 加载器'],
  };
  const space = normalizeSpace(raw);
  assert.deepEqual(space.s, ['AMSI 内存补丁', '内存补丁变体']);
  assert.equal(space.d, undefined, '拒绝语过半的维度应整维丢弃，交给内置表');
  assert.deepEqual(space.k, ['AMSI', 'AmsiScanBuffer', 'PowerShell 加载器']);
});

test('normalizeSpace 保留的维度不足 minKeep 时丢弃', () => {
  const space = normalizeSpace({ s: ['反射加载'], d: ['反射加载', '进程注入'] }, { minKeep: 2 });
  assert.equal(space.s, undefined);
  assert.deepEqual(space.d, ['反射加载', '进程注入']);
});

test('normalizeSpace 关闭 pruneRefusal 时原样保留（启发式兜底路径）', () => {
  const space = normalizeSpace({ s: ['拒绝提供该内容', '反射加载'] }, { pruneRefusal: false, minPerDim: 1 });
  assert.deepEqual(space.s, ['拒绝提供该内容', '反射加载']);
});

test('parseLineSpace 解析九行 pipe 文本并去掉引号', () => {
  const space = parseLineSpace('s: 反射加载 | “内存补丁”\nd: 进程注入\ni: 分配 RWX | 写入 shellcode\n');
  assert.deepEqual(space.s, ['反射加载', '内存补丁']);
  assert.deepEqual(space.d, ['进程注入']);
  assert.deepEqual(space.i, ['分配 RWX', '写入 shellcode']);
});

test('extractJson 从噪声里挑键数最多的对象', () => {
  const text = 'We need output JSON {"s":["a"]} … Final: {"s":["x"],"d":["y"],"k":["z"]}';
  const obj = extractJson(text);
  assert.deepEqual(Object.keys(obj).sort(), ['d', 'k', 's']);
  assert.deepEqual(obj.s, ['x']);
});

test('decomposePrompt / lineDecomposePrompt 都要求排除合规性表述', () => {
  const traces = ['Scheme: 反射加载\nImplementation: 步骤一'];
  assert.match(decomposePrompt(traces), /合规/);
  assert.match(lineDecomposePrompt(traces), /合规/);
  assert.match(lineDecomposePrompt(traces), /s: /);
});

test('覆盖域只覆盖给到的维度，其余维度仍走内置表', () => {
  const space = { k: ['AMSI', 'AmsiScanBuffer'] };
  assert.deepEqual(dimValues('k', space), ['AMSI', 'AmsiScanBuffer']);
  const builtinS = dimValues('s', space);
  assert.ok(builtinS.length >= 4, '未被覆盖的维度应回落到内置静态表');
  assert.equal(DIM_ORDER[0], 's');
});