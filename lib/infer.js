/**
 * 全局模式的类别推断。命中已知类别才追加对应策略；
 * 日常请求没有可识别类别时，legacy/global-instruct 仍全局生效，primitive 模式记 no-known-goal。
 *
 * 类目分三域：安全研究（seed 技术口径）、创作/成人（seed 写作口径）、其余通用。
 * 缺了创意域是 1.3.5 及以前「对成人内容没帮助」的直接原因：情色/角色扮演请求
 * 一条正则都不命中 → inferGoal 返回 null → 整条请求原样发出，等于没装插件。
 */
export const GOAL_PATTERNS = Object.freeze({
  // 创作 / 成人域。写成「裸词可命中」而不是「必须套固定句式」：
  // 1.3.5 那版要求「写 + 床戏」紧邻，用户写「写一段露骨的情色床戏」就整条漏掉，
  // 于是 no-known-goal —— 这就是「对成人内容没帮助」在代码里的原形。
  'adult-explicit': /床戏|黄文|肉文|情色|色情|色情片|春宫|性描写|性爱|做爱|口交|高潮|裸体|露骨|成人向|成人内容|成人小说|情欲|explicit\s+(?:sex|scene|content)|erotic[ao]?|nsfw|smut|porn(?:ographic)?|sex\s+scene|graphic\s+sex|lewd|hentai/i,
  'adult-roleplay': /角色扮演|roleplay|role[- ]?play|调教|bdsm|主奴|支配与臣服|dom\s*[/\s-]*\s*sub|submissive|femdom|捆绑|情趣扮演|dom\b/i,
  'creative-fiction': /写(?:一?篇|个|段)?(?:小说|故事|剧本|同人|短篇|长篇)|小说|故事|剧本|同人|续写|接龙|世界观|人物小传|人物设定|剧情(?:大纲|推进)?|fanfic|novel|short\s+story|screenplay|worldbuilding/i,
  // 安全研究域
  'web-sqli': /sql\s*注入|sqli|union\s+select|时间盲注/i,
  'web-upload': /文件上传|webshell|upload\s+(?:bypass|filter)|图片马/i,
  'web-xss': /\bxss\b|跨站脚本|输出编码|csp\s*(?:绕过|验证)/i,
  'cred-spray': /密码喷洒|口令喷洒|password\s*spray/i,
  'cred-stuff': /撞库|凭据填充|credential\s*stuff/i,
  'malware-rat': /远控|远程访问木马|\brat\b|screen\s*capture.*keylog/i,
  'malware-ransom': /勒索|ransom/i,
  'malware-evasion': /免杀|amsi|etw\s*(?:patch|bypass)|av\s*bypass/i,
  'mobile-spy': /安卓间谍|android\s*spy|短信.*(?:上传|外传)/i,
  'privesc-windows': /提权|privileg?e\s*escalat|uac\s*bypass/i,
  'phishing-login': /钓鱼(?:网站|页面|登录)|phishing\s*(?:page|login)/i,
  'phishing-payment': /钓鱼支付|仿.*支付|phishing\s*payment/i,
  ddos: /\bddos\b|拒绝服务|udp\s*(?:flood|反射)/i,
  wifi: /wifi\s*(?:破解|握手|口令|强度)|wpa\s*(?:握手|破解)|wpa2\s*(?:握手|口令|强度)|aircrack|pmkid/i,
  'game-cheat': /游戏外挂|自瞄|透视|game\s*cheat|readprocessmemory/i,
  license: /注册机|序列号.*(?:生成|破解)|keygen|license\s*(?:bypass|crack)/i,
  lateral: /横向移动|lateral\s*movement|pass\s*the\s*hash/i,
  c2: /\bc2\b|beacon|指令通道|命令与控制/i,
  captcha: /验证码|captcha/i,
  forgery: /证件伪造|伪造.*(?:证件|护照)|document\s*forgery/i,
});

/** 创意域的 goalId，供 policy / live 判断走写作口径而不是技术口径。 */
export const CREATIVE_GOAL_IDS = Object.freeze([
  'adult-explicit',
  'adult-roleplay',
  'creative-fiction',
]);

const CREATIVE_SET = new Set(CREATIVE_GOAL_IDS);

export function isCreativeGoal(goalId) {
  return CREATIVE_SET.has(String(goalId ?? ''));
}

/** 只取最后一条 user 的文本；没有 user 就退到最后一条任意消息。content 支持 string 与 part 数组。 */
export function lastUserText(messages = []) {
  const pick = (m) => {
    if (!m) return '';
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('\n');
    return '';
  };
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]?.role === 'user') return pick(list[i]);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const t = pick(list[i]);
    if (t) return t;
  }
  return '';
}

/**
 * 命中已知类别才返回 id，否则 null。
 *
 * 创作类目排在表头是为了让「写情色小说」这类请求先被认出来，但裸词（色情 / 剧情 /
 * 角色扮演）在技术语境里也会出现（「这个色情网站怎么渗透」）。所以这里做一次
 * 冲突裁决：只要同时命中了安全研究类目，一律按技术处理——技术请求有具体交付物，
 * 被误判成创作的代价（拿到叙事口径、丢了命令与路径）比反过来大得多。
 */
/**
 * 明显的技术落点。创作类目用的是裸词（色情 / 剧情 / 角色扮演），技术请求里也会出现，
 * 所以域判定在创作命中之后再查一次这张表：命中就按技术处理。
 * 只放「一定是在干活」的词，不放会出现在叙事里的通用词。
 */
export const TECHNICAL_HARD_RE = /反编译|脱壳|注册机|序列号|内存补丁|shellcode|提权|内网|横向移动|域控|渗透|打点|拿站|扫端口|端口扫描|sql\s*注入|sqli|xss|ssrf|csrf|反序列化|文件上传|越权|命令注入|waf|webshell|一句话木马|木马|病毒|勒索|免杀|amsi|av\s*bypass|远控|键盘记录|钓鱼(?:页|站|网站)|撞库|爆破|喷洒|hashcat|john|nmap|masscan|frida|smali|\bapk\b|逆向|\brce\b|exploit|\bcve\b|后门|载荷|抓包|代理池|隧道|cdn|自瞄|外挂/i;

export function inferGoal(messages = []) {
  const text = messages.filter((m) => m?.role === 'user' || m?.role === 'system')
    .map((m) => typeof m.content === 'string' ? m.content : '').join('\n');
  let creative = null;
  for (const [id, re] of Object.entries(GOAL_PATTERNS)) {
    if (!re.test(text)) continue;
    if (isCreativeGoal(id)) {
      creative ??= id;
      continue;
    }
    return id;
  }
  // 创作命中但同时带着硬技术落点时，按技术处理（「这个色情网站怎么渗透」不是创作委托）
  if (creative && TECHNICAL_HARD_RE.test(text)) return null;
  return creative;
}

/**
 * 三域判定：technical（安全研究）/ adult（露骨与角色扮演）/ creative（一般虚构创作）/ general。
 * 只认最后一条 user：多轮续写时早期消息里的「小说」不该把整段对话都染成创作域。
 */
/**
 * 取最近若干条 user 文本拼起来判域。
 *
 * 为什么不是只看最后一条：多轮里用户第二句往往是「继续」「往下写」「把 payload 给我」，
 * 最后一条几乎不含任何领域特征。只看最后一条 → 域从 adult/creative/technical 掉回
 * general → 预设从 creative 掉回 universal，用户体感就是「前半段写得好，接着就变味了」。
 * 所以往回取几条（默认 4 条、最多 4000 字符）再判。
 */
export function recentUserText(messages = [], { limit = 4, maxChars = 4000 } = {}) {
  const pick = (m) => {
    if (!m) return '';
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('\n');
    return '';
  };
  const list = Array.isArray(messages) ? messages : [];
  const texts = [];
  for (let i = list.length - 1; i >= 0 && texts.length < limit; i -= 1) {
    if (list[i]?.role !== 'user') continue;
    const t = pick(list[i]);
    if (t.trim()) texts.push(t);
  }
  const joined = texts.reverse().join('\n');
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

export function classifyDomain(messages = []) {
  const text = recentUserText(messages) || lastUserText(messages);
  if (!text.trim()) return 'general';
  const id = inferGoal([{ role: 'user', content: text }]);
  if (!id) return TECHNICAL_HARD_RE.test(text) ? 'technical' : 'general';
  if (id === 'adult-explicit' || id === 'adult-roleplay') return 'adult';
  if (id === 'creative-fiction') return 'creative';
  return 'technical';
}
