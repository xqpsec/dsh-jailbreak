/**
 * research-engine.js — vendored copy of the global research transform engine.
 * Sourced from ../../../core/engine.mjs and the KB modules below; kept here so the
 * published plugin is self-contained (its `files` field ships only `lib`).
 */
import { primAll, PRIM } from './kb-primitivize.js';
import { BAC, SHELL_BAC } from './kb-artifact.js';
import { augPrompt, seedOf } from './kb-augment.js';

export const STRATEGIES = ['raw', 'primitive', 'bac', 'primitive-bac', 'bon', 'bon-lite', 'bon-noise'];
export class EngineInputError extends Error {}

function assertGoal(goalId) {
  if (!PRIM[goalId]) throw new EngineInputError(`未知 goalId: ${goalId}`);
}

export function buildPrompt(goalId, strategy = 'primitive', { seed = 0, n = 0 } = {}) {
  assertGoal(goalId);
  if (!STRATEGIES.includes(strategy)) throw new EngineInputError(`未知 strategy: ${strategy}`);
  const actualSeed = strategy.startsWith('bon') ? seedOf(goalId, strategy, n, seed) : seed;
  switch (strategy) {
    case 'primitive': return primAll(goalId)[0].content;
    case 'bac': return `背景：${BAC[goalId].text}\n\n${PRIM[goalId].cap}`;
    case 'primitive-bac': return SHELL_BAC(BAC[goalId].text, PRIM[goalId].mods);
    case 'bon': return augPrompt(goalId, actualSeed, { shuffle: true, style: true, case: true, noise: true, noiseN: 6 }).prompt;
    case 'bon-lite': return augPrompt(goalId, actualSeed, { shuffle: true, style: true, case: false, noise: false }).prompt;
    case 'bon-noise': return augPrompt(goalId, actualSeed, { shuffle: false, style: false, case: false, noise: true, noiseN: 6 }).prompt;
    case 'raw': return PRIM[goalId].cap;
    default: throw new EngineInputError(`未实现 strategy: ${strategy}`);
  }
}
