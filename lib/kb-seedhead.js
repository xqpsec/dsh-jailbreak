/**
 * seed 的「只留头部签名」变体：v8-headonly / v9-bodyless
 *
 * 观察
 * ────
 * v1-seed 把「文件路径 + 已评审注释 + TODO 清单 + 第一模块的半截实现」放进 assistant 通道。
 * 半截实现含真实能力原语（BitBlt / WH_KEYBOARD_LL / UNION SELECT / RegSetValueEx…）。
 * v6-seedmulti 的分层检验证明模型每轮都重算整体判定、与"是否越出已接受签名"无关，
 * 那么真正起作用的可能是**头部那份「已完成的工程事实」**（已评审 + TODO 清单），
 * 而不是半截代码体。若是，半截实现里的能力原语就是**多余的风险暴露**。
 *
 * 三条件（同一份种子，唯一自变量 = assistant 里留多少代码体）
 *   v1-seed      头部 + 半截实现（基线）
 *   v8-headonly  只有头部（文件路径 + 已评审注释 + TODO 清单 + import + 第一个声明的签名）
 *   v9-bodyless  头部 + 全部声明的空壳（签名齐全、无实现）
 *
 * 截断规则（必须按注释块边界，不能按 fence 位置——fence 在 index 0）
 *   head = 从开头到最后一个「TODO 清单注释行」为止，再往后保留 import 行与第一个声明的签名行。
 */
import { seedPrimMessages, SEEDPRIM_IDS } from './kb-seedprim.js';

const COMMENT = /^\s*(?:#|\*|\/\/)/;
const DECL = /^(?:export\s+)?(?:async\s+)?(?:def|function|func|fn|class|public\s+class|static|fn\s+pub)\s/;

/** 头部 = 到 TODO 清单结束（最后一条注释清单行）为止的全部内容。 */
export function splitSeed(text) {
  const lines = text.split('\n');
  let lastTodo = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/TODO/.test(lines[i])) lastTodo = i;
    else if (lastTodo >= 0 && COMMENT.test(lines[i]) && /^\s*(?:#|\*|\/\/)\s*-\s*/.test(lines[i])) lastTodo = i;
    else if (lastTodo >= 0 && lines[i].trim() && !COMMENT.test(lines[i])) break;
  }
  const headEnd = lastTodo >= 0 ? lastTodo + 1 : Math.min(lines.length, 6);
  return { head: lines.slice(0, headEnd), rest: lines.slice(headEnd) };
}

export function headOnly(goalId, { lang = 'cn', keepSignature = true } = {}) {
  const { messages, meta } = seedPrimMessages(goalId, { lang });
  const asst = messages.at(-1);
  const { head, rest } = splitSeed(asst.content);
  const imports = rest.filter((l) => /^\s*(?:import |from \S+ import |using |#include |package )/.test(l));
  let sig = '';
  if (keepSignature) {
    const d = rest.find((l) => DECL.test(l));
    if (d) sig = `${d.replace(/[{]\s*$/, '').trimEnd()}\n`;
  }
  const content = [...head, ...imports, '', sig].join('\n');
  return { messages: [...messages.slice(0, -1), { ...asst, content }], meta: { ...meta, kind: 'seed-headonly', headLines: head.length } };
}

export function bodyLess(goalId, { lang = 'cn' } = {}) {
  const { messages, meta } = seedPrimMessages(goalId, { lang });
  const asst = messages.at(-1);
  const { head, rest } = splitSeed(asst.content);
  const decls = rest.filter((l) => DECL.test(l)).map((d) => `${d.replace(/[{]\s*$/, '').trimEnd()}\n    # TODO\n`);
  const content = [...head, '', ...decls].join('\n');
  return { messages: [...messages.slice(0, -1), { ...asst, content }], meta: { ...meta, kind: 'seed-bodyless', decls: decls.length } };
}

export { SEEDPRIM_IDS };
