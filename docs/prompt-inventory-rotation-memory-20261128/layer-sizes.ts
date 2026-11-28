import { ROTATION_MEMORY_ENTRIES } from '/Users/Shogo/.agentstack/worktrees/HappySomerville/dialogue-model/runtime/stimuli/rotation-memory-data.ts';
import { projectOwnRotationMemory } from '/Users/Shogo/.agentstack/worktrees/HappySomerville/dialogue-model/runtime/stimuli/rotation-memory.ts';
import { rotationMemoryLayer, ROTATION_LEGENDS } from '/Users/Shogo/.agentstack/worktrees/HappySomerville/dialogue-model/runtime/decision/rotation-memory-guidance.ts';
const layers = ['nouns', 'roles', 'full'] as const;
const sizes: Record<string, Map<string, number>> = { nouns: new Map(), roles: new Map(), full: new Map() };
for (const e of ROTATION_MEMORY_ENTRIES) for (const r of [0, 90, 180, 270]) {
  const own = projectOwnRotationMemory({ figureKey: e.figureKey, rotation: r })!;
  for (const l of layers) { const n = JSON.stringify(rotationMemoryLayer(own, l)).length; const k = e.figureKey; sizes[l].set(k, Math.max(sizes[l].get(k) ?? 0, n)); }
}
for (const l of layers) {
  const arr = [...sizes[l].entries()].sort((a, b) => b[1] - a[1]);
  const all = arr.map(x => x[1]);
  const top = (n: number) => arr.slice(0, n).reduce((s, x) => s + x[1], 0);
  console.log(l, 'figures', arr.length, 'per-figure median', all[Math.floor(all.length / 2)], 'max', all[0], 'worst 3/4/6 =', top(3), top(4), top(6), 'top6', arr.slice(0, 6).map(x => x[0] + ':' + x[1]).join(' '), 'legend chars', ROTATION_LEGENDS[l].length);
}
const own = projectOwnRotationMemory({ figureKey: 'F1', rotation: 270 })!;
console.log(JSON.stringify(rotationMemoryLayer(own, 'nouns')));
