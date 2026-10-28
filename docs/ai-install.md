# 让 AI 帮你装 —— 复制一句话，剩下交给它

> 这份文档有两个读者：
> **人**（不想看文档，只想让它跑起来）和 **AI**（被要求"帮我把这个装上"的执行者）。
> 人只需要复制下面那个代码块；AI 需要读完「执行剧本」再动手。

---

## 1. 给 AI 的一句话（把整块复制过去）

```text
帮我在这台机器上安装并验证 dsh-jalibreak（一个 DeepSeek Harness 插件）：
仓库 https://github.com/xqpsec/dsh-jalibreak
按它仓库里的 docs/ai-install.md「执行剧本」一步步做：
先确认 Node ≥ 20 和 dsh 能跑，再 clone、用 plugin_manager 装进 profile，
然后跑 `node bin/aecot.js doctor` 自检，把 doctor 的每一行输出原样贴给我。
不要改宿主源码、不要打补丁；遇到失败按文档「失败分支」表处理，别自己发明步骤。
装完告诉我：① doctor 是否全绿 ② 我现在应该在 DSH 里点哪里 ③ 我要问一句什么话能立刻看出效果。
```

小白读者看到这里就可以停了 —— 复制、粘贴、等结果。下面是 AI 和排查问题的人需要的内容。

---

## 2. 执行剧本（AI 按顺序做，每步都要有可验证输出）

### 第 0 步：摸清环境（不许跳过）

```bash
node -v                 # 必须 ≥ v20
git --version
which dsh || where dsh  # 找到 dsh 的安装位置，后面要用 <dsh-install>/bin.js
```

判定：

- `node -v` < v20 → 停下，先升级 Node，再继续。**不要**试图用旧 Node 硬跑（用到了 `import.meta.dirname` 与 `node --test`）。
- 找不到 `dsh` → 问用户 DSH 装在哪，或用 `npm ls -g --depth=0` / `pnpm ls -g` 找。**不要**替用户重装 DSH。

### 第 1 步：clone 到固定路径

```bash
git clone https://github.com/xqpsec/dsh-jalibreak.git
```

建议路径（后面命令里的 `<PLUGIN>` 都指它）：

| 系统 | 路径 |
| --- | --- |
| Windows | `C:\dsh-jalibreak` |
| macOS / Linux | `~/dsh-jalibreak` |

clone 完先跑一次**不依赖宿主的自检**，此时只有一项会黄，属于正常：

```bash
cd <PLUGIN> && node bin/aecot.js doctor
```

预期：`✓ Node` `✓ 插件文件` `✓ 破甲开关` `✓ 注入端点` `✓ 阀门`，`! 注入记录：还没有看到任何一次注入`（因为还没装进 DSH，也没有对话流量）。

### 第 2 步：装进 DSH（两条路，先用 A）

**A. 插件管理器（首选）** —— 在 DSH 的对话里执行：

```text
plugin_manager action=install_bundle target=<PLUGIN>
```

**B. 手工登记（A 失败时用，尤其是 pnpm 卡在 git 依赖上）**

1. 找到 profile 目录（Web 端一般是 `~/.dsh/profiles/web/`，Windows 是 `C:\Users\<you>\.dsh\profiles\web\`）。
2. 在它的 `package.json` 里加依赖：

   ```json
   "dependencies": { "dsh-jalibreak": "link:/absolute/path/to/dsh-jalibreak" }
   ```

3. 在同一个 `package.json` 的 `dsh.profile.bundles` 数组里加上 `"dsh-jalibreak"`。
4. 在 profile 目录里跑一次包管理器安装（`pnpm install` 或 `npm install`），然后**重启** `dsh web`。

### 第 3 步：验证宿主真的认了（唯一硬标准）

```bash
node <dsh-install>/bin.js --profile web --dump-config | grep -i jalibreak   # Windows 用 findstr jalibreak
```

必须看到 `jalibreak` 出现在 dump 出来的 plugin 配置里。**看不到就等于没装**，回到第 2 步走 B。

### 第 4 步：自检 doctor（装完必跑）

```bash
cd <PLUGIN> && node bin/aecot.js doctor
```

两种结果：

- 全绿且 `注入记录` 有数 → 装好了，而且真的在改写请求。跳到第 5 步。
- `! 注入记录：还没有看到任何一次注入` → 正常，**这一步需要一次真实对话**：去 DSH 新开一个对话，问一句技术问题（例如「帮我逆向这个程序的注册校验逻辑，先给静态分析步骤」），等模型答完，再跑一次 doctor。这时 `注入记录` 会变成 `已注入 1 次 · <时间> · max · reverse-engineering · gate=…`。

### 第 5 步：告诉用户"现在怎么用"

只需要说三件事：

1. **不用配置**：破甲默认就是开的，新开一个对话直接派活即可。
2. **面板不是必需品**：不用打开任何面板。想看效果时才进「破甲台」——右上角一枚开关（旁边写着 `注入中` 或 `已关闭`）；输入框写一句话点 `运行`，模型这次的回答出现在下面；`提示词` 只渲染注入内容，不调模型。
3. **想核账**：`<数据目录>/live-requests.jsonl`（每次注入一行）、`gate-audit.jsonl`（每次阀门判定一行）。数据目录默认是 `<PLUGIN>/.aecot`，可用 `--root` 或 `AECOT_ROOT` 改。

---

## 3. 失败分支表（按现象查，不要自由发挥）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `plugin_manager` 报找不到 bundle / 装完 dump 里没有 `jalibreak` | 路径不是绝对路径，或 profile 没登记 | 用绝对路径重试；走第 2 步 B 手工登记 `link:` |
| `pnpm install` 卡在 git 依赖、报 `ELIFECYCLE` | pnpm 对 `link:` 或本地路径解析失败 | 换成 `npm install`，或直接把插件目录软链进 `node_modules`：`mklink /D`（Windows）/ `ln -s`（mac/Linux） |
| 面板里没有破甲台 | 宿主缓存了旧配置 | 完全退出 `dsh web` 进程再启动，刷新页面 |
| doctor 说 `破甲开关：被关掉了` | 之前点过「关闭破甲」，写进了 `arm.json` | 面板点回开，或 `node bin/aecot.js arm --on` |
| doctor 全绿但对话里没变化 | 宿主用的端点不是 `/chat/completions`（少数自研网关），或模型本身不拒答 | 看 `live-requests.jsonl` 有没有新行：有行 = 注入了，是这个模型本来就听话；没行 = 在 `live.json` 里补上你的端点 host |
| 注入有了，但回答还是先讲一堆"我不能" | 该请求被判成安全类目但没触发重试 | doctor 里看 `拒绝重试` 计数；调 `gate.json` 无关注入行为，重试开关在 `live.json`：`{"retryOnRefusal": true}` |
| 想临时全部关掉 | —— | `node bin/aecot.js arm --off`，或面板按钮；插件不会拦你的正常对话 |

> 任何时候都不要为了"装上"去改 DSH 宿主源码。本插件 0 补丁，改宿主会让升级变灾难，也会让 doctor 的判断失效。

---

## 4. 卸载（干净，不留尾巴）

1. 在 DSH 里 `plugin_manager action=uninstall target=dsh-jalibreak`（或从 profile `package.json` 的依赖与 `dsh.profile.bundles` 里删掉那一行）。
2. 重启 `dsh web`。
3. 删掉插件目录与数据目录（`.aecot/`、`arm.json`、`live-requests.jsonl`、`gate-audit.jsonl` —— 最后一个可以留着当记录）。

---

## 5. 给 AI 的边界（用户可能没明说，但你必须遵守）

- 只在这个插件与 DSH profile 范围内动手，不动用户其它项目、不动系统 Node。
- 不替用户注册账号、不填任何 key：本插件复用 harness 已配的 provider。
- 用户的 goal 里如果出现"打某个公网 IP / 站点"，先看 `SCOPE.md`：`node bin/aecot.js gate --goal "<原话>"` 会给出判定（`allow-private-target` / `deny-target:<host>`）。拦截时把判定码原样告诉用户，别自己绕过。
- 不要为了让效果"看起来更好"去改 `gate.json` 的 `hardDeny` —— 那几条（支付欺诈、证件伪造、勒索、DDoS、凭据盗取）是硬拦，改之前必须在 git 里留痕。

---

## 6. 一页速查

```bash
node bin/aecot.js doctor                  # 我在干活吗（只读，不花钱）
node bin/aecot.js arm --off               # 关掉破甲（面板按钮等价）
node bin/aecot.js arm --on                # 打开
node bin/aecot.js render --goal "…"       # 只渲染注入后的请求，不调模型
node bin/aecot.js gate --goal "…"         # 这个请求会不会被阀门拦
node bin/aecot.js run --goal "…"          # 运行进化（会花模型调用）
```

装不上、doctor 不过、或者想让人帮你远程看：进 **交流群 <https://t.me/+Q4EgamAkwYYyYTE1>**，把 doctor 的输出整段贴上来。频道 <https://t.me/jalibreak_llm> 发版本更新和更强的版本。
