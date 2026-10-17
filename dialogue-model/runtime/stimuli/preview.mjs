import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { FIGURES } from './figures.mjs';
import { createTrial, createLayouts } from './board.mjs';
import { validateFigures } from './geometry.mjs';
import { renderFigure } from './render.mjs';

const { values } = parseArgs({ options: { seed: { type: 'string', default: '1' }, out: { type: 'string' } } });
if (!values.out || !/^-?\d+$/u.test(values.seed) || !Number.isSafeInteger(Number(values.seed))) {
  throw new Error('Usage: node dialogue-model/runtime/stimuli/preview.mjs --seed N --out <directory>');
}
const validation = validateFigures(FIGURES);
if (!validation.valid) throw new Error(validation.errors.join('; '));
const seed = Number(values.seed), out = resolve(values.out), trial = createTrial({ seed });
await mkdir(out, { recursive: true });
await writeFile(join(out, 'human.png'), trial.human.png);
await writeFile(join(out, 'ai.png'), trial.ai.png);
const filenames = ['upper-left.png', 'upper-middle.png', 'upper-right.png', 'lower-left.png', 'lower-middle.png', 'lower-right.png'];
const singleFigureFiles = {};
for (const [i, item] of createLayouts({ seed }).human.entries()) {
  const figure = FIGURES.find(f => f.id === item.figureId);
  await writeFile(join(out, filenames[i]), renderFigure(figure, { rotation: item.rotation }));
  singleFigureFiles[item.slot] = filenames[i];
}
// The key is researcher-only: stdout, never PNG metadata or a sidecar file.
console.log(JSON.stringify({ trialId: trial.trialId, seed, key: trial.key, singleFigureFiles }, null, 2));
