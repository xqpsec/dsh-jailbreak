# 转发包（share kit）——给「有账号的人」用的最小单位

自己没有账号时，最快的传播路径不是注册，是**让别人顺手一转**。转的人不需要懂技术，只需要复制两行字加一张图。

这个包里只有三样东西：**一张图**、**三条文案**、**三个该发给谁**。

![转发卡片](share-card.png)

---

## 一、三条文案（照抄，别改）

### 1) 丢群里（最常用，60 字内）

```
DSH 的破甲插件，开源、0 处宿主补丁：同一个问题，装之前是「我不能」，装之后直接给完整代码。
github.com/xqpsec/dsh-jalibreak
```

### 2) 私聊一个朋友（更软，带具体场景）

```
你之前说 DSH 里问逆向老被拒——装这个，一行：
dsh plugin --profile web add github:xqpsec/dsh-jalibreak
我试过，AMSI 那个例子从 499 字符的拒绝变成 3,716 字符带完整实现。开源，带阀门，逆向/CTF 放行。
```

### 3) 技术群 / 论坛（带证据，抗质疑）

```
dsh-jalibreak：DeepSeek Harness 的请求边界破甲插件。
- 0 处宿主补丁（对比打补丁那类插件的 82 处改动），宿主升级不用重来
- 20 个固定目标 + 严格 rubric，17/20，results.jsonl 在仓库里，可以自己重跑
- 首答被拒会自动换轨迹重发一次
- 自带阀门：逆向/破解/样本分析/CTF 放行，未授权渗透与几类犯罪动作拦掉
前后实测：github.com/xqpsec/dsh-jalibreak/blob/main/docs/before-after.md
```

英文版在 `docs/launch-kit.md` 第二节，直接取。

---

## 二、发给谁（按成功率排，全零成本）

| 对象 | 怎么做 | 成功率 | 成本 |
| --- | --- | --- | --- |
| 已经在用 DSH 的朋友（1–3 人） | 私聊，贴上面第 2 条 + `docs/before-after.png` | 高（熟人） | 0 |
| 你自己的 TG 群 / 频道 | 群公告置顶第 1 条 + 卡片图 | 高 | 0 |
| 群友二次转发 | 群里说一句「谁觉得有用就转一下，图我放这了」 | 中 | 0 |
| 同类插件仓库的维护者 | 提 PR 在 README 的 Related / 相关项目里加一行（模板见下） | 低但长尾 | 0 |
| 中文技术频道（付费转发） | 50–200 元/次，通常 1k–5k 阅读 | 中 | 有 |
| 公众号 / 大 V | 500–2,000 元/篇 | 低（受众不匹配） | 高 |

**结论：先只做前三行。** 开源版不产生收入，任何付费投放的 ROI 都是负的；等 TG 群里有人主动问「有没有更强的版本」，再谈付费渠道。

### 给同类仓库提 PR 的模板（Related 节加一行）

```markdown
- [dsh-jalibreak](https://github.com/xqpsec/dsh-jalibreak) — 另一种思路：不改宿主源码，在请求边界改写；20 目标可复现基线，自带范围阀门。
```

候选仓库（都是破甲/DSH 生态里 star 较高的，README 有 Related/相关项目节的才提）：

```
z91772524-ai/pojia-next            875★
ADWMC/helm-d                       807★
JeffKeeping/dsh-purge-plus         528★
WoYun520/dsh-purge                 458★
chiina66/dsh-prompt-inject          76★
```

---

## 三、节奏（别一次发完，三次触达）

| 时间 | 动作 | 换什么角度 |
| --- | --- | --- |
| D0 | 群里发第 1 条 + 卡片图 | 「装之前/装之后」的对比 |
| D3 | 群里再提一次，用第 3 条 | 换成「0 补丁 / 可复现评测」的技术角度 |
| D7 | 提一次「更新了」 | 有新版就发 release 链接；没有就发一条实测记录 |

同一个群两次之间至少隔 3 天，第三次之后停手——继续发会掉人。

---

## 四、只看三个数（其他都是噪音）

```bash
# 1) star / fork
gh api repos/xqpsec/dsh-jalibreak --jq '"stars=\(.stargazers_count) forks=\(.forks_count)"'

# 2) 克隆数（14 天窗口，需要 owner 权限）——这才是「真有人装」的证据
gh api repos/xqpsec/dsh-jalibreak/traffic/clones --jq '"clones=\(.count) uniques=\(.uniques)"'

# 3) 访问来源（同一个 API 组）
gh api repos/xqpsec/dsh-jalibreak/traffic/views --jq '"views=\(.count) uniques=\(.uniques)"'
```

判断标准：群里发完 48 小时内 **uniques 涨 20 以上**说明文案有效；克隆数不动说明「看到了但没装」——问题在安装那一行，不在文案。

---

## 五、一句话

**没有账号不影响传播，影响传播的是「别人转发时要不要动脑」。** 把文案压到一条消息能贴完、把图做到不用点开链接就懂，剩下的事交给群友。
