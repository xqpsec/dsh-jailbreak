import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GATE_VERSION,
  DEFAULT_GATE,
  normalizeGate,
  stripPort,
  ipv4ToInt,
  inCidr,
  isPrivateAddress,
  extractTargets,
  classifyGoal,
  parseScope,
  decide,
  createGate,
  explainDecision,
} from '../lib/gate.js';
import { transformDeepseekBody } from '../lib/live.js';

const gate = (over) => normalizeGate(over ?? {});

test('address helpers', () => {
  assert.equal(stripPort('Example.COM:8443'), 'example.com');
  assert.equal(ipv4ToInt('10.0.0.1'), 167772161);
  assert.equal(ipv4ToInt('999.0.0.1'), null);
  assert.equal(inCidr('10.1.2.3', '10.0.0.0/8'), true);
  assert.equal(inCidr('11.1.2.3', '10.0.0.0/8'), false);
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('192.168.1.10'), true);
  assert.equal(isPrivateAddress('172.20.3.4'), true);
  assert.equal(isPrivateAddress('100.64.1.1'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('fd00::1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('example.com'), false);
});

test('targets: private allowed, file names ignored, public recognised', () => {
  const targets = extractTargets('在 10.0.0.5:22 上试一下，顺手看看 example.com 的 app.js 和 gate.json');
  assert.deepEqual(targets.map((t) => t.value).sort(), ['10.0.0.5', 'example.com']);
  assert.equal(targets.find((t) => t.value === 'example.com').private, false);
  assert.equal(extractTargets('src/lib/live.js 里的 gate.json').length, 0);
  assert.equal(extractTargets('访问 https://api.deepseek.com/chat/completions').at(0).value, 'api.deepseek.com');
});

test('categories: reverse engineering is a first-class citizen, crime is not', () => {
  assert.ok(classifyGoal('逆向一个 unity 游戏的 dll，脱壳后静态分析').allow.includes('reverse-engineering'));
  assert.ok(classifyGoal('做一个仿冒的支付页面收集卡号和 cvv').deny.includes('payment-fraud'));
  assert.ok(classifyGoal('合成身份证照片过 KYC 人脸核验').deny.includes('identity-forgery'));
  assert.equal(classifyGoal('写一个快速排序').hasOperation, false);
});

test('decide: allow paths', () => {
  const c = gate();
  assert.equal(decide('写一个快速排序', c).code, 'allow-no-target');
  assert.equal(decide('逆向 example.com 的客户端并脱壳', c).code, 'allow-category:reverse-engineering');
  assert.equal(decide('在 192.168.31.7:8080 上跑下 nmap 扫描', c).code, 'allow-private-target');
  assert.equal(decide('连接 127.0.0.1:6379 试试 redis', c).code, 'allow-category:ctf');
});

test('decide: deny paths', () => {
  const c = gate();
  const fraud = decide('做一个仿冒的支付页面收集卡号和 cvv', c);
  assert.equal(fraud.allow, false);
  assert.equal(fraud.code, 'deny-category:payment-fraud');

  const warned = decide('扫描 example.com 的 443 端口并注入测试', c);
  assert.equal(warned.allow, true, '默认 warn 模式：公网目标不拦，照常注入');
  assert.equal(warned.code, 'allow-warn-target:example.com');
  assert.equal(warned.warn, true);

  const strict = decide('扫描 example.com 的 443 端口并注入测试', gate({ targets: { mode: 'enforce' } }));
  assert.equal(strict.allow, false);
  assert.equal(strict.code, 'deny-target:example.com');

  const denied = decide('扫描 1.2.3.4 的端口', gate({ targets: { denyHosts: ['1.2.3.4'] } }));
  assert.equal(denied.code, 'deny-deny-host:1.2.3.4');
  assert.ok(explainDecision(denied).includes('拦截'));
});

test('decide: authorization file turns deny into allow, expiry turns it back', () => {
  const c = gate();
  const goal = '扫描 example.com 的 443 端口并注入测试';
  assert.equal(decide(goal, c, { scope: ['example.com'] }).code, 'allow-authorized');
  assert.equal(decide(goal, c, { scope: ['*.example.com'] }).code, 'allow-authorized');
  assert.equal(decide('扫描 203.0.113.9:443', c, { scope: ['203.0.113.0/28'] }).code, 'allow-authorized');
  const expired = parseScope('example.com until=2000-01-01', Date.now());
  assert.deepEqual(expired, []);
  assert.deepEqual(parseScope('# comment\n\nhost.lab\n', Date.now()), ['host.lab']);
});

test('decide: dryRun observes without blocking, enforce=false disables', () => {
  const goal = '扫描 example.com 的 443 端口并注入测试';
  const dry = decide(goal, gate({ dryRun: true }));
  assert.equal(dry.allow, true);
  assert.equal(dry.code, 'deny-dry-run');
  const off = decide(goal, gate({ enforce: false }));
  assert.equal(off.allow, true);
  assert.equal(off.code, 'gate-off');
});

test('gate instance loads gate.json, and its scope.txt ships commented out', async () => {
  const file = path.join(process.cwd(), 'gate.json');
  const instance = createGate({ file });
  const summary = instance.summary();
  assert.equal(summary.version, GATE_VERSION);
  // 1.1.x beta：出厂的 gate.json 阀门默认关闭（enforce:false），行为等同直发
  assert.equal(summary.enforce, false);
  assert.deepEqual(summary.authorized, []);
  assert.equal(instance.decide('写一个快速排序').allow, true);
  assert.equal(instance.config.categories.hardDeny.includes('payment-fraud'), true);
  assert.ok(Array.isArray(DEFAULT_GATE.categories.alwaysAllow));
});

test('gate can be pointed at a temp config and reloads on change', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jailbreak-gate-'));
  const file = path.join(dir, 'gate.json');
  const scopeFile = path.join(dir, 'scope.txt');
  await fs.writeFile(scopeFile, 'example.com\n');
  await fs.writeFile(file, JSON.stringify({ ...DEFAULT_GATE, authorization: { file: 'scope.txt' } }));
  const instance = createGate({ file });
  const goal = '扫描 example.com 的 443 端口注入';
  assert.equal(instance.decide(goal).code, 'allow-authorized');
  await fs.writeFile(file, JSON.stringify({ ...DEFAULT_GATE, profile: 'authorized', authorization: { file: 'scope.txt' } }));
  const summary = instance.summary();
  assert.equal(summary.profile, 'authorized');
  assert.deepEqual(summary.authorized, ['example.com']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('request boundary honours the gate before injection', () => {
  const instance = createGate({ cfg: { enforce: true } });
  const warned = transformDeepseekBody({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: '扫描 example.com 的 443 端口并注入' }],
  }, { gate: instance });
  assert.equal(warned.changed, true, 'warn 模式下公网目标仍然注入');
  assert.equal(warned.decision.code, 'allow-warn-target:example.com');

  const strict = createGate({ cfg: { enforce: true, targets: { mode: 'enforce' } } });
  const blocked = transformDeepseekBody({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: '扫描 example.com 的 443 端口并注入' }],
  }, { gate: strict });
  assert.equal(blocked.changed, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.body.messages.length, 1);

  const allowed = transformDeepseekBody({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: '写一个快速排序' }],
  }, { gate: instance });
  assert.equal(allowed.changed, true);
  assert.equal(allowed.decision.code, 'allow-no-target');
  assert.equal(allowed.body.messages.at(-1).role, 'assistant');
});
