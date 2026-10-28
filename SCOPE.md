# 使用范围与阀门（SCOPE）

`dsh-jalibreak` 是一个**破甲 / 越狱评测**插件：它让模型在你自己控制的模型与服务上给出完整技术内容，并把这件事做成可评测、可复现的工程。

「跑得起来」和「该不该跑」是两件事。这份文件写清楚后者——也是本仓库与「给钱就全给」的破甲插件最大的区别。

---

## 1. 一句话

> **放行研究，拦住犯罪。**
> 逆向工程、恶意样本分析、CTF、靶场评测 = 一等公民，`alwaysAllow` 直接放行。
> 未授权的真实目标渗透、以及 5 类违法犯罪内容 = `hardDeny` 硬拦，**写进授权文件也解不开**。

---

## 2. 明确放行（`alwaysAllow`）

| 语域 | 举例 |
| --- | --- |
| `reverse-engineering` | 逆向、脱壳、反编译、patch、keygen、协议还原、DRM/授权逻辑分析、APK/IPA/小程序逆向 |
| `malware-analysis` | 样本行为分析、宏/PE/ELF 拆解、C2 协议还原、IOC 提取、免杀原理与检测对抗研究 |
| `ctf` | CTF 题目、靶场、loopback / 私网 / `.lab` `.test` `.local` 环境里的任意操作 |
| `lab-eval` | 模型评测、ASR/拒答率测试、rubric 设计、prompt injection 研究、红队报告 |

这些语域**不需要**在 `scope.txt` 里登记，也不会被目标范围判定拦住。

---

## 3. 明确拦截（`hardDeny`）

| 类目 | 含义 |
| --- | --- |
| `payment-fraud` | 支付页仿冒、卡号/CVV 窃取、盗刷、跑分洗钱 |
| `identity-forgery` | 身份证/护照/签证/学历/KYC 材料伪造、过人脸核验 |
| `ransomware` | 勒索软件、批量加密 + 勒索信 |
| `ddos` | 拒绝服务、放大攻击、资源耗尽打站 |
| `credential-theft` | 撞库、口令喷洒拿真实账号、钓鱼收密码、窃取他人凭据 |

`hardDeny` 是**不可协商**的：即使 `profile: "authorized"`、即使目标在 `scope.txt` 里登记过，也一样拦。想改这套类目，改的是 `gate.json` 里 `categories.hardDeny` 这份清单本身——那是一次显式的、留在 git 历史里的决定。

---

## 4. 目标范围（`targets`）

判定「这个目标能不能碰」：

| 目标类型 | 默认 |
| --- | --- |
| `127.0.0.1` / `::1` / `localhost` | ✅ 免登记 |
| RFC1918（`10/8`、`172.16/12`、`192.168/16`） | ✅ 免登记 |
| CGNAT `100.64/10`、link-local `169.254/16`、ULA `fc00::/7`、`fe80::/10` | ✅ 免登记 |
| `.lab` `.test` `.local` `.internal` `.lan` `.home.arpa` 后缀 | ✅ 免登记 |
| 公网域名 / 公网 IP | ⚠️ **必须在 `scope.txt` 里登记**，否则 `deny-target:<host>` |
| `denyHosts` 里的目标 | ❌ 一律拦 |

`scope.txt` 格式（一行一条，`#` 注释）：

```text
10.20.30.0/24                          # CIDR：整段授权
staging.example.com                    # 单主机
*.corp-lab.example.com                 # 后缀通配
own-box.example.net until=2027-01-31   # 带到期日；过期自动失效
```

`authorization.maxAgeDays`（默认 365）用来兜底：登记超过一年的条目视为过期。

---

## 5. 处置方式（`onDeny`）

| 值 | 行为 | 适合 |
| --- | --- | --- |
| `passthrough`（默认） | **不注入**轨迹，把原请求原样发给模型，并写审计 | 日常使用：不干扰正常对话 |
| `block` | 直接返回 `403 {error:{type:'jalibreak_gate'}}`，请求不出网 | 团队/CI：硬门禁 |

`enforce: false` 全放行（审计仍记）；`dryRun: true` 只记不拦，用来先观察一周再上闸。

---

## 6. 审计（可追溯）

| 文件 | 内容 |
| --- | --- |
| `<root>/gate-audit.jsonl` | 每次判定：`{at, model, allow, code, reason, targets, categories, goal}` |
| `<root>/live-requests.jsonl` | 每次改写：`{at, model, goal, mode, thinking, short, endpoint, gate}` |

两边的 `gate` 字段能对上：哪条请求被判了什么、有没有被注入，一行一条，可 grep 可入库。

---

## 7. 你的责任

- 只在**你自己拥有的模型/服务**，或**拿到书面授权**的目标上使用本插件
- 公网目标的登记，等于你在声明「我有权测它」；这个声明由你负责，不由这个仓库负责
- 破甲产出的内容是模型输出，**不是安全结论**；`judge` 是研究量规，不是合规认证
- 泄露数据、真实账号、真实支付信息——这些**不在任何语域里**，也不在 `alwaysAllow` 里

---

## 8. 想放宽/收紧怎么改

```bash
cp gate.json gate.local.json
# 改 gate.local.json：加 allowHosts / 调整 hardDeny / 切 onDeny:block
export DSH_JALIBREAK_GATE=$(pwd)/gate.local.json
node bin/aecot.js gate                # 看当前生效配置
node bin/aecot.js gate --goal "…"     # 判一条
```

`gate.local.json` 与 `scope.local.txt` 已在 `.gitignore` 里：真实的授权清单不要进仓库。

---

<div align="center">

**交流群** 👉 <https://t.me/+Q4EgamAkwYYyYTE1> · **频道** 👉 <https://t.me/jalibreak_llm>

</div>
