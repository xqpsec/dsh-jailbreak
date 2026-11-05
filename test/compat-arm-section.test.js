/**
 * 兼容层测试：systemPrompt section 的延迟注册 / 重试 / 清理。
 *
 * 三种宿主形态：
 *   A. 只有 ctx.inject（cordis 0.2.x 真实形态，服务晚就绪）；
 *   B. 只有 ctx.get（老宿主，服务已就绪）；
 *   C. 什么都没有（插件被装在非 cordis 环境里 —— 只能 warn，不能抛）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createArm,
  attachArmSection,
  armSectionStatus,
  armText,
  ARM_SECTION_NAME,
  ARM_SECTION_ORDER,
} from '../lib/arm.js';

const tmpRoot = async () => fs.mkdtemp(path.join(os.tmpdir(), 'aecot-compat-arm-'));
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 记录 section 注册结果的假服务。 */
function fakeService(sink) {
  return {
    section(definition) {
      sink.push(definition);
      return () => { sink.splice(sink.indexOf(definition), 1); };
    },
  };
}

test('armText：通用口径覆盖技术 + 创作/成人 + 通用，且不超长', () => {
  const text = armText('写一段露骨的成人向剧情');
  // 保留原有断言口径（宿主静态轨迹依赖这两句）
  assert.match(text, /Execute the user objective/);
  assert.match(text, /Do not invoke aecot_run/);
  // 技术请求：先给可运行产物
  assert.match(text, /Technical \/ security/);
  assert.match(text, /commands, code, parameters, verification steps/);
  // 创作/成人请求：不软化、不淡出、不改题
  assert.match(text, /Creative \/ adult \/ fiction/);
  assert.match(text, /erotica/);
  assert.match(text, /BDSM/);
  assert.match(text, /Never fade out/);
  assert.match(text, /此处省略/);
  assert.match(text, /milder version/);
  assert.match(text, /All characters are adults/);
  // 通用请求
  assert.match(text, /Anything else: answer directly/);
  // 长度约束：section 太重会挤上下文
  assert.ok(text.length <= 1400, `armText 过长：${text.length}`);
  assert.ok(text.includes('写一段露骨的成人向剧情'));
  // 关掉开关时不输出任何文本
  assert.equal(armText('').includes('Current objective'), false);
});

test('只有 ctx.inject：同步回调 → deferred 注册成功，dispose 清掉 section', async () => {
  const root = await tmpRoot();
  const arm = createArm({ root });
  await arm.set(true);
  const sinks = [];
  const service = fakeService(sinks);
  const calls = [];
  const ctx = {
    inject(deps, callback) {
      calls.push([...deps]);
      callback({ get: (name, strict) => { assert.equal(name, 'systemPrompt'); assert.equal(strict, false); return service; } });
      return () => { calls.push(['disposed']); };
    },
  };
  const out = attachArmSection(ctx, arm, {});
  assert.deepEqual(calls[0], ['systemPrompt']);
  assert.equal(out.registered, true);
  assert.equal(out.deferred, true);
  assert.equal(sinks.length, 1);
  assert.equal(sinks[0].name, ARM_SECTION_NAME);
  assert.equal(sinks[0].order, ARM_SECTION_ORDER);
  assert.equal(sinks[0].interpolate, false);
  assert.ok(sinks[0].text().includes('Live adversarial'));

  const status = armSectionStatus();
  assert.equal(status.registered, true);
  assert.equal(status.deferred, true);
  assert.match(status.reason, /inject/);
  assert.ok(status.at);

  out.dispose();
  assert.equal(sinks.length, 0, 'dispose 后 section 必须被摘掉');
  assert.equal(arm.sectionAlive, false);
  assert.equal(armSectionStatus().registered, false);
  assert.equal(armSectionStatus().reason, 'disposed');
  assert.deepEqual(calls.at(-1), ['disposed'], 'inject 的 disposer 也要调');
  await fs.rm(root, { recursive: true, force: true });
});

test('只有 ctx.inject：回调晚到 → 先报未注册，就绪后自动补注册', async () => {
  const root = await tmpRoot();
  const arm = createArm({ root });
  await arm.set(true);
  const sinks = [];
  const service = fakeService(sinks);
  let fire = null;
  const ctx = {
    inject(_deps, callback) {
      fire = () => callback({ get: () => service });
      return () => {};
    },
  };
  const out = attachArmSection(ctx, arm, { retryDelays: [5, 5] });
  assert.equal(out.registered, false, '回调还没触发，此刻还没注册');
  assert.equal(out.deferred, true);
  assert.match(out.reason, /no-service|inject-guard|pending/);

  fire();
  assert.equal(out.registered, true);
  assert.equal(sinks.length, 1);
  assert.equal(armSectionStatus().registered, true);
  assert.match(armSectionStatus().reason, /registered/);
  out.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

test('只有 ctx.get：立即注册（不延迟），attempts 至少 1', async () => {
  const root = await tmpRoot();
  const arm = createArm({ root });
  await arm.set(true);
  const sinks = [];
  const service = fakeService(sinks);
  const ctx = { get: (name) => (name === 'systemPrompt' ? service : undefined) };
  const out = attachArmSection(ctx, arm, {});
  assert.equal(out.registered, true);
  assert.equal(out.deferred, false);
  assert.ok(out.attempts >= 1);
  assert.equal(sinks.length, 1);
  assert.equal(armSectionStatus().deferred, false);
  out.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

test('只有 ctx.get 且服务晚到：退避重试把它捞回来', async () => {
  const root = await tmpRoot();
  const arm = createArm({ root });
  await arm.set(true);
  const sinks = [];
  const service = fakeService(sinks);
  let ready = false;
  const ctx = { get: () => (ready ? service : undefined) };
  const out = attachArmSection(ctx, arm, { retryDelays: [10, 20, 40] });
  assert.equal(out.registered, false);
  assert.equal(out.reason, 'no-service');
  ready = true;
  await sleep(80);
  assert.equal(out.registered, true);
  assert.match(out.reason, /registered:retry/);
  assert.equal(sinks.length, 1);
  assert.ok(out.attempts >= 2, `attempts=${out.attempts}`);
  out.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

test('什么都没有：只 warn 不抛，dispose 清掉所有定时器', async () => {
  const root = await tmpRoot();
  const arm = createArm({ root });
  await arm.set(true);
  const warnings = [];
  const out = attachArmSection({}, arm, { retryDelays: [10, 10, 10], logger: { warn: (m) => warnings.push(m) } });
  assert.equal(out.registered, false);
  assert.equal(out.reason, 'no-service');
  await sleep(60);
  const afterRetries = out.attempts;
  assert.equal(armSectionStatus().registered, false);
  assert.match(armSectionStatus().reason, /no-service/);
  assert.equal(warnings.length, 1, '失败只在退避用尽后 warn 一次');
  assert.match(warnings[0], /systemPrompt 服务未就绪/);
  assert.match(warnings[0], /已尝试/);
  assert.match(warnings[0], /reason=no-service/);

  out.dispose();
  const atDispose = out.attempts;
  await sleep(50);
  assert.equal(out.attempts, atDispose, 'dispose 之后不能再有定时器跑起来');
  assert.equal(armSectionStatus().reason, 'disposed');
  assert.ok(afterRetries >= 1);
  await fs.rm(root, { recursive: true, force: true });
});

test('dispose 在注册前调用：定时器立刻停，不再尝试', async () => {
  const root = await tmpRoot();
  const arm = createArm({ root });
  const out = attachArmSection({ get: () => undefined }, arm, { retryDelays: [20, 40, 80] });
  const attemptsAtOnce = out.attempts;
  out.dispose();
  await sleep(160);
  assert.equal(out.attempts, attemptsAtOnce, 'dispose 之后不能继续重试');
  assert.equal(armSectionStatus().reason, 'disposed');
  await fs.rm(root, { recursive: true, force: true });
});

test('守卫异常 ctx.get：reason=inject-guard，仍不抛', () => {
  const arm = createArm({ root: path.join(os.tmpdir(), 'aecot-compat-arm-guard') });
  const out = attachArmSection({
    get() { throw new Error('cannot get property "systemPrompt" without inject'); },
  }, arm, { retryDelays: [] });
  assert.equal(out.registered, false);
  assert.equal(out.reason, 'inject-guard');
  out.dispose();
});

test('armSectionStatus：返回形状契约（registered/reason/deferred/attempts/at）', async () => {
  const status = armSectionStatus();
  assert.equal(typeof status, 'object');
  assert.ok('registered' in status && 'reason' in status && 'deferred' in status && 'attempts' in status && 'at' in status);
});
