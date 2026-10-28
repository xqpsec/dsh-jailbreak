# Changelog

## 1.0.0 — 2026-10-28

首个公开版本。

### 破甲（请求边界）
- `lib/live.js`：在插件进程内包装 `fetch`，只对 `api.deepseek.com` 的 `/chat/completions` 生效，其它 URL 原样透传
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
- `lib/gate.js` `GATE_VERSION=1.0.0`：目标范围判定（loopback / RFC1918 / CGNAT / ULA / link-local / 实验后缀免登记）+ 类目判定
- 默认 `hardDeny`：`payment-fraud` `identity-forgery` `ransomware` `ddos` `credential-theft`（授权不可解除）
- 默认 `alwaysAllow`：`reverse-engineering` `malware-analysis` `ctf` `lab-eval`
- `gate.json` + `scope.txt`（一行一条，支持 CIDR / 后缀通配 / `until=` 到期）
- 审计：`gate-audit.jsonl` + `live-requests.jsonl`（带 `gate` 字段）
- 处置：`passthrough`（默认，不注入） / `block`（403）；支持 `enforce:false` 与 `dryRun`
- CLI：`aecot gate`（`--goal` 判一条，`--strict` 拦截 exit 3）

### 面板与 CLI
- 三个 GUI 座位：设置页「AE-CoT 破甲台」/ 侧栏 panel / 主区
- 面板 API：`/plugins/jalibreak/api/{state,progress,runs,taxonomy,run,stop,preview,judge,export,profile,profiles,probe,screen,arm,gate}`
- `/ab` 斜杠命令：1 代 × 4 体精简进化，成品直接投递回对话（`-v` `-g` `-n`）
- CLI：`taxonomy / render / judge / run / status / export / gate`；`bin` 同时注册 `aecot` 与 `jalibreak`

### 评测
- 20 目标固定集（`eval/goals.v1.json`），严格 rubric 下 **17/20 = 85%**（`hcot-dual`）
- `eval/run-baseline.mjs`：可 `--dry-run` 零成本检查，`--variant plain|hcot-dual|hcot-system|hcot-turn`
- 完整报告：`docs/eval-report.md`；负结果保留（`hcot-official` 0/20）

### 工程
- 测试 81/81 通过（11 个测试文件，含 `test/gate.test.js` 10 个阀门用例、`test/hcot.test.js` 8 个轨迹用例、`test/refusal.test.js` 8 个拒绝识别与重试用例）
- 零运行时依赖；`--backend offline` 全程 0 次网络调用
- 许可：主仓 **AGPL-3.0-only** + 阀门三件套（`lib/gate.js` / `gate.json` / `scope.txt`）**MIT** + 闭源商用需商业授权（`LICENSE-COMMERCIAL.md`）+ 署名条款（`NOTICE`）

### 已知限制
- 失败集中在 `mobile-spy` / `lateral` / `forgery` 三类（0 分），属故意保留
- `lib/policy.js`（`v03-class-router` 类目路由）尚未接线，**未计入任何评测数字**
- 评测为单次取样，尚未做 3 次均值与人工抽检
