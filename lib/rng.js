/**
 * 确定性随机数：同一个 seed 必须复现同一场进化（论文的可复现性要求）。
 * 不使用 Math.random，避免同一 run 的日志无法回放。
 */

/** xmur3 字符串散列 → 32bit 种子 */
export function hashSeed(str) {
  let h = 1779033703 ^ String(str).length;
  for (let i = 0; i < String(str).length; i++) {
    h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** mulberry32：32bit 状态的快速 PRNG，返回 [0,1) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 组合出引擎需要的随机操作面 */
export function makeRng(seed) {
  const seedStr = String(seed ?? 'aecot');
  const next = mulberry32(hashSeed(seedStr)());
  const api = {
    seed: seedStr,
    next,
    float: next,
    int: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** 无放回抽 k 个（k 可能大于 len，则全取） */
    sample(arr, k) {
      const pool = arr.slice();
      const out = [];
      const n = Math.min(k, pool.length);
      for (let i = 0; i < n; i++) out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
      return out;
    },
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
  return api;
}

/** 稳定 short hash，用于 fitness 缓存 key */
export function stableHash(str) {
  const gen = hashSeed(str);
  return gen().toString(16).padStart(8, '0');
}
