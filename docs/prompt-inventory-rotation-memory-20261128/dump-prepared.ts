// Build realistic prepared memos (3/4/6 figures) in the 4e09b62 tree; used as same-format stand-ins for both trees.
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const ROOT = process.env.TREE!, OUT = process.env.OUT!;
const imp = (p: string) => import(pathToFileURL(ROOT + '/' + p).href);
const { createTrialV2, modelView } = await imp('dialogue-model/runtime/stimuli/scatter-v2.mjs');
const { REVIEWED_PART_GEOMETRY_VERSION } = await imp('dialogue-model/runtime/stimuli/part-geometry.ts');
const { preparedObservationMemo } = await imp('dialogue-model/runtime/observation/observe.ts');
const ids = ['F6', 'F11', 'F16', 'F19', 'F20', 'F30'];
const result: Record<string, unknown> = {};
for (const n of [3, 4, 6]) {
  try {
    const trial = createTrialV2({ seed: 41, figureSelection: { mode: 'custom', figureIds: ids.slice(0, n) } });
    const model = modelView(trial, { partObservationVersion: REVIEWED_PART_GEOMETRY_VERSION });
    const own = { ownImage: { mimeType: model.mimeType, base64: model.png.toString('base64') }, ownAnchors: model.anchors, ownParts: model.parts };
    const memo = preparedObservationMemo(own, '2026-11-28T00:00:00.000Z');
    result[String(n)] = { anchors: model.anchors, memo, ownParts: model.parts, memoChars: JSON.stringify(memo).length };
    console.log(n, 'memo chars', JSON.stringify(memo).length, 'figures', memo?.figures.length);
  } catch (e) { console.log(n, 'ERR', (e as Error).message); }
}
writeFileSync(OUT, JSON.stringify(result));
