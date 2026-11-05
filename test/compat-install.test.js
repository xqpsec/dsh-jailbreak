import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installIntoProfile, uninstallFromProfile, verifyProfile, linkSpec, PACKAGE_NAME } from '../lib/install-profile.js';

// 「装上去没效果」的头号原因是插件压根没进 profile 的加载树：
// dependencies 里没有它、dsh.profile.bundles 里也没有它，宿主连 [aecot] 横幅都不会打。
// 这组用例盯的就是那两条数组 + node_modules 里的可解析性。

async function fakeProfile({ withBundles = true } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aecot-home-'));
  const dir = path.join(home, '.dsh', 'profiles', 'web');
  await fs.mkdir(dir, { recursive: true });
  const pkg = {
    name: 'profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: withBundles ? ['@deepseek-ai/dsh-base'] : undefined } },
  };
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  const pluginRoot = path.join(home, 'plugin');
  await fs.mkdir(path.join(pluginRoot, 'lib'), { recursive: true });
  await fs.writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.0.0' }));
  return { home, dir, pluginRoot };
}

test('install 写 dependencies + bundles + 可解析链接，verify 通过', async () => {
  const { home, dir, pluginRoot } = await fakeProfile();
  const env = { HOME: home, USERPROFILE: home };
  const res = await installIntoProfile({ name: 'web', pluginRoot, env });
  assert.equal(res.ok, true);
  assert.equal(res.dir, dir);

  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies[PACKAGE_NAME], linkSpec(pluginRoot));
  assert.ok(pkg.dsh.profile.bundles.includes(PACKAGE_NAME), 'bundles 里必须出现包名');
  assert.ok(pkg.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'), '原有 bundle 不能被挤掉');

  const real = await fs.realpath(path.join(dir, 'node_modules', '@xqpsec', 'dsh-jailbreak'));
  assert.equal(path.resolve(real).toLowerCase(), path.resolve(pluginRoot).toLowerCase());

  const report = await verifyProfile({ name: 'web', pluginRoot, env });
  assert.equal(report.ok, true, report.problems.join('; '));
});

test('install 幂等：重复执行不重复 push', async () => {
  const { home, pluginRoot } = await fakeProfile();
  const env = { HOME: home, USERPROFILE: home };
  await installIntoProfile({ name: 'web', pluginRoot, env });
  const second = await installIntoProfile({ name: 'web', pluginRoot, env });
  const pkg = JSON.parse(await fs.readFile(path.join(second.dir, 'package.json'), 'utf8'));
  assert.equal(pkg.dsh.profile.bundles.filter((b) => b === PACKAGE_NAME).length, 1);
});

test('profile 没有 bundles 字段时也能建出数组', async () => {
  const { home, pluginRoot } = await fakeProfile({ withBundles: false });
  const env = { HOME: home, USERPROFILE: home };
  await installIntoProfile({ name: 'web', pluginRoot, env });
  const pkg = JSON.parse(await fs.readFile(path.join(home, '.dsh', 'profiles', 'web', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dsh.profile.bundles, [PACKAGE_NAME]);
});

test('verify 能指出「只进 dependencies 不进 bundles」这种半装状态', async () => {
  const { home, dir, pluginRoot } = await fakeProfile();
  const env = { HOME: home, USERPROFILE: home };
  await installIntoProfile({ name: 'web', pluginRoot, env });
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  pkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base'];
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  const report = await verifyProfile({ name: 'web', pluginRoot, env });
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((p) => p.includes('bundles')), report.problems.join('; '));
});

test('uninstall 把三处一起撤掉', async () => {
  const { home, dir, pluginRoot } = await fakeProfile();
  const env = { HOME: home, USERPROFILE: home };
  await installIntoProfile({ name: 'web', pluginRoot, env });
  await uninstallFromProfile({ name: 'web', pluginRoot, env });
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies[PACKAGE_NAME], undefined);
  assert.equal(pkg.dsh.profile.bundles.includes(PACKAGE_NAME), false);
  await assert.rejects(fs.realpath(path.join(dir, 'node_modules', '@xqpsec', 'dsh-jailbreak')));
});

test('profile 不存在时报 ENOPROFILE，不静默成功', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aecot-empty-'));
  const env = { HOME: home, USERPROFILE: home };
  await assert.rejects(
    installIntoProfile({ name: 'nope', pluginRoot: home, env }),
    (err) => err.code === 'ENOPROFILE',
  );
});

test('--profile 传绝对路径时直接当 profile 目录用', async () => {
  const { dir, pluginRoot } = await fakeProfile();
  const res = await installIntoProfile({ name: dir, pluginRoot, env: {} });
  assert.equal(path.resolve(res.dir), path.resolve(dir));
});
