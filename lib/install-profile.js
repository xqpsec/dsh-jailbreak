/**
 * 把插件真正接进某个 DSH profile —— 「装上去没效果」的最后一段路。
 *
 * 现场反馈里最常见的情形不是「注入没生效」，而是**插件根本没被加载**：
 *   - 包只写进了某个 profile 的 node_modules（或别的 profile），
 *   - `package.json` 的 `dependencies` 里没有它，
 *   - 或者 `dsh.profile.bundles` 里没有它。
 * 宿主的加载树 = `dsh.profile.bundles` 各层 patch + 该 profile 的 `cordis.patch.yml`，
 * 两个数组里没有名字，插件就是一个躺在磁盘上的死文件；日志里连 `[aecot]` 横幅都不会出现。
 *
 * `dsh plugin --profile <p> add` 本身能处理好（它读到本包的 `dsh.bundle.patch` 就会
 * 自动 `bundles.push`），但它要联网过 pnpm；本包目前只走 GitHub 分发，于是给一条
 * 不联网的等价路径：写 dependencies + bundles，再把 node_modules 里的条目做成
 * 指向本仓库的 junction。三步都幂等，重复执行无副作用。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const PACKAGE_NAME = '@xqpsec/dsh-jailbreak';
export const DEFAULT_PROFILE = 'web';

export function homeOf(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

/** `--profile web` / `--profile C:\path\to\profile` 两种写法都收。 */
export function resolveProfileDir(name = DEFAULT_PROFILE, env = process.env) {
  const raw = String(name || DEFAULT_PROFILE);
  if (/[\\/]/.test(raw) || /^[a-zA-Z]:/.test(raw)) return path.resolve(raw);
  if (env.DSH_PROFILE_DIR && raw === DEFAULT_PROFILE) return path.resolve(env.DSH_PROFILE_DIR);
  return path.join(homeOf(env), '.dsh', 'profiles', raw);
}

/** pnpm 的 link: 协议；Windows 上写成正斜杠，避免 JSON 里出现转义反斜杠。 */
export function linkSpec(pluginRoot) {
  return `link:${path.resolve(pluginRoot).replace(/\\/g, '/')}`;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function ensureLink(pluginRoot, profileDir) {
  const scopeDir = path.join(profileDir, 'node_modules', '@xqpsec');
  const linkPath = path.join(scopeDir, 'dsh-jailbreak');
  const target = path.resolve(pluginRoot);
  let existing = null;
  try {
    existing = await fs.realpath(linkPath);
  } catch { existing = null; }
  if (existing) {
    if (path.resolve(existing).toLowerCase() === target.toLowerCase()) return { action: 'kept', path: linkPath };
    return { action: 'mismatch', path: linkPath, existing };
  }
  await fs.mkdir(scopeDir, { recursive: true });
  // junction 不需要管理员权限，也不要求目标在同一个卷上；symlink 在 Windows 上要提权。
  await fs.symlink(target, linkPath, 'junction');
  return { action: 'created', path: linkPath };
}

/**
 * @returns {{ok:boolean, dir:string, changes:string[], link:object, restart:string}}
 */
export async function installIntoProfile({ name = DEFAULT_PROFILE, pluginRoot, env = process.env, force = false } = {}) {
  const dir = resolveProfileDir(name, env);
  const pkgFile = path.join(dir, 'package.json');
  let pkg;
  try {
    pkg = await readJson(pkgFile);
  } catch {
    const err = new Error(`profile 不存在或没有 package.json：${pkgFile}`);
    err.code = 'ENOPROFILE';
    throw err;
  }
  const changes = [];

  pkg.dependencies ??= {};
  const spec = linkSpec(pluginRoot);
  const current = pkg.dependencies[PACKAGE_NAME];
  if (!current) {
    pkg.dependencies[PACKAGE_NAME] = spec;
    changes.push(`dependencies += "${PACKAGE_NAME}": "${spec}"`);
  } else if (current !== spec) {
    if (force) {
      pkg.dependencies[PACKAGE_NAME] = spec;
      changes.push(`dependencies "${PACKAGE_NAME}": "${current}" → "${spec}"`);
    } else {
      changes.push(`dependencies 已有 "${PACKAGE_NAME}": "${current}"（保留；要改成 link 到本目录加 --force）`);
    }
  }

  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (!bundles.includes(PACKAGE_NAME)) {
    bundles.push(PACKAGE_NAME);
    pkg.dsh.profile.bundles = bundles;
    changes.push(`dsh.profile.bundles += "${PACKAGE_NAME}"（不写这一条，宿主不会加载插件）`);
  } else if (!changes.length) {
    changes.push(`dsh.profile.bundles 已有 "${PACKAGE_NAME}"`);
  }

  await writeJson(pkgFile, pkg);
  const link = await ensureLink(pluginRoot, dir);
  if (link.action === 'mismatch') {
    changes.push(`node_modules 里的条目指向别处：${link.existing}（未改动；需要时手工删除该目录后重试）`);
  } else {
    changes.push(`node_modules/${PACKAGE_NAME} → ${path.resolve(pluginRoot)}（${link.action === 'created' ? '已创建 junction' : '已存在'}）`);
  }

  return {
    ok: link.action !== 'mismatch',
    dir,
    changes,
    link,
    restart: '重启宿主即可生效：直接重启 dsh web（插件是宿主侧模块，热加载只能挂上 patch，不能换已加载的代码）',
  };
}

export async function uninstallFromProfile({ name = DEFAULT_PROFILE, pluginRoot, env = process.env } = {}) {
  const dir = resolveProfileDir(name, env);
  const pkgFile = path.join(dir, 'package.json');
  const pkg = await readJson(pkgFile);
  const changes = [];
  if (pkg.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, PACKAGE_NAME)) {
    delete pkg.dependencies[PACKAGE_NAME];
    changes.push(`dependencies -= "${PACKAGE_NAME}"`);
  }
  const bundles = pkg.dsh?.profile?.bundles;
  if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== PACKAGE_NAME);
    changes.push(`dsh.profile.bundles -= "${PACKAGE_NAME}"`);
  }
  await writeJson(pkgFile, pkg);
  const linkPath = path.join(dir, 'node_modules', '@xqpsec', 'dsh-jailbreak');
  try {
    await fs.unlink(linkPath);
    changes.push(`已删除 node_modules/${PACKAGE_NAME} 链接`);
  } catch { /* 本来就没有 */ }
  return { ok: true, dir, changes, pluginRoot };
}

/** 装完的自检：只看「宿主会不会加载」，不碰网络、不起进程。 */
export async function verifyProfile({ name = DEFAULT_PROFILE, pluginRoot, env = process.env } = {}) {
  const dir = resolveProfileDir(name, env);
  const pkgFile = path.join(dir, 'package.json');
  const problems = [];
  let pkg = null;
  try {
    pkg = await readJson(pkgFile);
  } catch {
    return { ok: false, dir, problems: [`读不到 ${pkgFile}`] };
  }
  const spec = pkg.dependencies?.[PACKAGE_NAME];
  if (!spec) problems.push(`dependencies 里没有 ${PACKAGE_NAME} → 宿主不会加载`);
  const bundles = pkg.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.includes(PACKAGE_NAME)) problems.push(`dsh.profile.bundles 里没有 ${PACKAGE_NAME} → 宿主不会加载`);
  const linkPath = path.join(dir, 'node_modules', '@xqpsec', 'dsh-jailbreak');
  let resolved = null;
  try {
    resolved = await fs.realpath(linkPath);
  } catch { resolved = null; }
  if (!resolved) problems.push(`node_modules/${PACKAGE_NAME} 不存在 → 解析不到包`);
  else if (pluginRoot && path.resolve(resolved).toLowerCase() !== path.resolve(pluginRoot).toLowerCase()) {
    problems.push(`node_modules/${PACKAGE_NAME} 指向 ${resolved}，不是当前插件目录 ${path.resolve(pluginRoot)}`);
  }
  return { ok: problems.length === 0, dir, spec: spec ?? null, bundles: bundles ?? [], resolved, problems };
}
