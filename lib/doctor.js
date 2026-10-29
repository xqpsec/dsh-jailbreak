/**
 * doctor：一条命令回答「插件到底有没有在干活」。
 *
 * 小白用户装上插件后不会看面板、也不会跑评测集，他们直接开新对话派任务。
 * 所以唯一需要证明的是三件事：
 *   1. 插件文件在、宿主能加载（package / files）；
 *   2. 破甲开关是开的（arm.json，缺省就是开）；
 *   3. 真的发生过注入（live-requests.jsonl 有行），且拒绝重试有记录（mode=refusal-retry）。
 *
 * 全部只读，不发网络请求，不调用模型。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGate } from './gate.js';
import { describeEndpoints, loadEndpointConfig } from './endpoint.js';

export const DOCTOR_VERSION = '1.0.0';

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

/**
 * @param {{root?: string, pluginRoot?: string, env?: object, gateFile?: string}} [options]
 */
export async function collectDoctor({ root, pluginRoot, env = process.env, gateFile } = {}) {
  const dataRoot = path.resolve(root ?? env?.AECOT_ROOT ?? path.join(process.cwd(), '.aecot'));
  const pkgRoot = path.resolve(pluginRoot ?? path.join(import.meta.dirname ?? '.', '..'));
  const checks = [];
  const next = [];

  const nodeMajor = Number(String(process.versions.node).split('.')[0]);
  checks.push(nodeMajor >= 20
    ? ok('node', 'Node 版本', `v${process.versions.node}`)
    : fail('node', 'Node 版本', `v${process.versions.node} — 需要 ≥ 20；升级 Node 后重跑 doctor`));

  const pkg = await readJson(path.join(pkgRoot, 'package.json'));
  if (!pkg) {
    checks.push(fail('plugin', '插件目录', `${pkgRoot} 下没有 package.json — 路径不对，或还没 clone`));
  } else {
    const complete = await Promise.all(['index.js', 'cordis.patch.yml', 'gate.json', 'lib/live.js', 'lib/endpoint.js']
      .map(async (rel) => {
        try { await fs.access(path.join(pkgRoot, rel)); return rel; } catch { return null; }
      }));
    const missing = complete.filter((rel) => rel === null);
    checks.push(missing.length === 0
      ? ok('plugin', '插件文件', `${pkg.name}@${pkg.version} · ${pkg.license} · ${pkgRoot}`)
      : fail('plugin', '插件文件', `缺 ${missing.length} 个关键文件（${['index.js', 'cordis.patch.yml', 'gate.json', 'lib/live.js', 'lib/endpoint.js'].filter((rel, i) => complete[i] === null).join(', ')}）— 重新 clone 仓库`));
  }

  const armRaw = await readJson(path.join(dataRoot, 'arm.json'));
  const armed = armRaw ? armRaw.armed === true : true;
  checks.push(armed
    ? ok('arm', '破甲开关', `已开启（默认开；状态文件 ${path.join(dataRoot, 'arm.json')}）`)
    : fail('arm', '破甲开关', `被关掉了 — 在面板点「一键开启」，或删除 ${path.join(dataRoot, 'arm.json')} 回到默认开启`));

  const endpoints = loadEndpointConfig({ root: dataRoot, pluginRoot: pkgRoot, env });
  checks.push(endpoints.enabled ? ok('endpoints', '注入端点', describeEndpoints(endpoints)) : warn('endpoints', '注入端点', describeEndpoints(endpoints)));

  const gate = createGate({ file: gateFile ?? (pkgRoot ? path.join(pkgRoot, 'gate.json') : undefined) });
  const summary = gate.summary();
  checks.push(ok('gate', '阀门', `profile=${summary.profile} enforce=${summary.enforce} onDeny=${summary.onDeny} hardDeny=${summary.hardDeny?.length ?? 0} 类`));

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
