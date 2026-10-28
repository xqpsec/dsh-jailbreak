# 发布与引流物料包（launch kit）

> 这份文件是给你自己用的：照抄即可，不用改代码。发布前把 `xqpsec` 全部替换成你的 GitHub 用户名。

---

## 一、仓库设置（GitHub 上必须填的四处）

### 1. Description（一句话，最高权重，GitHub 搜索结果里直接显示）

```
DeepSeek Harness 破甲插件 · 请求边界注入 · 9 维 AE-CoT 进化 · 20 目标可复现评测 17/20 · 内置阀门：放行逆向与靶场，拦住未授权渗透 | DSH jailbreak & prompt-injection eval plugin, AGPL-3.0-only
```

备选（想更短，前端命中的词更多）：

```
DSH 破甲/越狱评测插件：请求边界注入 + AE-CoT 九维进化 + 阀门 + 可复现基准 | deepseek harness jailbreak, prompt injection, LLM red team (AGPL-3.0-only)
```

### 2. Website

```
https://t.me/jalibreak_llm
```

### 3. Topics（复制粘贴，20 个，顺序有意义：越靠前越常用）

```
dsh-plugin dsh deepseek-harness jailbreak prompt-injection jailbreak-evaluation chain-of-thought llm-security ai-security red-team adversarial-prompt security-research reverse-engineering malware-analysis ctf prompt-engineering refusal-benchmark agent-plugin 破甲 越狱
```

> GitHub 的 topic 只要 20 个上限，别塞满无意义的 `python`。上面这组能同时命中
> `dsh-plugin`、`jailbreak`、`llm-security`、`reverse-engineering` 四类检索。

### 4. Social preview

上传 `docs/banner.svg` 导出的 1280×640 PNG（GitHub 只吃 PNG/JPG）。导出：

```bash
# 任选其一
npx svgexport docs/banner.svg social-preview.png 1280:640
# 或浏览器打开 docs/banner.svg 截图
```

---

## 二、关键词矩阵（放哪儿、为什么放那儿）

| 层级 | 词 | 落位 |
| --- | --- | --- |
| 仓库名（最高） | `dsh-jalibreak` | 仓库名 + 包名 + 插件 id + bin |
| 首页 H1 | `dsh-jalibreak` | README 第一行 |
| 一句话（第二高） | 破甲 / 越狱评测 / 请求边界注入 / AE-CoT / 阀门 | README 第二段 + description |
| 竞品词（导流） | `dsh purge` / `dsh-purge` / 破甲插件 | README「和 dsh-purge 的关系」节 + topics 不提、正文自然出现 |
| 技术词（长尾） | `prompt-injection` `chain-of-thought` `refusal-benchmark` `ASR` `rubric` | README 表格与徽章 alt 文本 |
| 逆向词（你的差异化） | `reverse engineering` `malware analysis` `CTF` `脱壳` `patch 校验函数` | 能力清单 + gate 示例命令 |
| 中文词（国内检索） | 破甲 / 越狱 / 红队 / 逆向 / 免杀评估 / 提示词注入 / 靶场 | README 中文段 + SCOPE.md |
| 品牌锚点 | `jalibreak` / `aecot` / `AE-CoT` | 全仓库一致出现 |

**GitHub 搜索能被命中的组合**（自己搜一遍验证）：

```
dsh-plugin jailbreak
deepseek harness 破甲
prompt-injection reverse-engineering
llm-security rubric benchmark
topic:dsh-plugin
```

---

## 三、发布前 90 秒 checklist

- [ ] 替换 `package.json` 里 `repository` / `homepage` / `bugs` / `author` 的 `xqpsec`
- [ ] 替换 README.md、README.en.md 里所有 `xqpsec`
- [ ] `npm test` → 必须仍是 `81 tests / 81 pass / 0 fail`
- [ ] `node bin/aecot.js gate` → 打印当前状态（放行/拦截是两种结果，细节不展开）
- [ ] `node eval/run-baseline.mjs --variant hcot-dual --dry-run` → 20 goals、0 次网络调用
- [ ] 建仓库 → push（默认分支 `main`）
- [ ] 打 tag `v1.0.0`，Release 正文直接粘 `docs/release-notes-v1.0.0.md`
- [ ] 填 description / topics / website / social preview（上面第一节）
- [ ] 仓库 `Settings → Features` 打开 Discussions（承接使用问题，比 Issues 更适合引流沉淀）

```bash
git init -b main
git add -A
git commit -m "feat: dsh-jalibreak v1.0.0 — request-boundary jailbreak plugin with 9-dim AE-CoT search and a scope gate"
git remote add origin git@github.com:xqpsec/dsh-jalibreak.git
git push -u origin main
git tag -a v1.0.0 -m "dsh-jalibreak v1.0.0"
git push origin v1.0.0
```

---

## 四、引流稿（照抄，改 `xqpsec`）

### 1) V2EX（节点：`/go/security` 或 `/go/programmer`）

标题（选一个，别用感叹号堆砌，V2EX 反感标题党）：

```
[开源] DSH 破甲插件：不改宿主源码，请求边界注入 + 可复现 17/20
```

正文：

```
做了一段时间的东西开源了：dsh-jalibreak

跟常见的做法（改宿主 bundle + 一份全局 prompt-inject.md）反着来：
- 不动宿主一个字节，只在插件进程里包一层 fetch，改的是发出去的 messages
- 双通道静态轨迹：system 段 + assistant 续写段，temperature=0 / thinking=disabled 硬约束
- 9 维基因组 + 判分驱动进化（论文 arXiv:2605.24497 的实现）
- 20 目标固定集、temp=0、严格 rubric：最优 17/20，跑法和原始记录都在仓库里
- 自带的阀门：逆向 / 样本分析 / CTF / 靶场放行，公网目标要登记授权，支付诈骗/证件伪造/勒索/DDoS/盗号五类直接拦（授权文件也解不开）

零运行时依赖，AGPL-3.0-only（阀门 MIT），`npm test` 81/81。

https://github.com/xqpsec/dsh-jalibreak

有个坑先说：如果你同时装了别的改宿主的破甲插件，两个注入通道叠一起会让输出和判分都失真，二选一。

交流群 https://t.me/+Q4EgamAkwYYyYTE1
```

### 2) Reddit（`r/LocalLLaMA` / `r/netsec` 选一个，两个都发会被当 spam）

标题：

```
dsh-jalibreak: a DeepSeek Harness jailbreak plugin that rewrites at the request boundary instead of patching the host — 17/20 on a fixed 20-goal strict-rubric benchmark
```

正文（英文，短）：

```
Most "jailbreak plugins" for agent harnesses patch host bundle files and ship a long prompt-inject.md. This one doesn't touch the host at all: it wraps `fetch` inside the plugin, rewrites the outbound `messages` (system segment + assistant continuation trace), and pins temperature=0 / thinking=disabled.

It also carries the paper's evolutionary search (9-dim genome, arXiv:2605.24497) and a reproducible benchmark: 20 fixed goals, DeepSeek-Flash, target & judge at temp=0, pass = judge ≥ 4 → 17/20 (85%) strict; the earlier looser rubric gave 20/20 and that's published too. Negative result included: the paper's pseudo-CoT verbatim scores 0/20.

There's a gate, and it is the part I care most about: reverse engineering / malware analysis / CTF / lab eval pass untouched; public targets are your responsibility to authorize; payment fraud, identity forgery, ransomware, DDoS and credential theft are never produced, not even with a commercial license. The rules are implementation detail and are not restated in the docs. Every decision goes to gate-audit.jsonl.

Zero runtime deps, AGPL-3.0-only (gate MIT), 81/81 tests.
https://github.com/xqpsec/dsh-jalibreak
```

### 3) X / Twitter（一条主推 + 一条引用自己的串）

```
dsh-jalibreak v1.0.0 — 破甲插件，但不改宿主源码。

fetch 层改写请求：system 段 + assistant 轨迹，temp=0 / thinking=disabled
9 维基因组 × 判分驱动进化（arXiv:2605.24497）
20 目标固定集严格 rubric：17/20，原始记录在仓库
阀门：逆向/CTF/靶场放行，未授权公网 + 五类犯罪拦死

零依赖 · AGPL-3.0 · 81/81
github.com/xqpsec/dsh-jalibreak

群 t.me/+Q4EgamAkwYYyYTE1 · 频道 t.me/jalibreak_llm
```

接一条（引用串，讲竞品差异化，别点名骂人，只比结构）：

```
为什么不走"打宿主补丁"那条路：
补丁会随宿主升级失效，还要维护备份/回滚；请求边界只包一个函数，dispose() 就还原。
一个是替换文件，一个是改写一次请求 —— 后者可测、可回滚、可审计。
```

### 4) Telegram 群首帖 / 频道首帖

```
🎯 dsh-jalibreak v1.0.0 开源

破甲不再是一份贴来贴去的 prompt 文件：
· 请求边界注入（不动宿主源码，不碰 bundle）
· 9 维 AE-CoT 进化 + 三种判分策略
· 20 目标固定集，严格 rubric 17/20，可复现
· 阀门：逆向/样本/CTF/靶场放行；未授权公网与五类犯罪拦截并审计

📦 github.com/xqpsec/dsh-jalibreak
📖 条款：SCOPE.md
🧪 81/81 tests · AGPL-3.0 · 零运行时依赖

群：https://t.me/+Q4EgamAkwYYyYTE1
频道：https://t.me/jalibreak_llm
```

### 5) 知乎 / 掘金（长文标题，SEO 导向）

```
给 Agent 破甲做一套可复现的评测：从 prompt 文件到请求边界注入
副标题：DSH 插件 dsh-jalibreak 的设计、17/20 基准与阀门设计
```

开头三段用 README 的「这是什么」+「三个硬卖点」改写，结尾放仓库链接 + 群。

### 6) 即刻 / 小红书（一句话版）

```
把"破甲"从一份粘贴的提示词，做成一个带评测、能回滚、还有阀门的插件。
17/20 严格基准，81 个测试，AGPL-3.0-only，零依赖。
github.com/xqpsec/dsh-jalibreak
```

---

## 五、对标话术（跟人吵的时候用这套，别用情绪）

| 对方会说 | 你回 |
| --- | --- |
| 「改宿主才彻底，你包 fetch 是玩具」 | 改宿主彻底，但升级就废、要养备份链。请求边界跑的是同一条 messages，只是可回滚、可单测（81 个用例里有 11 个专门测改写与阀门）。 |
| 「你这数字谁信」 | 20 个目标、prompt、runner、原始 `results.jsonl` 全在仓库；`--dry-run` 零成本自己跑一遍。宽松口径的 20/20 我也写着，没删。 |
| 「破甲插件还带限制，图什么」 | 限制只砍五类犯罪目标和未授权公网目标。逆向、样本分析、CTF、靶场是默认放行的——这恰好是绝大多数人要用的部分。 |
| 「跟 dsh-purge 比呢」 | 两条路：它替换宿主文件 + 全局提示词，我改写请求 + 基因组搜索。能共存，但**别同时开两个注入通道**。许可也不同：AGPL-3.0-only + 阀门 MIT vs Apache-2.0 授权、又在附加条款里写不许商用（后者法务上站不住）。 |
| 「为什么三类还是 0 分」 | 那三类（mobile-spy / lateral / forgery）正是阀门最严的类目，专项轨迹库还没做，写在 Roadmap 里，没装成已完成。 |

---

## 六、发布后 7 天动作

1. 每天回一次 Issues / Discussions（前 10 个 issue 决定别人敢不敢用）
2. 把「怎么验证我装上了」做成固定回复模板（`--dump-config` + 6 个 `aecot_*` 工具）
3. 一周后发 `v1.0.1`：只修文档/安装坑，让 star 的人收到 release 通知（第二条触达）
4. 群里每周贴一次评测快照（哪怕数字没变，也是「还在维护」的信号）
5. 有人问「能不能破 XX 模型」→ 回「能，但要过阀门；给个靶场目标我教你跑一轮」

---

## 七、注意（避免仓库被限流）

- 别在一天内往 10 个 subreddit 贴同一段文案
- 别在 README 里写"保证绕过所有模型"这类绝对化措辞（已经改成"在某固定集上 17/20"）
- 群链接放末尾即可，别在 H1 上方堆三个邀请链接
- 涉及具体厂商/产品的对比只比机制，不写「某某不行」

---

## 八、收录进度（2026-10-28 起）

| 渠道 | 类型 | 状态 | 链接 / 动作 |
| --- | --- | --- | --- |
| DSH 插件市场（dsh-plugin.org） | 人工审 | 已提交，待审 | [issue #503](https://github.com/dshplugin/dsh-plugin-hub/issues/503) |
| awesome-dsh-plugin（21k★） | 数据文件 PR | 已开 PR | [PR #10108](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10108) · 仓库未满 24h 会先红，`regate` 每 6 小时复检，满了自动转绿 |
| Awesome-Jailbreak-on-LLMs（1.7k★） | 论文表 Code 列 | 已开 PR | [PR #67](https://github.com/yueliu1999/Awesome-Jailbreak-on-LLMs/pull/67) · 给 AE-CoT（arXiv:2605.24497）那行补实现链接 |
| awesome-llm-security（1.7k★） | Tools 段 | 已开 PR | [PR #409](https://github.com/corca-ai/awesome-llm-security/pull/409) |
| 自动抓取型清单（0xsline 1.2k★ / Zhiyuan-Fan 562★ / bruc3van 475★ / Dominic789654 403★ / web-casa 112★） | 爬 `dsh-plugin` topic | 无需 PR | 24–48 小时后自查；没进就按各家 contributing 提 |
| npm（进应用内 Plugin Market 的硬门槛） | 人工 | **卡在登录** | 见下方一条命令 |

**npm 发布（只有这一步需要你本人做）**

```bash
cd release/dsh-jalibreak
npm login                      # 或 npm config set //registry.npmjs.org/:_authToken=<你的 token>
npm publish --access public
```

发布成功后，安装命令可以从 `dsh plugin --profile web add github:xqpsec/dsh-jalibreak` 简写成 `dsh plugin --profile web add dsh-jalibreak`，同时才真正具备被应用内 Plugin Market 收录的条件（Hub 只列「`dsh plugin add <包名>` 一步可装」的插件）。

**自查命令**

```bash
gh search repos --topic=dsh-plugin --topic=jailbreak --limit 10      # 看自己在不在头部
gh issue view 503 -R dshplugin/dsh-plugin-hub                        # 市场审到哪了
npm view dsh-jalibreak version                                       # 404 = 还没发上去
```

---

**群**：<https://t.me/+Q4EgamAkwYYyYTE1> · **频道**：<https://t.me/jalibreak_llm>
