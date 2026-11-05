/**
 * 数据目录解析 —— 插件里所有「落盘位置」的唯一出处。
 *
 * 历史坑：早期版本用 `process.cwd()/.aecot` 当默认根目录。DSH Web 常由 watchdog /
 * 计划任务拉起而没有设 cwd，Windows 上 cwd 会落到
 * `C:\Windows\System32\DriverStore\FileRepository\...`，于是：
 *   - arm.json（破甲开关）写在一个和用户无关的目录，换个启动方式就「忘记」开过；
 *   - gate.json / prompts/ / gate-audit.jsonl 同样散落，用户放的自定义预设永远读不到；
 *   - 该目录通常不可写，状态只活在内存里，重启即失效 —— 表现为「装上没效果」。
 *
 * 所以默认值改成与 cwd 无关的固定位置：`<home>/.dsh/jailbreak`。
 * 覆盖顺序：显式入参 > 配置 root > 环境变量 AECOT_ROOT > 默认。
 */

import path from 'node:path';
import os from 'node:os';

export const DATA_DIR_NAME = 'jailbreak';

export function homeDir(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir() || process.cwd();
}

export function defaultDataRoot(env = process.env) {
  return path.join(homeDir(env), '.dsh', DATA_DIR_NAME);
}

export function resolveDataRoot(input, config, env = process.env) {
  const raw = input || config?.root || env.AECOT_ROOT || defaultDataRoot(env);
  return path.resolve(raw);
}
