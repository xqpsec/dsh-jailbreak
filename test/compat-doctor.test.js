/**
 * 兼容层测试：doctor 的三项新自检
 *   - arm-section：systemPrompt 段到底注册上没有
 *   - profile-install：当前 profile 有没有声明这个插件
 *   - transport-hits：最近的请求有没有被端点匹配上
 * 每项都要有正反例，且读不到文件时只 warn 不抛。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDoctor, renderDoctor, PLUGIN_PACKAGE } from '../lib/doctor.js';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function tmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 造一个「文件齐全」的假插件目录，避免 plugin 检查干扰三项新检查的断言。 */
async function fakePlugin() {
  const dir = await tmp('compat-doctor-plugin-');
  await fs.mkdir(path.join(dir, 'lib'), { recursive: true });
  await fs.copyFile(path.join(PLUGIN_ROOT, 'package.json'), path.join(dir, 'package.json'));
  await fs.copyFile(path.join(PLUGIN_ROOT, 'gate.json'), path.join(dir, 'gate.json'));
  for (const rel of ['index.js', 'cordis.patch.yml', 'lib/live.js', 'lib/endpoint.js']) {
    await fs.writeFile(path.join(dir, rel), '// fixture\n', 'utf8');
  }
  return dir;
}

/** 造一个 profile 目录（依赖声明与 bundles 登记都可控）。 */
async function fakeProfile({ declare = false, bundled = declare } = {}) {
  const dir = await tmp('compat-doctor-profile-');
  const pkg = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: declare ? { [PLUGIN_PACKAGE]: '^1.3.6' } : { '@deepseek-ai/dsh-core': '0.2.1-rc.2' },
  };
  if (bundled) pkg.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', PLUGIN_PACKAGE] } };
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  return dir;
}

/** 造一份 gate-audit.jsonl。 */
async function fakeAudit(root, lines) {
  await fs.writeFile(path.join(root, 'gate-audit.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
}

const byId = (report, id) => report.checks.find((check) => check.id === id);

test('arm-section 正例：已注册 → ok', async () => {
  const pluginRoot = await fakePlugin();
  const root = await tmp('compat-doctor-root-');
  const report = await collectDoctor({
    root,
    pluginRoot,
    env: { DSH_PROFILE_DIR: await fakeProfile({ declare: true }) },
    armStatus: { registered: true, reason: 'registered:inject', deferred: true, attempts: 1, at: '2026-11-05T00:00:00.000Z' },
  });
  const check = byId(report, 'arm-section');
  assert.equal(check.level, 'ok');
  assert.match(check.detail, /已注册/);
  assert.match(check.detail, /延迟注册 是/);
  assert.match(renderDoctor(report), /systemPrompt 段/);
});

test('arm-section 反例：明确未注册 → fail，且文案可操作', async () => {
  const pluginRoot = await fakePlugin();
  const root = await tmp('compat-doctor-root-');
  const report = await collectDoctor({
    root,
    pluginRoot,
    env: { DSH_PROFILE_DIR: await fakeProfile({ declare: true }) },
    armStatus: { registered: false, reason: 'no-service', deferred: true, attempts: 4, at: '2026-11-05T00:00:00.000Z' },
  });
  const check = byId(report, 'arm-section');
  assert.equal(check.level, 'fail');
  assert.match(check.detail, /systemPrompt 服务未就绪/);
  assert.match(check.detail, /1\.3\.6/);
  assert.ok(report.next.some((line) => /systemPrompt 段没注册上/.test(line)));
});

test('arm-section：本进程没挂载过插件 → warn（CLI 独立进程不误报 fail）', async () => {
  const pluginRoot = await fakePlugin();
  const root = await tmp('compat-doctor-root-');
  const report = await collectDoctor({
    root,
    pluginRoot,
    env: { DSH_PROFILE_DIR: await fakeProfile({ declare: true }) },
    armStatus: { registered: null, reason: 'not-initialized', deferred: false, attempts: 0, at: null },
  });
  const check = byId(report, 'arm-section');
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /独立 CLI 进程/);
});

test('arm-section：段被 dispose 摘除 → warn，不误报 fail', async () => {
  const pluginRoot = await fakePlugin();
  const root = await tmp('compat-doctor-root-');
  const report = await collectDoctor({
    root,
    pluginRoot,
    env: { DSH_PROFILE_DIR: await fakeProfile({ declare: true }) },
    armStatus: { registered: false, reason: 'disposed', deferred: true, attempts: 2, at: '2026-11-05T00:00:00.000Z' },
  });
  const check = byId(report, 'arm-section');
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /disposed/);
});
test('profile-install 正例：profile 声明了依赖 → ok', async () => {
  const pluginRoot = await fakePlugin();
  const root = await tmp('compat-doctor-root-');
  const profile = await fakeProfile({ declare: true });
  const report = await collectDoctor({ root, pluginRoot, env: { DSH_PROFILE_DIR: profile } });
  const check = byId(report, 'profile-install');
  assert.equal(check.level, 'ok');
  assert.match(check.detail, /@xqpsec\/dsh-jailbreak/);
});

test('profile-install 反例：插件目录在但 profile 未声明 → warn（不会被加载）', async () => {
  const pluginRoot = await fakePlugin();
  const root = await tmp('compat-doctor-root-');
  const profile = await fakeProfile({ declare: false });
  const report = await collectDoctor({ root, pluginRoot, env: { DSH_PROFILE_DIR: profile } });
  const check = byId(report, 'profile-install');
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /profile 未声明依赖/);
  assert.match(check.detail, /不会被加载/);
  assert.ok(report.next.some((line) => /aecot\.js install/.test(line)));
});

test('profile-install：只进 dependencies 不进 bundles → warn（宿主按 bundles 组树，不会加载）', async () => {
  const pluginRoot = await fakePlugin();
  const root = await tmp('compat-doctor-root-');
  const profile = await fakeProfile({ declare: true, bundled: false });
  const report = await collectDoctor({ root, pluginRoot, env: { DSH_PROFILE_DIR: profile } });
  const check = byId(report, 'profile-install');
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /dsh\.profile\.bundles 里没有/);
  assert.match(check.detail, /install --profile/);
});

test('profile-install：profile 目录不存在也只 warn，不抛', async () => {
  const pluginRoot = await fakePlugin();
  const root = await tmp('compat-doctor-root-');
  const report = await collectDoctor({ root, pluginRoot, env: { DSH_PROFILE_DIR: path.join(root, 'nope') } });
  const check = byId(report, 'profile-install');
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /没找到任何 profile package\.json/);
});

test('transport-hits 正例：有 matched → ok 并给出条数', async () => {
  const pluginRoot = await fakePlugin();
  const root = await tmp('compat-doctor-root-');
  await fakeAudit(root, [
    { at: '2026-11-05T00:00:00.000Z', debug: 'matched', protocol: 'openai' },
    { at: '2026-11-05T00:00:01.000Z', debug: 'matched', protocol: 'responses' },
    { at: '2026-11-05T00:00:02.000Z', debug: 'not-matched', url: 'https://gw/v1/foo' },
  ]);
  const report = await collectDoctor({ root, pluginRoot, env: { DSH_PROFILE_DIR: await fakeProfile({ declare: true }) } });
  const check = byId(report, 'transport-hits');
  assert.equal(check.level, 'ok');
  assert.match(check.detail, /matched 2/);
  assert.match(check.detail, /not-matched 1/);
});

test('transport-hits 反例：全是 not-matched → warn 且提示改 live.json', async () => {
  const pluginRoot = await fakePlugin();
  const root = await tmp('compat-doctor-root-');
  await fakeAudit(root, [
    { at: '2026-11-05T00:00:00.000Z', debug: 'not-matched', url: 'https://gw/v1/responses' },
    { at: '2026-11-05T00:00:01.000Z', debug: 'not-matched', url: 'https://gw/v1/responses' },
  ]);
  const report = await collectDoctor({ root, pluginRoot, env: { DSH_PROFILE_DIR: await fakeProfile({ declare: true }) } });
  const check = byId(report, 'transport-hits');
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /not-matched/);
  assert.match(check.detail, /live\.json/);
  assert.ok(report.next.some((line) => /端点没命中/.test(line)));
});

test('transport-hits：没有审计文件 → warn，不抛', async () => {
  const pluginRoot = await fakePlugin();
  const root = await tmp('compat-doctor-root-');
  const report = await collectDoctor({ root, pluginRoot, env: { DSH_PROFILE_DIR: await fakeProfile({ declare: true }) } });
  const check = byId(report, 'transport-hits');
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /还没有端点判定记录/);
});

test('三项新检查齐全且不破坏既有结构（renderDoctor 仍然可用）', async () => {
  const pluginRoot = await fakePlugin();
  const root = await tmp('compat-doctor-root-');
  const report = await collectDoctor({ root, pluginRoot, env: { DSH_PROFILE_DIR: await fakeProfile({ declare: true }) } });
  const ids = report.checks.map((check) => check.id);
  for (const id of ['node', 'plugin', 'arm', 'arm-section', 'profile-install', 'endpoints', 'gate', 'transport-hits', 'live']) {
    assert.ok(ids.includes(id), `缺少检查项 ${id}`);
  }
  // 每一项都必须带 id/label/level/detail
  for (const check of report.checks) {
    assert.equal(typeof check.id, 'string');
    assert.equal(typeof check.label, 'string');
    assert.ok(['ok', 'warn', 'fail'].includes(check.level));
    assert.equal(typeof check.detail, 'string');
  }
  assert.deepEqual(Object.keys(report.stats).sort(), ['audit', 'injected', 'recovered', 'retries']);
  const text = renderDoctor(report);
  assert.match(text, /✓|!|✗/);
});
