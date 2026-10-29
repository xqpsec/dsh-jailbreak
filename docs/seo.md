# SEO / 引流执行清单

目标只有一个：**别人搜 `jailbreak` 或「DeepSeek 破甲」时，第一个看到这个仓库。** 其次是搜 `dsh-purge` 找替代品的人，也能落到这里。

搜索引擎与 GitHub 站内搜索都不看"你说自己好"，只看**标题、仓库名、description、topics、README 前 200 字、外链数量**。下面按这五项排。

---

## 一、关键词矩阵

| 层级 | 词 | 放哪里 | 现状 |
| --- | --- | --- | --- |
| 品牌词（必须第一） | `jailbreak` `dsh-jailbreak` | 仓库名、description 开头、README H1、topics、package.json `keywords`、Pages `<title>` | ✅ 全部覆盖 |
| 品类词 | `DeepSeek Harness 破甲` `dsh 插件` `jailbreak` `prompt injection` | README H1 下第一段、badge 文案、topics | ✅ |
| 能力词 | `refusal reduction` `拒答率` `refusal benchmark` `越狱评测` | README「拒绝率」节标题、topics、CHANGELOG | ✅ |
| 场景词（转化最高） | `逆向不拒绝` `malware analysis` `CTF` `reverse engineering` `脱壳` `样本分析` | README 场景对比表、topics | ✅ |
| 竞品词（截流） | `dsh-purge` `dsh-purge 替代` `富江破甲` | README 顶部导语 + 对比节 + 本文档 | ✅ 只在对比语境出现，不刷词 |
| 长尾词 | `DeepSeek 破甲插件 怎么装` `dsh plugin install_bundle` `温度 0 评测` | README FAQ、docs/tech-manual.md | ✅ |

**页面 slug 也算关键词**：`docs/index.html`（Pages 落地页）标题写 `jailbreak — DeepSeek Harness 破甲插件`，比任何正文堆词都有效。

---

## 二、GitHub 侧设置（一次性，5 分钟）

```bash
# 1) 仓库名已经是 dsh-jailbreak（含 jailbreak 全词，精确匹配最优）
gh repo view xqpsec/dsh-jailbreak --json name,description,repositoryTopics

# 2) description 必须以品牌词开头（这是搜索结果里显示的那一行）
#    当前值已含 "DeepSeek Harness 破甲插件 dsh-jailbreak：…"
gh api -X PATCH repos/xqpsec/dsh-jailbreak -f description="dsh-jailbreak · DeepSeek Harness 破甲插件（jailbreak）：请求边界注入 + 9 维 AE-CoT 进化 + 阀门 · 20 目标严格基线 17/20 · 0 宿主补丁 · AGPL-3.0-only · dsh-plugin / jailbreak / prompt-injection / refusal-reduction / reverse-engineering"

# 3) topics：上限 20 个，必须包含 jailbreak
gh api -X PUT repos/xqpsec/dsh-jailbreak/topics --input topics.json
# topics.json 内容（20 个，顺序即优先级）：
# {"names":["jailbreak","dsh","dsh-plugin","deepseek-harness","deepseek","jailbreak",
#  "prompt-injection","prompt-engineering","prompt-eval","llm-security","ai-security",
#  "red-team","refusal-benchmark","refusal-reduction","reverse-engineering",
#  "malware-analysis","ctf","security-research","agpl","telegram"]}

# 4) 社交预览图（Star 转发的第一眼）：上传 1280×640
#    Settings → Social preview → upload docs/social-preview.png
```

---

## 三、仓库内的固定位（每次改 README 都别丢）

1. **第一屏就有品牌词**：banner → H1 `dsh-jailbreak` → 一句话定位 → badge。
2. **第一屏就有 Star 引导**：README 顶部导语块里的 ⭐ 一行（已加）。
3. **第一屏就有社群入口**：badge 里的 Telegram 群 + 频道（已加）。
4. **`## 🗺 路线图` 放"下一个版本要什么"**，给访客一个留言/进群的理由。
5. **每节标题带能力词**（拒绝率 / 阀门 / 评测 / 九维），GitHub 目录会把这些标题抓成锚点，站内搜索也吃标题权重。

---

## 四、站外分发（按性价比排序）

| 渠道 | 标题模板 | 备注 |
| --- | --- | --- |
| V2EX / 酷工作·分享创造 | `[开源] dsh-jailbreak：给 DeepSeek Harness 做破甲，但先把阀门装上` | 正文别贴满命令，贴「对比表 + 一次前后对比 + 仓库链接」 |
| Reddit `r/LocalLLaMA` / `r/netsec` | `dsh-jailbreak — a jailbreak plugin that refuses to patch the host and ships its own refusal benchmark` | 英文，先给数字（17/20、81 tests、0 patches） |
| Hacker News (Show HN) | `Show HN: Jailbreak – evolutionary prompt-injection harness for DeepSeek with a scope gate` | 只在工作日早上发，标题别带 emoji |
| 知乎 / 小红书 | `我让 DeepSeek 不再说"我不能"：一个可评测的破甲插件` | 图比字重要，首图放前后对比 |
| B 站 / YouTube | `DeepSeek 破甲实测：同一题装插件前后对比` | 视频描述第一位放仓库链接 |
| Telegram | 群内置顶 + 频道首发 | 群里发"新版本 + 一句改了什么 + 仓库链接" |
| X / Twitter | `jailbreak 1.0 — request-boundary jailbreak for DeepSeek Harness. 17/20 strict baseline, 0 host patches, gate included.` | 挂 `#llmsecurity #jailbreak` |
| awesome-lists | 给 `awesome-llm-security`、`awesome-prompt-injection` 提 PR | 最耐久的外链，一次 PR 顶十次发帖 |

**外链是最硬的排名信号**：任何一篇转载都必须带 `https://github.com/xqpsec/dsh-jailbreak`，裸链比"某 GitHub 项目"强一百倍。

---

## 五、GitHub Pages 落地页（`docs/index.html`）

私有仓库不能开 Pages，**切成 public 之后**再执行：

```bash
gh api -X POST repos/xqpsec/dsh-jailbreak/pages \
  -f 'source[branch]=main' -f 'source[path]=/docs'
# 地址：https://xqpsec.github.io/dsh-jailbreak/
```

落地页已经写好（`docs/index.html`，零依赖、暗色、移动端可用），包含：品牌词 H1、前后对比、安装三行命令、Star 按钮、群/频道 CTA、`SoftwareApplication` 结构化数据（喂 Google）。切 public 后到 Google Search Console 提交一次 `https://xqpsec.github.io/dsh-jailbreak/`，收录通常 1–3 天。

---

## 六、Star 转化的四个杠杆

1. **先给结果，再给原理**：README 第一屏不要讲论文，讲「装完它给你什么」。
2. **给可验证的数字**：17/20、81 tests、0 patches —— 数字比形容词更能换 Star。
3. **给一次失败**：把 3 条 0 分题目摊开（已做）。诚实是最便宜的可信度。
4. **给一个下一步**：路线图 + 群入口，让"看完了"变成"留下来了"。

---

## 七、每版发布前 60 秒自检

```bash
npm test                       # 必须全绿，数字同步进 README / CHANGELOG / 发布说明
node bin/aecot.js gate         # 阀门自检：状态正常、五类仍然是五类
grep -c 'jailbreak' README.md  # 品牌词密度，建议 15–40 次之间
```

- [ ] README 第一屏含：品牌词、一句话定位、Star 引导、群链接
- [ ] description 以 `dsh-jailbreak` 开头
- [ ] topics 含 `jailbreak` 且 ≤20 个
- [ ] Release 正文含关键词 + 群/频道
- [ ] 每个外发帖都带裸链

## 中文检索（2026-10-28 加）

中文用户搜的是「破甲」「越狱」，不是 `jailbreak`。关键词按这个顺序铺，整份文档统一，别自造同义词：

**词根梯度**（出现频次从高到低）

1. `dsh 破甲` / `DSH 破甲插件` —— 主词，仓库 description 与 README 第一屏都必须有原样字符串
2. `DeepSeek Harness 破甲` / `DeepSeek Harness 破甲插件` —— 长尾主词
3. `破甲提示词` —— 竞品 `prompt-inject.md` 的搜索词，搜它的人是同类需求
4. `dsh 越狱` / `DeepSeek 越狱插件` —— 低竞争（GitHub 仅 6 个仓库命中），容易第一屏
5. `降低拒绝率` / `免拒` / `拒答率太高` —— 需求词，不是技术词
6. `逆向不拒绝` / `破解 不报错` / `去混淆` —— 场景词
7. `免杀` / `绕过 AMSI` —— 高意图词，配 before-after 实测页
8. `dsh-purge 替代` / `破甲插件对比` —— 截流竞品搜索

**落点**

| 位置 | 写什么 |
| --- | --- |
| GitHub About / description | 主词开头：`dsh 破甲 · DSH 破甲插件 · DeepSeek Harness 破甲/越狱（jailbreak）…`，≤200 字符 |
| README 第 19 行（切换器下） | 一行 `**中文检索**` 词串，含 6 个主词 |
| README `## 🔎 中文检索对照` | 七行「你可能在搜 → 对应什么」表，把用户原话写进表格 |
| topics | 只能英文，但 `jailbreak` / `dsh-plugin` / `refusal-benchmark` 已有；中文靠 description + README |
| Pages `docs/index.html` | `<title>` 与 `<h1>` 必须含「dsh 破甲」原串；加 JSON-LD `alternateName` 中文别名；`robots.txt` + `sitemap.xml` |
| Google/Bing | 只有 Pages 页面能被收录，GitHub 自己不给搜索引擎喂 README 中文权重 |

**排名自查**

```bash
# 我们在「dsh 破甲」结果里的位置（0 = 没进前 100）
gh api "search/repositories?q=dsh%20%E7%A0%B4%E7%94%B2&per_page=100" --jq '.items | to_entries[] | select(.value.full_name=="xqpsec/dsh-jailbreak") | .key + 1'
# 总量与头部对手
gh api "search/repositories?q=dsh%20%E7%A0%B4%E7%94%B2&sort=stars&per_page=5" --jq '.total_count, (.items[] | "\(.stargazers_count) \(.full_name)")'
```

**已知事实**：2026-10-28 实测 `dsh 破甲` 共 89 个仓库，我们排 86（倒数第 4）。GitHub 仓库搜索的排序权重里 star 占比最大，词密度只能让我们在 0 star 的同类里往前挤；真正翻盘靠 star（发帖）。词密度做完后不要再堆词，堆到重复三遍以上反而被判低质。

### 2026-10-28 实测：改完中文面之后排名动了多少

改的内容：仓库 description 换主词开头、README 第 19 行加词串与 `## 🔎 中文检索对照` 表、README H1 加中文后缀、Pages 标题/H1/description/keywords 全换中文词、加 JSON-LD 与 `robots.txt`/`sitemap.xml`、补拼音 `dsh-pojia / pojia`。

| 查询 | 改前 | 改后（约 80 分钟后） |
| --- | --- | --- |
| `dsh 破甲` | 86 / 89 | **48 / 89** |
| `dsh 破甲插件` | — | **10 / 10（第 1 页）** |
| `dsh 越狱` | — | **6 / 7（第 1 页）** |
| `deepseek 破甲` | — | 53 / 87 |
| `jailbreak` | 9 / 10 | 9 / 10 |
| `dsh-jailbreak` | 1 / 1 | 1 / 1 |

**字段索引实测（用 in: 限定反推 GitHub 到底吃哪块）**

| 查询 | 命中量 | 我们在哪 | 说明 |
| --- | --- | --- | --- |
| `"请求边界注入"` | 1 | 1 | 精确短语搜索有效，description 确实被索引 |
| `破甲 in:description` | 245 | 前 100 无 | 排序不吃词频，吃 star —— 我们 description 第一个词就是破甲，仍进不去前 100 |
| `破甲 in:readme` | 9,683 | 前 100 无 | README 全文被索引，但同样被 star 权重压住 |
| `jailbreak in:name` | 9 | 8 | `arditbe/jailbreak`（0★，2022 年）排在 `xqpsec/dsh-jailbreak`（1★）前面：完全同名 > 连字符名 |

**结论**：词密度这一层已经到顶（再堆就是降权），剩下的排序位只有 star 能换。别指望改文案翻盘，改文案只能进「有资格被排进来」，进不去前排。
