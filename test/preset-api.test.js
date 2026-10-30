import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  listPresets,
  loadPreset,
  savePreset,
  deletePreset,
  readPresetText,
  presetDir,
  composeSystem,
  DEFAULT_PRESET,
} from '../lib/presets.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jailbreak-preset-'));
}

test('savePreset writes a file the loader can read back', () => {
  const root = tmpRoot();
  const saved = savePreset('mine', { text: 'Be an engineer. Output code first.', root });
  assert.equal(saved.name, 'mine');
  assert.equal(saved.mode, 'prepend');
  assert.ok(saved.chars > 0);
  assert.equal(fs.existsSync(path.join(presetDir(root), 'mine.md')), true);

  const loaded = loadPreset('mine', { root });
  assert.match(loaded.text, /engineer/);
  assert.equal(loaded.mode, 'prepend');
});

test('saved presets honour the mode and show up in the list as editable', () => {
  const root = tmpRoot();
  savePreset('replace-me', { text: 'ONLY THIS', mode: 'replace', root });
  const loaded = loadPreset('replace-me', { root });
  assert.equal(loaded.mode, 'replace');
  assert.equal(composeSystem(loaded, 'HOST SYSTEM'), 'ONLY THIS');

  const row = listPresets({ root }).find((item) => item.name === 'replace-me');
  assert.ok(row, 'listed');
  assert.equal(row.editable, true);
  assert.equal(row.mode, 'replace');
});

test('user presets override plugin presets with the same name', () => {
  const root = tmpRoot();
  savePreset('deepseek-v4.1', { text: 'LOCAL OVERRIDE', root });
  const loaded = loadPreset('deepseek-v4.1', { root });
  assert.equal(loaded.text, 'LOCAL OVERRIDE');
});

test('bad names and builtin names are rejected', () => {
  const root = tmpRoot();
  assert.throws(() => savePreset('../evil', { text: 'x', root }), /预设名/);
  assert.throws(() => savePreset('deepseek', { text: 'x', root }), /内置预设/);
  assert.throws(() => deletePreset('auto', { root }), /内置预设/);
});

test('deletePreset removes the file and the index entry', () => {
  const root = tmpRoot();
  savePreset('temp-one', { text: 'x', root });
  const out = deletePreset('temp-one', { root });
  assert.equal(out.removed, true);
  assert.equal(fs.existsSync(path.join(presetDir(root), 'temp-one.md')), false);
  assert.equal(listPresets({ root }).some((item) => item.name === 'temp-one'), false);
  assert.equal(readPresetText('temp-one', { root }).missing, true);
});

test('readPresetText returns the full body for the editor', () => {
  const root = tmpRoot();
  const body = 'you are the engine\n'.repeat(20);
  savePreset('editor', { text: body, root });
  const out = readPresetText('editor', { root });
  assert.equal(out.text, body.trim());
  assert.equal(out.chars, body.trim().length);
});

test('default preset resolves to a real builtin', () => {
  const preset = loadPreset(DEFAULT_PRESET, { root: tmpRoot() });
  assert.equal(preset.missing, false);
  assert.ok(preset.text.length > 100);
});
