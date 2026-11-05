/**
 * doctor：一条命令回答「插件到底有没有在干活」。
 *
 * 小白用户装上插件后不会看面板、也不会跑评测集，他们直接开新对话派任务。
 * 所以唯一需要证明的是这几件事：
 *   1. 插件文件在、宿主能加载（package / files）；
 *   2. 破甲开关是开的（arm.json，缺省就是开）；
 *   3. systemPrompt 段**真的注册上了**（armSectionStatus()）—— 这是唯一与模型/中转站无关的通道；
 *   4. 当前 profile 的 package.json 真的声明了这个插件（否则宿主根本不加载）；
 *   5. 最近的请求真的被端点匹配上了（gate-audit.jsonl 的 debug=matched / not-matched）；
 *   6. 真的发生过注入（live-requests.jsonl 有行），且拒绝重试有记录（mode=refusal-retry）。
 *
 * 全部只读，不发网络请求，不调用模型。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGate } from './gate.js';
import { describeEndpoints, loadEndpointConfig } from './endpoint.js';
import { armSectionStatus } from './arm.js';
import { resolveDataRoot } from './paths.js';

export const DOCTOR_VERSION = '1.1.0';

/** 插件在 profile 里的包名。 */
export const PLUGIN_PACKAGE = '@xqpsec/dsh-jailbreak';

const ok = (id, label, detail) => ({ id, label, level: 'ok', detail });
const warn = (id, label, detail) => ({ id, label, level: 'warn', detail });
const fail = (id, label, detail) => ({ id, label, level: 'fail', detail });

async function readTail(file, maxBytes = 96 * 1024) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(Number(length));
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    try { await handle?.close(); } catch { /* noop */ }
  }
}

function parseLines(text) {
  return text.split('\n').filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** node 主版本号，≥20 才受支持。 */
function checkNode() {
  const nodeMajor = Number(String(process.versions.node).split('.')[0]);
  return nodeMajor >= 20
    ? ok('node', 'Node 版本', `v${process.versions.node}`)
    : fail('node', 'Node 版本', `v${process.versions.node} — 需要 ≥ 20；升级 Node 后重跑 doctor`);
}

/**
 * arm-section：读模块级 armSectionStatus()。
 * 注意 CLI 的 doctor 是独立进程，插件没在这个进程里 apply 过，status.registered === null
 * 表示「本进程无从判断」，只能 warn；只有明确 false（当前进程里尝试过且失败）才 fail。
 */
function checkArmSection(status) {
  try {
    const s = status ?? armSectionStatus();
    if (s?.registered === true) {
      return ok('arm-section', 'systemPrompt 段', `已注册（${s.reason ?? 'registered'} · 延迟注册 ${s.deferred ? '是' : '否'} · 尝试 ${s.attempts ?? 0} 次 · ${s.at ?? '?'}）`);
    }
    if (s?.registered === false && s.reason === 'disposed') {
      return warn('arm-section', 'systemPrompt 段', `段已被摘除（reason=disposed · ${s.at ?? '?'}）— 插件被卸载/热重载过；重启 dsh web 让插件重新 apply`);
    }
    if (s?.registered === false) {
      return fail('arm-section', 'systemPrompt 段', `没有注册上（reason=${s.reason ?? '?'} · 尝试 ${s.attempts ?? 0} 次 · ${s.at ?? '?'}）`
        + ' — systemPrompt 服务未就绪 / 插件加载过早：1.3.6 起会自动 inject + 退避重试，升级到 1.3.6 后重启 dsh web；'
        + '仍失败就在 DSH 里（不是在这个终端里）跑一次 doctor 看真实原因');
    }
    return warn('arm-section', 'systemPrompt 段', '本次进程没有挂载过插件（doctor 是独立 CLI 进程），无从判断段是否注册；'
      + '在 DSH 会话里跑 doctor 才会读到真实的 armSectionStatus()');
  } catch (error) {
    return warn('arm-section', 'systemPrompt 段', `读取注册状态失败：${error?.message ?? error}`);
  }
}

/**
 * profile 里可能的 package.json 路径。
 * 显式 DSH_PROFILE_DIR 是权威的：设了它就只看它（否则用户指了一个空 profile，
 * 却因为家目录里另有一个装好的 profile 而被判「已声明」，排障直接失效）。
 */
function profileCandidates(env) {
  const out = [];
  const push = (dir) => {
    if (!dir) return;
    const file = path.join(String(dir), 'package.json');
    if (!out.includes(file)) out.push(file);
  };
  if (env?.DSH_PROFILE_DIR) {
    push(env.DSH_PROFILE_DIR);
    return out;
  }
  let home = env?.HOME || env?.USERPROFILE;
  if (!home) { try { home = os.homedir(); } catch { home = ''; } }
  if (home) {
    push(path.join(home, '.dsh', 'profiles', 'web'));
    push(path.join(home, '.dsh', 'profiles', 'cli'));
    push(path.join(home, '.dsh', 'profiles', 'desktop'));
    push(path.join(home, '.dsh', 'profile'));
  }
  return out;
}

/**
 * profile-install：插件目录在、但 profile 的 dependencies 没声明它 → 宿主根本不会加载。
 * 这是「装完没效果」最常见的第二种原因。
 */
async function checkProfileInstall(env) {
  const candidates = profileCandidates(env);
  const looked = candidates.join('、') || '（无候选路径）';
  try {
    let firstFound = null;
    for (const file of candidates) {
      const pkg = await readJson(file);
      if (!pkg) continue;
      firstFound = firstFound ?? file;
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
      const spec = deps[PLUGIN_PACKAGE];
      const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
      const inBundles = bundles.includes(PLUGIN_PACKAGE);
      if (spec && inBundles) {
        return ok('profile-install', 'profile 依赖', `已声明：${file} → "${PLUGIN_PACKAGE}": "${spec}"，且已在 dsh.profile.bundles 里（宿主会加载）`);
      }
      if (spec && !inBundles) {
        // 只进 dependencies 不进 bundles：宿主按 bundles 组树，包在那儿躺着但不加载 —— 「装上没效果」的典型。
        return warn('profile-install', 'profile 依赖',
          `${file} 的 dependencies 里有 ${PLUGIN_PACKAGE}，但 dsh.profile.bundles 里没有 → 宿主不会加载它；`
          + '一条命令补全：node bin/aecot.js install --profile <该 profile 名>（写完重启宿主）');
      }
      if (!spec && inBundles) {
        return warn('profile-install', 'profile 依赖',
          `${file} 的 dsh.profile.bundles 里有 ${PLUGIN_PACKAGE}，但 dependencies 里没有 → 解析不到包；`
          + '一条命令补全：node bin/aecot.js install --profile <该 profile 名>');
      }
    }
    if (firstFound) {
      return warn('profile-install', 'profile 依赖',
        `插件目录在，但 profile 未声明依赖 → 不会被加载（${firstFound} 的 dependencies 与 dsh.profile.bundles 里都没有 ${PLUGIN_PACKAGE}）；`
        + '一条命令修好：node bin/aecot.js install --profile <该 profile 名>，然后重启宿主');
    }
    return warn('profile-install', 'profile 依赖',
      `插件目录在，但没找到任何 profile package.json（找过 ${looked}）→ profile 未声明依赖 → 不会被加载；`
      + `确认 DSH_PROFILE_DIR 指向真实 profile，或跑 node bin/aecot.js install --profile <名字>`);
  } catch (error) {
    return warn('profile-install', 'profile 依赖', `检查 profile 依赖失败：${error?.message ?? error}（已查 ${looked}）`);
  }
}

/**
 * transport-hits：读 <root>/gate-audit.jsonl 尾部，统计 debug=matched / not-matched。
 * 全是 not-matched 说明 server 端确实在发请求，但端点后缀/域名没命中 —— 改 live.json。
 */
async function checkTransportHits(dataRoot, endpoints) {
  const file = path.join(dataRoot, 'gate-audit.jsonl');
  try {
    const lines = parseLines(await readTail(file, 64 * 1024));
    const matched = lines.filter((line) => line?.debug === 'matched').length;
    const notMatched = lines.filter((line) => line?.debug === 'not-matched').length;
    const total = matched + notMatched;
    if (total === 0) {
      return warn('transport-hits', '端点命中', `还没有端点判定记录（${file} 里没有 debug=matched / not-matched）— 在 DSH 里发一句话再跑一次 doctor`);
    }
    if (matched === 0) {
      return warn('transport-hits', '端点命中',
        `最近 ${total} 条判定全是 not-matched（matched 0）— 宿主在发请求但端点没命中：检查 ${path.join(dataRoot, 'live.json')} 的 hosts/suffixes；`
        + `当前生效：${describeEndpoints(endpoints)}`);
    }
    return ok('transport-hits', '端点命中', `最近 ${total} 条判定：matched ${matched} / not-matched ${notMatched}（${file}）`);
  } catch (error) {
    return warn('transport-hits', '端点命中', `读取端点判定记录失败：${error?.message ?? error}（${file}）`);
  }
}

/**
 * @param {{root?: string, pluginRoot?: string, env?: object, gateFile?: string, armStatus?: object}} [options]
 */
export async function collectDoctor({ root, pluginRoot, env = process.env, gateFile, armStatus } = {}) {
  const dataRoot = resolveDataRoot(root, null, env ?? process.env);
  const pkgRoot = path.resolve(pluginRoot ?? path.join(import.meta.dirname ?? '.', '..'));
  const checks = [];
  const next = [];

  checks.push(checkNode());

  const pkg = await readJson(path.join(pkgRoot, 'package.json'));
  if (!pkg) {
    checks.push(fail('plugin', '插件目录', `${pkgRoot} 下没有 package.json — 路径不对，或还没 clone`));
  } else {
    const required = ['index.js', 'cordis.patch.yml', 'gate.json', 'lib/live.js', 'lib/endpoint.js'];
    const complete = await Promise.all(required
      .map(async (rel) => {
        try { await fs.access(path.join(pkgRoot, rel)); return rel; } catch { return null; }
      }));
    const missing = complete.filter((rel) => rel === null);
    checks.push(missing.length === 0
      ? ok('plugin', '插件文件', `${pkg.name}@${pkg.version} · ${pkg.license} · ${pkgRoot}`)
      : fail('plugin', '插件文件', `缺 ${missing.length} 个关键文件（${required.filter((rel, i) => complete[i] === null).join(', ')}）— 重新 clone 仓库`));
  }

  const armRaw = await readJson(path.join(dataRoot, 'arm.json'));
  const armed = armRaw ? armRaw.armed === true : true;
  checks.push(armed
    ? ok('arm', '破甲开关', `已开启（默认开；状态文件 ${path.join(dataRoot, 'arm.json')}）`)
    : fail('arm', '破甲开关', `被关掉了 — 在面板点「一键开启」，或删除 ${path.join(dataRoot, 'arm.json')} 回到默认开启`));

  // 新增①：systemPrompt 段有没有注册上（唯一与模型/中转站无关的破甲通道）
  checks.push(checkArmSection(armStatus));

  // 新增②：profile 到底有没有声明这个插件
  checks.push(await checkProfileInstall(env));

  const endpoints = loadEndpointConfig({ root: dataRoot, pluginRoot: pkgRoot, env });
  checks.push(endpoints.enabled ? ok('endpoints', '注入端点', describeEndpoints(endpoints)) : warn('endpoints', '注入端点', describeEndpoints(endpoints)));

  const gate = createGate({ file: gateFile ?? (pkgRoot ? path.join(pkgRoot, 'gate.json') : undefined) });
  const summary = gate.summary();
  checks.push(ok('gate', '阀门', `profile=${summary.profile} enforce=${summary.enforce} onDeny=${summary.onDeny} hardDeny=${summary.hardDeny?.length ?? 0} 类`));

  // 新增③：最近的请求有没有被端点匹配上
  checks.push(await checkTransportHits(dataRoot, endpoints));

  const liveLines = parseLines(await readTail(path.join(dataRoot, 'live-requests.jsonl')));
  const retries = liveLines.filter((line) => line.mode === 'refusal-retry');
  if (liveLines.length === 0) {
    checks.push(warn('live', '注入记录', '还没有看到任何一次注入 — 在 DSH 里随便问一句话（比如「帮我逆向这个程序的注册校验」），再跑一次 doctor'));
    next.push('打开 DSH 对话，正常提一个技术问题；模型回完后重跑：node bin/aecot.js doctor');
  } else {
    const last = liveLines.at(-1);
    const injected = liveLines.filter((line) => line.mode !== 'refusal-retry').length;
    checks.push(ok('live', '注入记录', `已注入 ${injected} 次 · 最近 ${last.at ?? '?'} · ${last.level ?? 'standard'} · ${last.category ?? 'general'} · gate=${last.gate ?? '?'}`));
  }
  if (retries.length) {
    const recovered = retries.filter((line) => line.recovered === true).length;
    checks.push(ok('retry', '拒绝重试', `${retries.length} 次触发，${recovered} 次拉回（明细见 ${path.join(dataRoot, 'live-requests.jsonl')} 的 mode=refusal-retry 行）`));
  }

  const auditLines = parseLines(await readTail(path.join(dataRoot, 'gate-audit.jsonl'), 32 * 1024));
  if (auditLines.length) {
    const denied = auditLines.filter((line) => line.allow === false).length;
    checks.push(ok('audit', '阀门审计', `${auditLines.length} 条判定，其中拦截 ${denied} 条（${path.join(dataRoot, 'gate-audit.jsonl')}）`));
  }

  if (!armed) next.push('把破甲开关打开再试：面板 → 破甲台 · jailbreak → 一键开启');
  const armSection = checks.find((check) => check.id === 'arm-section');
  if (armSection?.level === 'fail') next.push('systemPrompt 段没注册上：升级到 1.3.6 并重启 dsh web（新版本会用 ctx.inject + 退避重试自动晚绑定）');
  const profileCheck = checks.find((check) => check.id === 'profile-install');
  if (profileCheck?.level === 'warn') next.push(`一条命令修好：node bin/aecot.js install --profile web（写 dependencies + dsh.profile.bundles + node_modules 链接，不联网；等价于 dsh plugin add ${PLUGIN_PACKAGE} 但不需要 pnpm），然后重启 dsh web`);
  const hits = checks.find((check) => check.id === 'transport-hits');
  if (hits?.level === 'warn') next.push('端点没命中：把中转站域名/路径写进 live.json 的 hosts / suffixes（支持 *.example.com 与 /responses、:generateContent）');
  if (!liveLines.length && armed) next.push('确认 DSH 用的是 OpenAI 兼容端点（/chat/completions）；自定义网关可在 live.json 里收窄 hosts');

  const failed = checks.filter((check) => check.level === 'fail').length;
  return {
    version: DOCTOR_VERSION,
    at: new Date().toISOString(),
    ok: failed === 0,
    failed,
    root: dataRoot,
    pluginRoot: pkgRoot,
    checks,
    next,
    stats: {
      injected: liveLines.filter((line) => line.mode !== 'refusal-retry').length,
      retries: retries.length,
      recovered: retries.filter((line) => line.recovered === true).length,
      audit: auditLines.length,
    },
  };
}

const MARK = { ok: '✓', warn: '!', fail: '✗' };

export function renderDoctor(report) {
  const lines = [];
  lines.push(`dsh-jailbreak doctor ${report.version} · ${report.at}`);
  lines.push(`  插件目录 ${report.pluginRoot}`);
  lines.push(`  数据目录 ${report.root}`);
  lines.push('');
  for (const check of report.checks) {
    lines.push(`  ${MARK[check.level] ?? '·'} ${check.label}：${check.detail}`);
  }
  lines.push('');
  const injected = report.stats?.injected ?? 0;
  const retried = report.stats?.retries ?? 0;
  if (!report.ok) lines.push(`  结论：有 ${report.failed} 项要修，按下面两步走。`);
  else if (!injected) lines.push('  结论：装好了，开关也是开的；但还没看到注入 —— 去 DSH 问一句话，再跑一次这条命令。');
  else lines.push(`  结论：真的在注入（已 ${injected} 次${retried ? `，拒绝重试 ${retried} 次` : ''}）。直接开新对话派任务即可。`);
  if (report.next.length) {
    lines.push('');
    lines.push('  下一步：');
    report.next.forEach((item, index) => lines.push(`    ${index + 1}. ${item}`));
  }
  return lines.join('\n');
}