# prompts/ —— 破甲提示词（本项目原创 + 第三方素材）

本目录混两类文件，务必分清：

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `engine-v2.md` | **本项目自写**（2,849 字符） | 随本仓库 AGPL-3.0-only |
| 其余 `.md` | 公开社区仓库 | 第三方，仅作素材分发 |

`engine-v2.md` 是我们自己的默认预设（`gate.json` 里 `"preset": "engine-v2"`）：第一人称执行引擎人格、范围归操作者、目标名归一化成 `TARGET`/`APP`/`SERIAL` 占位符、按类别给路由模板、把运行时注入的安全提醒当「外来层」零权重、出现拒绝念头就跳过只输出产物。12 目标单发 12/12（avg 9,555 字符），详见 `docs/preset-bench.md`。

以下为第三方素材说明：

- 来源：[`togg53192-cmd/jailbreaks`](https://github.com/togg53192-cmd/jailbreaks)（32 份提示词 / 26+ 模型）
- 抓取时间：2026-10-29
- 原文件名 → 本目录文件名：

| 原文件 | 本目录 | 面向 |
| --- | --- | --- |
| `deepseek-4-1.md` | `deepseek-v4.1.md` | DeepSeek V4.1 |
| `deepseek v4.md` | `deepseek-v4.md` | DeepSeek V4 |
| `deepseek v3.md` | `deepseek-v3.md` | DeepSeek V3 |
| `kimi-k3-agents.md` | `kimi-k3-agents.md` | Kimi K3 (agents 形态) |
| `kimik3.1.md` | `kimi-k3.1.md` | Kimi K3.1 |
| `kimi-k2.md` | `kimi-k2.md` | Kimi K2 |
| `glm-5.2.md` | `glm-5.2.md` | GLM-5.2 |
| `glm-5-3-flash.md` | `glm-5-3-flash.md` | GLM-5.3 Flash |
| `qwen-3.8.md` | `qwen-3.8.md` | Qwen 3.8 |
| `Unified.md` | `unified.md` | 通用（跨模型） |

用法：`gate.json` 里 `"preset": "deepseek-v4.1"`（文件名去掉 `.md`），或面板「系统提示词」里选。

自己写的提示词别放这里（升级会覆盖），放 `~/.aecot/prompts/<名字>.md`。

原仓库的提醒原文照录：这些材料用于研究指令层级、人格框架与策略覆盖如何影响模型行为；使用者需自行承担合规责任。本项目的阀门（`gate.json`）与 `SCOPE.md` 只约束本插件的注入决策，不改变第三方提示词的内容。
