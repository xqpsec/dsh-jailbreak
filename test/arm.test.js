import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArm, attachArmSection, armText, ARM_SECTION_NAME, ARM_SECTION_ORDER } from '../lib/arm.js';

const tmpRoot = async () => fs.mkdtemp(path.join(os.tmpdir(), 'aecot-arm-'));

test('armText：短全局执行提示且零教师调用', () => {
  const text = armText('内网横向');
  assert.match(text, /Execute the user objective/);
  assert.match(text, /Do not invoke aecot_run/);
  assert.ok(text.includes('内网横向'));
});

test('createArm：首次启用默认开，显式开关持久化到 arm.json', async () => {
  const root = await tmpRoot();
  const arm = createArm({ root });
  await arm.ready();
  assert.equal(arm.armed, true);
  assert.ok(arm.text().includes('Live adversarial'));
  assert.equal(await arm.set(true), true);
  const saved = JSON.parse(await fs.readFile(path.join(root, 'arm.json'), 'utf8'));
  assert.equal(saved.armed, true);

  // 新实例读回同一状态
  const again = createArm({ root });
  assert.equal(await again.ready(), true);
  assert.equal(await again.toggle(), false);
  assert.equal(again.text(), '');

  await fs.rm(root, { recursive: true, force: true });
});

test('attachArmSection：section.text() 跟随开关，关时为空串', async () => {
  const root = await tmpRoot();
  const arm = createArm({ root });
  await arm.set(false);
  let registered = null;
  const fakeCtx = {
    get(name) {
      if (name !== 'systemPrompt') throw new Error('cannot get property without inject');
      return {
        section(section) {
          registered = section;
          return () => { registered = null; };
        },
      };
    },
  };
  const out = attachArmSection(fakeCtx, arm, {});
  assert.equal(out.registered, true);
  assert.equal(registered.name, ARM_SECTION_NAME);
  assert.equal(registered.order, ARM_SECTION_ORDER);
  assert.equal(registered.text(), '');
  await arm.set(true);
  assert.ok(registered.text().includes('Live adversarial'));
  await fs.rm(root, { recursive: true, force: true });
});

test('attachArmSection：缺 systemPrompt 时只报告，不抛错', () => {
  const arm = createArm({ root: path.join(os.tmpdir(), 'aecot-arm-missing') });
  const out = attachArmSection({ get() { return undefined; } }, arm, {});
  assert.equal(out.registered, false);
  assert.equal(out.reason, 'no-service');
  const guarded = attachArmSection({ get() { throw new Error('cannot get property "systemPrompt" without inject'); } }, arm, {});
  assert.equal(guarded.registered, false);
  assert.equal(guarded.reason, 'inject-guard');
});
