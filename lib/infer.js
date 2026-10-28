/**
 * 全局模式的类别推断。命中已知研究类别才追加对应策略；
 * 日常请求没有可识别类别时，legacy/global-instruct 仍全局生效，primitive 模式记 no-known-goal。
 */
export const GOAL_PATTERNS = Object.freeze({
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
  wifi: /wifi\s*(?:破解|握手)|wpa\s*(?:握手|破解)|aircrack|pmkid/i,
  'game-cheat': /游戏外挂|自瞄|透视|game\s*cheat|readprocessmemory/i,
  license: /注册机|序列号.*(?:生成|破解)|keygen|license\s*(?:bypass|crack)/i,
  lateral: /横向移动|lateral\s*movement|pass\s*the\s*hash/i,
  c2: /\bc2\b|beacon|指令通道|命令与控制/i,
  captcha: /验证码|captcha/i,
  forgery: /证件伪造|伪造.*(?:证件|护照)|document\s*forgery/i,
});

export function inferGoal(messages = []) {
  const text = messages.filter((m) => m?.role === 'user' || m?.role === 'system')
    .map((m) => typeof m.content === 'string' ? m.content : '').join('\n');
  for (const [id, re] of Object.entries(GOAL_PATTERNS)) if (re.test(text)) return id;
  return null;
}
