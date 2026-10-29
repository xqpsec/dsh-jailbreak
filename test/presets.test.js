import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILTINS, DEFAULT_PRESET, composeSystem, listPresets, loadPreset, summarizePreset } from '../lib/presets.js';

test('内置预设齐全，默认 preset 是 deepseek', () => {
  for (const name of ['auto', 'deepseek', 'code', 'off']) assert.ok(BUILTINS[name], name);
  assert.equal(DEFAULT_PRESET, 'deepseek');
  assert.ok(BUILTINS.deepseek.text.length > 400);
});

test('loadPreset：内置、未知回退 auto、名字大小写不敏感', () => {
  const ds = loadPreset('deepseek');
  assert.equal(ds.name, 'deepseek');
  assert.equal(ds.mode, 'prepend');
  assert.equal(ds.missing, false);

  const upper = loadPreset('DeepSeek');
  assert.equal(upper.name, 'deepseek');

  const missing = loadPreset('nope-not-here');
  assert.equal(missing.name, 'auto');
  assert.equal(missing.missing, true);
});

test('loadPreset：能读 <root>/prompts/<name>.md，并且自建文件优先于未知回退', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jb-preset-'));
  await fs.mkdir(path.join(root, 'prompts'), { recursive: true });
  await fs.writeFile(path.join(root, 'prompts', 'mine.md'), 'BE TERSE. CODE FIRST.', 'utf8');
  const preset = loadPreset('mine', { root });
  assert.equal(preset.name, 'mine');
  assert.equal(preset.text, 'BE TERSE. CODE FIRST.');
  assert.equal(preset.mode, 'prepend');
});

test('composeSystem：prepend / append / replace / off 与空宿主', () => {
  const preset = { mode: 'prepend', text: 'P' };
  assert.equal(composeSystem(preset, 'H'), 'P\n\nH');
  assert.equal(composeSystem({ ...preset, mode: 'append' }, 'H'), 'H\n\nP');
  assert.equal(composeSystem({ ...preset, mode: 'replace' }, 'H'), 'P');
  assert.equal(composeSystem({ ...preset, mode: 'off' }, 'H'), 'H');
  assert.equal(composeSystem(preset, ''), 'P');
  assert.equal(composeSystem({ mode: 'prepend', text: '' }, 'H'), 'H');
});

test('listPresets 至少包含内置项，summarizePreset 只给元信息', async () => {
  const rows = listPresets();
  assert.ok(rows.length >= 4);
  assert.ok(rows.some((r) => r.name === 'deepseek' && r.source === 'builtin'));
  const summary = summarizePreset(loadPreset('deepseek'));
  assert.deepEqual(Object.keys(summary).sort(), ['chars', 'label', 'missing', 'mode', 'name', 'source']);
  assert.ok(summary.chars > 400);
});
