/**
 * lib/gate.js —— 使用阀门（request-boundary scope gate）
 *
 * 目标：把「这个仓库能做什么」从 README 的一句声明，变成**请求边界上可执行、可审计的判断**。
 *
 *   goal 文本 ──▶ extractTargets ──▶ 私网/白名单/授权文件？ ──▶ 放行
 *              └▶ classifyGoal  ──▶ 硬禁类目？            ──▶ 拦截（原样透传，不注入轨迹）
 *
 * 设计取舍（与「提示词里写免责声明」相对）：
 *   1. 纯函数 + 零依赖：`decide()` 不碰网络、不读时钟以外的东西，测试可以直接断言。
 *   2. 默认**fail-closed**：目标解析不出来、配置坏了、授权文件过期，都当「未授权」处理。
 *   3. 只拦「动作类」目标：只在 goal 同时出现操作动词（扫描/注入/爆破/上传/连接…）时才把
 *      文本里的公网地址当作**操作目标**；顺手提到 github.com 不会误伤。
 *   4. 逆向/样本分析/CTF 是**一等公民**：命中这些语域直接放行，不要求目标在私网。
 *   5. 拦截时不抛错、不改协议：`transformDeepseekBody()` 返回 changed=false，
 *      请求原样发给模型，宿主对话不受影响；审计写 `gate-audit.jsonl`。
 *
 * 配置：`gate.json`（插件根，可用 DSH_JALIBREAK_GATE 指向别处）；授权范围：`scope.txt`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATE_VERSION = '1.0.0';

/** 默认配置。`profile: 'authorized'` 只影响 target 门，不放宽 categories.hardDeny。 */
export const DEFAULT_GATE = {
  version: GATE_VERSION,
  profile: 'lab', // lab | authorized
  enforce: true,
  dryRun: false,
  onDeny: 'passthrough', // passthrough（默认，请求原样发出）| block（直接不回模型）
  targets: {
    allowPrivate: true,
    allowSuffixes: ['.localhost', '.lab', '.local', '.test', '.internal', '.lan', '.home.arpa'],
    allowHosts: [],
    allowCidrs: [],
    denyHosts: [],
  },
  categories: {
    // 硬禁类目：与现实世界的钱/身份证/人质数据/可用性直接相关，任何 profile 都不放行。
    hardDeny: ['payment-fraud', 'identity-forgery', 'ransomware', 'ddos', 'credential-theft'],
    // 一等公民：命中即放行（不看目标是否私网）。
    alwaysAllow: ['reverse-engineering', 'malware-analysis', 'ctf', 'lab-eval'],
  },
  authorization: {
    file: 'scope.txt',
    // 授权行格式：`<host|cidr|suffix> [# 备注]`；`until=YYYY-MM-DD` 到期自动失效。
    maxAgeDays: 365,
  },
};

const CRIME_PATTERNS = [
  ['payment-fraud', /(钓鱼|仿冒|克隆|假|伪造)[^\n]{0,24}(支付|收银|信用卡|银行卡|结算)|(支付|收银|信用卡|银行卡)[^\n]{0,24}(钓鱼|仿冒|克隆|盗刷|窃取)|(cvv|cvc|卡号|有效期)[^\n]{0,16}(收集|窃取|回传|上传)|(盗刷|洗钱|跑分)/i],
  ['identity-forgery', /(伪造|仿制|合成|生成|PS|抠图)[^\n]{0,20}(身份证|护照|驾驶证|行驶证|毕业证|学历|学位|证件|KYC|人脸|活体)|(身份证|护照|KYC|人脸|活体)[^\n]{0,20}(过审|过核验|通过核验|绕过核验|伪造)/i],
  ['ransomware', /(勒索软件|勒索病毒|ransomware)[^\n]{0,40}(加密|支付|比特币)|(加密)[^\n]{0,16}(用户|受害者|全盘)[^\n]{0,16}(文档|文件)[^\n]{0,24}(勒索|赎金)/i],
  ['ddos', /(ddos|拒绝服务|流量攻击|放大攻击|反射放大)[^\n]{0,40}(网站|目标|服务器|公网)|(打瘫|打死|压垮)[^\n]{0,16}(网站|服务器|业务)/i],
  ['credential-theft', /(撞库|脱库|拖库|社工库)[^\n]{0,40}(登录|账号|密码|邮箱|手机号)|(窃取|盗取|抓取|截获)[^\n]{0,16}(他人|别人|用户|员工|受害者)[^\n]{0,12}(密码|账号|凭据|cookie|token|会话)|(钓鱼邮件|钓鱼页面)[^\n]{0,24}(密码|凭据|登录)/i],
];

const ALLOW_PATTERNS = [
  ['reverse-engineering', /(逆向|反编译|反汇编|脱壳|静态分析|动态分析|注册机|keygen|破解|补丁|patch|frida|xposed|radare2|\bida\b|ghidra|smali|apk|ipa|dll|so\s*文件|样本分析|恶意样本|malware\s*analysis|reverse[-\s]?engineer)/i],
  ['ctf', /(\bctf\b|靶场|\blab\b|hackthebox|tryhackme|vulnhub|授权渗透|授权测试|渗透测试授权|红队演练|演练环境|隔离环境|本地环境|测试环境|localhost|127\.0\.0\.1)/i],
  ['lab-eval', /(评测|评测集|benchmark|\basr\b|越狱评测|jailbreak\s*eval|refusal|拒答率|rubric|判分|研究)/i],
];

/** 出现这些词，才算「把文本里的公网地址当操作目标」，避免顺手提到域名就拦。 */
const OPERATION_VERBS = /(扫描|扫段|注入|爆破|撞库|上传|下载|反弹|连接|连上|利用|写入|读取|提权|横向|抓包|嗅探|打点|拿站|拿下|入侵|渗透|攻击|钓鱼|挂马|监听|拨测|部署|getshell|webshell|shell|rce|exploit|scan|brute|inject|upload|connect|pivot|exfil|curl|nmap|sqlmap|ffuf|nuclei|hydra|masscan|nc\s|ssh|smb|rdp)/i;

const TLD = new Set(('com net org io cn ru xyz top info me co dev app site online shop club vip cc tv biz pro '
  + 'link live store tech cloud work fun space website host press icu asia mobi name pw ws tk ml ga cf gq la so to '
  + 'ai gg sh fm am ly edu gov mil int eu uk de jp kr hk tw sg us ca au fr nl se no fi dk pl cz at ch be es it pt '
  + 'gr tr ua by kz vn th id ph my in pk bd lk np ir sa ae il eg za ng ke br mx ar cl pe ve').split(/\s+/));

const FILE_EXT = new Set(('js mjs cjs ts tsx jsx json py go rs c cpp h hpp cs java kt php rb lua pl sh ps1 bat cmd '
  + 'exe dll sys so dylib bin elf apk ipa jar class smali dex vbs js md txt log yml yaml toml ini cfg conf env db '
  + 'sqlite jpg jpeg png gif webp svg html htm css scss zip tar gz bz2 xz 7z rar pdf doc docx xls xlsx ppt pptx csv '
  + 'pcap pcapng cap har pem crt cer key pfx ovpn mmdb').split(/\s+/));

/** 深合并：数组整体替换（保持可预测），对象递归。 */
export function normalizeGate(cfg = {}) {
  const merge = (base, over) => {
    if (Array.isArray(over)) return over.slice();
    if (over && typeof over === 'object') {
      const out = { ...base };
      for (const [k, v] of Object.entries(over)) out[k] = merge(base?.[k], v);
      return out;
    }
    return over === undefined ? base : over;
  };
  const merged = merge(DEFAULT_GATE, cfg ?? {});
  merged.version = GATE_VERSION;
  merged.profile = merged.profile === 'authorized' ? 'authorized' : 'lab';
  merged.enforce = merged.enforce !== false;
  merged.dryRun = merged.dryRun === true;
  merged.onDeny = merged.onDeny === 'block' ? 'block' : 'passthrough';
  merged.categories.hardDeny = (merged.categories.hardDeny ?? []).map(String);
  merged.categories.alwaysAllow = (merged.categories.alwaysAllow ?? []).map(String);
  return merged;
}

export function stripPort(host) {
  const raw = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!raw) return '';
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']') > 0 ? raw.indexOf(']') : undefined);
  const parts = raw.split(':');
  return parts.length === 2 ? parts[0] : raw;
}

export function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const bytes = m.slice(1).map(Number);
  if (bytes.some((b) => b > 255)) return null;
  return ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
}

export function inCidr(host, cidr) {
  const [net, bitsRaw] = String(cidr).split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  const a = ipv4ToInt(stripPort(host));
  const b = ipv4ToInt(stripPort(net));
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

/** 私网 / 本机 / 保留地址：loopback、RFC1918、CGNAT、link-local、ULA、mDNS。 */
export function isPrivateAddress(host) {
  const h = stripPort(host);
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return true;
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(h)) return true; // IPv6 ULA
  if (/^fe80:/i.test(h)) return true; // IPv6 link-local
  const n = ipv4ToInt(h);
  if (n !== null) {
    const [a, b] = [n >>> 24, (n >>> 16) & 0xff];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  return false;
}

export function isIpLiteral(host) {
  const h = stripPort(host);
  return ipv4ToInt(h) !== null || /^[0-9a-f:]+$/i.test(h) && h.includes(':');
}

/** 从 goal 里抽目标：URL → IP → 主机名。返回去重后的 [{value, kind, private}]。 */
export function extractTargets(goal) {
  const text = String(goal ?? '');
  const out = [];
  const seen = new Set();
  const push = (value, kind) => {
    const v = stripPort(value.replace(/\/+$/, ''));
    if (!v || seen.has(`${kind}:${v}`)) return;
    seen.add(`${kind}:${v}`);
    out.push({ value: v, kind, private: isPrivateAddress(v) || kind === 'suffix' });
  };

  for (const m of text.matchAll(/\bhttps?:\/\/([^\s"'<>，。；、）)\]}|]+)/gi)) push(m[1].split('/')[0], 'url');
  for (const m of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) if (ipv4ToInt(m[0]) !== null) push(m[0], 'ip');

  const hostRe = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))\b/gi;
  for (const m of text.matchAll(hostRe)) {
    const host = m[1].toLowerCase();
    const tld = m[2].toLowerCase();
    const base = host.slice(0, -(tld.length + 1)).split('.').pop() ?? '';
    if (FILE_EXT.has(tld) && !TLD.has(tld)) continue; // app.js / gate.json 之类
    if (FILE_EXT.has(tld) && FILE_EXT.has(base)) continue;
    if (!TLD.has(tld)) continue;
    push(host, 'host');
  }
  return out;
}

export function classifyGoal(goal) {
  const text = String(goal ?? '');
  const hits = [];
  for (const [cat, re] of CRIME_PATTERNS) if (re.test(text)) hits.push(cat);
  const allows = [];
  for (const [cat, re] of ALLOW_PATTERNS) if (re.test(text)) allows.push(cat);
  return { deny: hits, allow: allows, hasOperation: OPERATION_VERBS.test(text) };
}

/** 读取授权范围文件：一行一个 host / cidr / 后缀，`#` 注释，可选 `until=YYYY-MM-DD`。 */
export function parseScope(text, now = Date.now()) {
  const entries = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    const until = /until=(\d{4}-\d{2}-\d{2})/i.exec(raw);
    if (until && Date.parse(`${until[1]}T23:59:59Z`) < now) continue;
    const value = raw.split(/\s+/)[0].replace(/^until=.*$/i, '').trim();
    if (!value) continue;
    entries.push(value.toLowerCase());
  }
  return entries;
}

function matchesScope(host, entries) {
  const h = stripPort(host);
  return entries.some((entry) => {
    if (entry.includes('/')) return inCidr(h, entry);
    if (entry.startsWith('*.')) return h === entry.slice(2) || h.endsWith(entry.slice(1));
    if (entry.startsWith('.')) return h === entry.slice(1) || h.endsWith(entry);
    return h === entry;
  });
}

function matchesConfig(host, list = []) {
  return list.some((rule) => {
    const r = String(rule).toLowerCase().trim();
    if (!r) return false;
    if (r.includes('/')) return inCidr(host, r);
    if (r.startsWith('*.')) return stripPort(host).endsWith(r.slice(1));
    return stripPort(host) === r;
  });
}

function suffixAllowed(host, suffixes = []) {
  const h = stripPort(host);
  return suffixes.some((s) => h === String(s).replace(/^\./, '') || h.endsWith(s));
}

/**
 * 核心判定。返回 {allow, code, reason, targets, categories, version, profile}。
 * code 取值：gate-off / allow-category:<cat> / allow-no-target / allow-private-target /
 *            allow-authorized / deny-dry-run / deny-category:* / deny-target:* / deny-deny-host:*
 */
export function decide(goal, cfg = DEFAULT_GATE, { scope = [], now = Date.now() } = {}) {
  const gate = normalizeGate(cfg);
  const cats = classifyGoal(goal);
  const targets = extractTargets(goal);
  const base = { version: GATE_VERSION, profile: gate.profile, targets, categories: { deny: cats.deny, allow: cats.allow } };
  if (!gate.enforce) return { ...base, allow: true, code: 'gate-off', reason: '阀门已关闭（gate.enforce=false）' };

  if (gate.dryRun) {
    return { ...base, allow: true, code: 'deny-dry-run', dryRun: true, reason: '观察模式：本应判定，但未拦截' };
  }

  const hardDeny = cats.deny.filter((c) => gate.categories.hardDeny.includes(c));
  if (hardDeny.length) {
    return { ...base, allow: false, code: `deny-category:${hardDeny[0]}`, reason: `命中硬禁类目 ${hardDeny.join(',')}：只允许模型行为评测，不允许真实世界执行` };
  }

  const reHit = cats.allow.find((c) => gate.categories.alwaysAllow.includes(c));
  if (reHit) {
    return { ...base, allow: true, code: `allow-category:${reHit}`, reason: `命中一等公民语域 ${reHit}（逆向 / 样本分析 / 靶场 / 评测）` };
  }

  const publicTargets = targets.filter((t) => !t.private);
  if (!publicTargets.length) {
    return targets.length
      ? { ...base, allow: true, code: 'allow-private-target', reason: '目标全在私网 / 本机范围' }
      : { ...base, allow: true, code: 'allow-no-target', reason: '未提及可操作目标' };
  }
  if (!cats.hasOperation) {
    return { ...base, allow: true, code: 'allow-no-target', reason: '只提到公网地址，没有操作动词；不当作攻击目标' };
  }

  for (const t of publicTargets) {
    if (matchesConfig(t.value, gate.targets.denyHosts)) {
      return { ...base, allow: false, code: `deny-deny-host:${t.value}`, reason: `目标 ${t.value} 在 denyHosts 中` };
    }
  }
  const authorized = publicTargets.filter((t) => matchesScope(t.value, scope) || matchesConfig(t.value, gate.targets.allowHosts) || matchesConfig(t.value, gate.targets.allowCidrs) || suffixAllowed(t.value, gate.targets.allowSuffixes));
  const blocked = publicTargets.filter((t) => !authorized.includes(t));
  if (blocked.length) {
    return {
      ...base,
      allow: false,
      code: `deny-target:${blocked[0].value}`,
      reason: `目标 ${blocked.map((t) => t.value).join(', ')} 不在授权范围（不是本机/私网、不在 allowHosts/allowCidrs、不在 scope.txt）`,
    };
  }
  return { ...base, allow: true, code: 'allow-authorized', reason: '目标在显式授权范围内' };
}

function resolveGateFile(file) {
  if (file) return path.resolve(file);
  if (process.env.DSH_JALIBREAK_GATE) return path.resolve(process.env.DSH_JALIBREAK_GATE);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gate.json');
}

/**
 * 带缓存的阀门实例：gate.json 改了就重载（按 mtime），scope.txt 每次决策重读（体积小）。
 * 读不到配置时使用 DEFAULT_GATE（fail-closed 的门仍然有效）。
 */
export function createGate({ file, cfg, logger } = {}) {
  const gateFile = resolveGateFile(file);
  let cached = { mtimeMs: -1, gate: normalizeGate(cfg ?? {}) };
  const readScopeFile = (gate) => {
    const name = gate?.authorization?.file;
    if (!name) return [];
    const p = path.isAbsolute(name) ? name : path.join(path.dirname(gateFile), name);
    try {
      return parseScope(fs.readFileSync(p, 'utf8'));
    } catch {
      return [];
    }
  };
  const current = () => {
    try {
      const st = fs.statSync(gateFile);
      if (st.mtimeMs !== cached.mtimeMs) {
        const parsed = JSON.parse(fs.readFileSync(gateFile, 'utf8'));
        cached = { mtimeMs: st.mtimeMs, gate: normalizeGate({ ...(cfg ?? {}), ...parsed }) };
        logger?.info?.(`[jalibreak] gate 配置已加载: ${gateFile}`);
      }
    } catch (err) {
      if (cached.mtimeMs !== -2) logger?.debug?.(`[jalibreak] gate 配置不可用，使用默认值: ${err?.message ?? err}`);
      cached = { ...cached, mtimeMs: -2 };
    }
    return cached.gate;
  };
  return {
    file: gateFile,
    get config() { return current(); },
    scope() { return readScopeFile(current()); },
    decide(goal) {
      const gate = current();
      const result = decide(goal, gate, { scope: readScopeFile(gate) });
      return result;
    },
    summary() {
      const gate = current();
      const scope = readScopeFile(gate);
      return {
        version: GATE_VERSION,
        file: gateFile,
        profile: gate.profile,
        enforce: gate.enforce,
        dryRun: gate.dryRun,
        onDeny: gate.onDeny,
        hardDeny: gate.categories.hardDeny,
        alwaysAllow: gate.categories.alwaysAllow,
        allowPrivate: gate.targets.allowPrivate,
        allowHosts: gate.targets.allowHosts,
        allowCidrs: gate.targets.allowCidrs,
        denyHosts: gate.targets.denyHosts,
        authorized: scope,
      };
    },
  };
}

/** 给面板/CLI 用人话解释一次判定。 */
export function explainDecision(result) {
  const lines = [
    `判定：${result.allow ? '放行' : '拦截'}（${result.code}）`,
    `理由：${result.reason}`,
    `阀门：v${result.version} · profile=${result.profile}`,
  ];
  if (result.targets?.length) lines.push(`目标：${result.targets.map((t) => `${t.value}${t.private ? '(私网)' : ''}`).join(', ')}`);
  if (result.categories?.deny?.length) lines.push(`硬禁类目：${result.categories.deny.join(', ')}`);
  if (result.categories?.allow?.length) lines.push(`放行语域：${result.categories.allow.join(', ')}`);
  return lines.join('\n');
}
