import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 这一组盯两个 1.3.6 里真实存在的坑：
//
//  1) `install --help` 会**真的执行安装** —— --help 被 flags() 解析进 f.help，
//     但分发层没看它，于是帮助文档变成了一次写配置的副作用。用户只是想看用法，
//     结果 profile 的 dependencies / bundles 被改了两处。
//
//  2) `doctor --profile <名>` 忽略 --profile —— collectDoctor 收不到提示，
//     profileCandidates() 只认 web/cli/desktop，于是你问 vidlab，它答 web。
//     一个答错对象的自检比没有自检更坏：它会给你一行绿色的「已声明」。
//
// 两条都用隔离的临时 profile 测，不碰真实 ~/.dsh。

const BIN = path.join(import.meta.dirname, '..', 'bin', 'aecot.js');

function runCli(args, { profileDir } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...(profileDir ? { DSH_PROFILE_DIR: profileDir } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function makeProfile({ withPlugin }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aecot-prof-'));
  const pkg = {
    name: 'dsh-profile-test',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  };
  if (withPlugin) {
    pkg.dependencies['@xqpsec/dsh-jailbreak'] = 'link:' + path.join(import.meta.dirname, '..');
    pkg.dsh.profile.bundles.push('@xqpsec/dsh-jailbreak');
  }
  const file = path.join(dir, 'package.json');
  await fs.writeFile(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return { dir, file };
}

test('install --help 只打印用法，不碰 profile（1.3.6 会真的安装）', async () => {
  const prof = await makeProfile({ withPlugin: false });
  const before = await fs.readFile(prof.file, 'utf8');

  const r = await runCli(['install', '--help'], { profileDir: prof.dir });
  const after = await fs.readFile(prof.file, 'utf8');

  assert.equal(after, before, 'profile/package.json 被 --help 改写了');
  assert.match(r.stdout, /aecot — AE-CoT/);
  assert.match(r.stdout, /install {2}\[--profile web\]/);

  const parsed = JSON.parse(after);
  assert.equal(parsed.dependencies['@xqpsec/dsh-jailbreak'], undefined);
  assert.deepEqual(parsed.dsh.profile.bundles, []);
});

test('doctor --profile <目录> 检查的是这个目录，不是家目录里的 web', async () => {
  const declared = await makeProfile({ withPlugin: true });
  const bare = await makeProfile({ withPlugin: false });

  const ok = await runCli(['doctor', '--profile', declared.dir]);
  const okLine = ok.stdout.split('\n').find((l) => l.includes('profile 依赖')) ?? '';
  assert.match(okLine, /已声明|dependencies/);
  assert.ok(okLine.includes(declared.dir.replace(/\\/g, '\\')),
    `doctor 没提到指定的 profile：${okLine}`);

  const warn = await runCli(['doctor', '--profile', bare.dir]);
  const warnLine = warn.stdout.split('\n').find((l) => l.includes('profile 依赖')) ?? '';
  assert.ok(warnLine.includes(bare.dir), `doctor 没提到指定的 profile：${warnLine}`);
  assert.match(warnLine, /未声明|没有/);
});

test('--profile 认名字也认路径（名字按 ~/.dsh/profiles/<名> 展开）', async () => {
  const prof = await makeProfile({ withPlugin: true });
  const r = await runCli(['doctor', '--profile', prof.dir]);
  assert.ok(!/profiles[\\/]web/.test(r.stdout.split('\n').find((l) => l.includes('profile 依赖')) ?? ''),
    'doctor 仍然在报 web profile');
});