import { ROTATION_MEMORY_ENTRIES } from '/Users/Shogo/.agentstack/worktrees/HappySomerville/dialogue-model/runtime/stimuli/rotation-memory-data.ts';
import { projectOwnRotationMemory } from '/Users/Shogo/.agentstack/worktrees/HappySomerville/dialogue-model/runtime/stimuli/rotation-memory.ts';
// For every view with a whole construal: how many roles carry a word that a part candidate of the same region/view does not already carry?
let roles = 0, covered = 0, views = 0, viewsWithRole = 0;
for (const e of ROTATION_MEMORY_ENTRIES) {
  const own = projectOwnRotationMemory({ figureKey: e.figureKey, rotation: 0 })!;
  for (const v of [own.current, ...own.turned]) {
    if (!v.whole.length) continue; views++;
    for (const w of v.whole) for (const [id, role] of Object.entries(w.roles)) {
      roles++;
      const nouns = (v.parts[id] ?? []).map(c => c.noun);
      if (nouns.some(n => role.includes(n) || n.includes(role))) covered++;
    }
  }
}
console.log('roles', roles, 'overlap with a part noun of the same region', covered, (covered / roles * 100).toFixed(0) + '%', 'views with whole', views);
