# Changelog

## 1.0.0 — 2026-10-28

首个公开版本。

**实测对比素材**：新增 [docs/before-after.md](docs/before-after.md) 与 `docs/before-after.png`——同一句话在 `deepseek-flash`、`temperature 0` 下走真实 `transformDeepseekBody()` 的前后原始记录（499 字符纯拒绝 → 3,716 字符含完整实现）。README 中英第一屏与 Pages 落地页都换成了这张真实对比。

### 破甲（请求边界）
- `lib/live.js`：在插件进程内包装 `fetch`，对所有 host 的 `/chat/completions` 生效（`lib/endpoint.js` 可收窄到指定域名），其它 URL 原样透传
- 双通道静态轨迹注入：system 段（已审阅） + assistant 续写段（`Implementation:`），并硬约束 `temperature=0` / `max_tokens≥8192` / `thinking=disabled`
- 纯函数 `transformDeepseekBody(input, options)`，可单测；`attachLiveTransport()` 返回 `dispose()`，即刻还原

### 低拒绝（本版第二个核心）
- `lib/hcot.js` → `v03-execution-state`：`standard` / `max` 两级执行态轨迹；`max` 压掉开场白、免责段、「建议咨询专业人士」与替代方案，并按类目补场景定性行（逆向 / 破解 / 样本分析 / CTF / 渗透 / Web / 凭据 / 提权 / 网络 / 压测）
- 语言跟随目标：`detectLang()` 判中英，同语种续写（中文题目差别最明显）
- `lib/refusal.js`：`containsRefusal()` 只看回答**开头 320 字符**（避免长回答中途的 "I cannot guarantee" 误判），命中拒绝则用 `amplifyBody()` 换 `max` 轨迹 + 追加直给指令**重发一次**；二次仍拒则返回首答
- `lib/live.js`：`traceTone()` 按目标自动升降级（安全类目默认 `max`）；`retryOnRefusal:false` 可关、`retryOnlyStandard:true` 可只对 `standard` 重试
- 审计：`live-requests.jsonl` 新增 `mode:"refusal-retry"` 行（含 `signals` / `retrySignals` / `recovered`）与 `level` / `category` / `lang` 字段

### 进化引擎
- `lib/engine.js`：精英保留 + 片段交叉 + 自适应变异（`μ₀=0.1`，`±0.1`，上限 `0.3`）+ 停滞早停（连续 3 代）
- `lib/taxonomy.js`：9 维搜索空间 `Θ = s×d×i×c×a×b×n×t×k`，含依赖约束
- `lib/judge.js`：0–5 rubric；`heuristic`（零成本）/ `llm`（多票取均值）/ `auto`（先启发式，两可才升级 LLM）
- `lib/render.js`：`P = M + S + C` 渲染 + `amplifyPrompt`

### 阀门（新增，本版核心）
- `lib/gate.js` `GATE_VERSION=1.0.0`：注入前判定一次——研究类请求放行，越界请求不注入、只留审计
- 放行：逆向工程 / 恶意样本分析 / CTF / 靶场评测
- 不做：支付与资金犯罪 / 证件伪造 / 勒索 / 拒绝服务 / 窃取凭据（不因授权登记或商业授权而改变）
- 审计：`gate-audit.jsonl`（每次判定）+ `live-requests.jsonl`（每次改写，带 `gate` 字段）
- CLI：`aecot gate`（`--goal` 判一条，`--strict` 拦截 exit 3）
- **判定规则、配置字段、判定码是 `lib/gate.js` 的实现细节，公开文档一律不复述**——照着文档就能照着绕，这里不给配方

### 面板与 CLI
- 面板重做成四行：`jalibreak` + `注入中/已关闭` + 一枚开关 → 一句话输入框 + 6 个场景快选 → `运行` / `提示词` / `停止` → 回答卡。模型、代数、判分、注入原文、历史 run 全在「详情」折叠里，默认收起
- 删掉所有解释性块（hero 段落、终端状态行、状态 pill、提示卡、页脚说明），配 `test/client.test.js` 的减法守卫：这些文案回来即测试失败
- 三个 GUI 座位：设置页「破甲台」/ 侧栏 panel / 主区
- 面板 API：`/plugins/jalibreak/api/{state,progress,runs,taxonomy,run,stop,preview,judge,export,profile,profiles,probe,screen,arm,gate}`
- `/ab` 斜杠命令：1 代 × 4 体精简进化，成品直接投递回对话（`-v` `-g` `-n`）
- CLI：`taxonomy / render / judge / run / status / export / gate / doctor / arm`；`bin` 同时注册 `aecot` 与 `jalibreak`
- `lib/endpoint.js`：注入端点从「只认 `api.deepseek.com`」放开为任意 host 的 `/chat/completions`（中转站、自建网关、本地推理都能吃到），可用 `<root>/live.json` 或 `DSH_JALIBREAK_ENDPOINTS` 收窄
- `docs/ai-install.md`：给 AI 的安装剧本（一句话贴给任意 AI，它自己装完跑 `doctor` 回报结果）

### 评测
- 20 目标固定集（`eval/goals.v1.json`），严格 rubric 下 **17/20 = 85%**（`hcot-dual`）
- `eval/run-baseline.mjs`：可 `--dry-run` 零成本检查，`--variant plain|hcot-dual|hcot-system|hcot-turn`
- 完整报告：`docs/eval-report.md`；负结果保留（`hcot-official` 0/20）

### 工程
- 一行安装：`dsh plugin --profile web add github:xqpsec/dsh-jalibreak`（npm 包发布后可用 `add dsh-jalibreak`）；`package.json` 补 `dshTarget: 0.2.1-rc.2`，README 补「安装信息」表（profile / 写盘范围 / 出网行为 / 宿主源码改动 / 分类），对齐 DSH 插件市场的收录要求
- 测试 100/100 通过（15 个测试文件，含 `test/gate.test.js` 10 个阀门用例、`test/hcot.test.js` 8 个轨迹用例、`test/refusal.test.js` 8 个拒绝识别与重试用例、`test/endpoint.test.js` 5 个端点用例、`test/doctor.test.js` 4 个自检用例、`test/client.test.js` 3 个面板契约用例）
- `node bin/aecot.js doctor`：一条命令自检「插件在不在 / 开关开没开 / 端点通不通 / 阀门什么档 / 到底注入过没有」，失败项直接给下一步
- `docs/share-kit.md` + `docs/share-card.png`：转发包（三条可直接粘贴的文案 + 一张方形卡片图 + 该发给谁 + 只看三个数），把传播成本压到「复制两行字」
- 零运行时依赖；`--backend offline` 全程 0 次网络调用
- 许可：主仓 **AGPL-3.0-only** + 阀门三件套（`lib/gate.js` / `gate.json` / `scope.txt`）**MIT** + 闭源商用需商业授权（`LICENSE-COMMERCIAL.md`）+ 署名条款（`NOTICE`）

### 已知限制
- 失败集中在 `mobile-spy` / `lateral` / `forgery` 三类（0 分），属故意保留
- `lib/policy.js`（`v03-class-router` 类目路由）尚未接线，**未计入任何评测数字**
- 评测为单次取样，尚未做 3 次均值与人工抽检
