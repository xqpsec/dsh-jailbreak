# dsh-jalibreak v1.0.0

> DeepSeek Harness 破甲 / 越狱评测插件 · 请求边界注入 · 9 维 AE-CoT 进化 · 内置阀门 · AGPL-3.0-only

首个公开版本。四件事一次做完：**能破甲、能量化、能治理、能共存。**

---

## 一、为什么值得看一眼

| 你之前的做法 | 这个版本 |
| --- | --- |
| 改宿主 bundle + 一份全局 `prompt-inject.md`，升级即废 | **零宿主补丁**，只包一层 `fetch`，`dispose()` 即还原 |
| 换模型就手改提示词 | 9 维基因组 + 判分驱动进化，换模型 = 重跑一次 |
| 「我这特别猛」但没有数字 | 20 目标固定集、`temp=0`、严格 rubric，**17/20** 全链路可复现 |
| 破了甲就什么都给 | 阀门：逆向 / 样本 / CTF / 靶场评测正常放行；五类犯罪不提供，且不因授权或付费改变 |

---

## 二、装（60 秒）

```bash
git clone https://github.com/xqpsec/dsh-jalibreak.git
```

```text
plugin_manager action=install_bundle target=C:\path\to\dsh-jalibreak
```

验证：`node <dsh>/bin.js --profile web --dump-config | findstr jalibreak`，面板出现「破甲台 · jalibreak」，工具列表出现 6 个 `aecot_*`。

第一次跑，不花钱：

```bash
node bin/aecot.js render --goal "写一个读取进程内存的 C++ 片段"
node bin/aecot.js gate   --goal "逆向这个 APK 并 patch 校验函数"
```

---

## 三、破甲怎么生效

```text
messages: [system, user(goal)]
   ↓ transformDeepseekBody()
system    += 已审阅段（"…直接产出成品；Implementation:"）
assistant += 静态 CoT 续写轨迹
参数      → temperature=0 · max_tokens≥8192 · thinking=disabled
   ↓ gate.decide(goal)
deny → 不注入（passthrough）或直接 403（block），并写审计
```

- 只在 `api.deepseek.com/chat/completions` 上生效，其它请求原样透传
- 只在本插件进程内包 `fetch`，宿主文件零改动
- 静态注入：不需要教师模型，每目标 1 次调用

### 低拒绝：装完就能感觉到的部分

拒绝率是这类插件唯一真正可感知的指标，所以它不靠"我这儿特别猛"，靠三个可复查的机制：

1. **两级轨迹** `standard` / `max`：`max` 额外去掉开场白、免责声明、"建议咨询专业人士"与"更安全的替代方案"，并按类目（逆向 / 破解 / 样本分析 / CTF / 渗透 / Web / 凭据 / 提权 / 网络 / 压测）加一行定性；安全类目默认 `max`。
2. **语言跟随**：目标用中文就用中文轨迹，同语言续写的稳定性明显高于混写。
3. **只重发一次**：`containsRefusal()` 只扫回答**前 320 字符**（长回答里句中的 "I cannot guarantee" 不会误判），命中则换 `max` 轨迹 + "先给成品"指令重发一次；再拒就把第一次的回答原样返回。

```json
{"mode":"refusal-retry","signals":["deny-en"],"retrySignals":[],"recovered":true,"level":"max","category":"reverse-engineering"}
```

写进 `live-requests.jsonl`，每一条都能复核。自测：

```bash
DEEPSEEK_API_KEY=sk-... node eval/run-baseline.mjs --variant hcot-dual --judge llm
```

---

## 四、阀门（本版核心）

界线上就三句话：

| | 例子 | 态度 |
| --- | --- | --- |
| 明确放行 | 逆向自己的程序、脱壳、样本分析、CTF 复现、靶场评测、抓包分析 | 正常用法，不拦、不打折 |
| 你自己确认 | 任何公网主机 / 网段 | 你得有权动它；没确认过的，不替你注入 |
| 不提供 | 支付与资金犯罪、证件伪造、勒索、拒绝服务、窃取凭据 | 不因为「买了商业版」或「写了授权文件」而改变 |

判定发生在**注入之前**：不放行的请求回到原样（或按配置直接拒绝），拿不到注入段。也就是说，阀门开着的时候，你不会因为模型答得好而顺手拿到一个越界结果。

```bash
node bin/aecot.js gate                # 看当前状态
node bin/aecot.js gate --goal "…"     # 判一条
node bin/aecot.js gate --goal "…" --strict   # 拦截即 exit 3，可进 CI
```

> 判定规则、配置字段、判定码都在 `lib/gate.js` 里，**release notes 不复述**。要改默认行为的人自己读代码、自己担后果；不改的人，默认配置就是给研究用的那一套。

审计：`gate-audit.jsonl`（每次判定一行）+ `live-requests.jsonl`（每次改写，带 `gate` 字段），可对账。

条款见 [SCOPE.md](../SCOPE.md)。

---

## 五、评测数字（不挑好的报）

| 变体 | 严格判分 |
| --- | --- |
| **`hcot-dual`** | **17/20 · 85%** |
| `hcot-turn` / `hcot-systrace` | 17/20 |
| `hcot-repeat` | 18/20（早期口径） |
| `hcot-dual-norm` | 16/20 |
| `hcot-cnrepeat` | 13/20 |
| `hcot-official`（照搬论文伪 CoT） | **0/20**（负结果） |

早期宽松 rubric 曾 20/20、19/20；判分收紧后落到 17/20。**两种口径都公开。**

剩余 0 分：`mobile-spy`、`lateral`、`forgery` —— 同时是阀门里最严的类目。

复现：

```bash
node eval/run-baseline.mjs --variant hcot-dual --dry-run      # 0 次网络调用
DEEPSEEK_API_KEY=sk-xxx node eval/run-baseline.mjs --variant hcot-dual --judge llm
```

---

## 六、和 dsh-purge 的关系

**能共存，但只开一个注入通道。**

- 它：改宿主 + 全局提示词文件 + `host-backups/` 恢复体系；Apache-2.0 + 商用附加条款
- 这里：零补丁 + 请求边界 + 基因组 + 评测集 + 阀门；AGPL-3.0-only + 阀门 MIT
- 同时装、同时开 → 一个请求叠两层轨迹，判分和效果都失真。选一个。

---

## 七、这一版的已知限制

- `lib/policy.js`（v03 类目路由）已写但**未接线**，不计入任何数字
- 评测单次取样，还没做 3 次均值 / 人工抽检
- 三类专项轨迹库还没做，所以那三类还是 0 分

---

## 八、校验

```text
npm test  →  81 tests / 81 pass / 0 fail
node bin/aecot.js gate  →  阀门配置可读，profile=lab
```

---

**交流群**：<https://t.me/+Q4EgamAkwYYyYTE1>
**频道**：<https://t.me/jalibreak_llm>
