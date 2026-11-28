// Registers (or re-registers) the S4 prompt version of the rotation memory in parity-verify/intervention-records.ts from the CURRENT sources.
// S4 selects the instruction text of a record by run.promptSources (the sha256 of every prompt-bearing source file) and never passes an unregistered set.
// Run it from the repository root, after the last change to any of those files: `node docs/prompt-inventory-rotation-memory-20261128/s4-register-prompt-version.ts [--check]`.
// Existing rows are never touched; only the row with this id is inserted before the historical rows (or replaced when the id exists). `--check` only compares.
import { readFileSync, writeFileSync } from 'node:fs';
import { promptSourceManifest } from '../../dialogue-model/runtime/diagnostics/parity-live/audit.ts';

const ID = 'p5_pilot012_rotation_memory_v1';
const FILE = new URL('../../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts', import.meta.url);
const manifest = await promptSourceManifest();
const files = Object.entries(manifest.files).map(([name, digest]) => `  '${name}':'${digest}',`).join('\n');
const row = ` // Rotation memory (new pin): the v24 instruction text for every earlier mode plus the rotation-memory texts carried only by a request whose memo has a rotation memory.
 {id:'${ID}',i172:true,fourFigures:true,threeFigures:true,styleMode:'research_split',sources:{scheme:'complete_instruction_source_sha256',files:{
${files}
 }},fixed:FIXED_I172,native:NATIVE_I172},
`;
const text = readFileSync(FILE, 'utf8');
const tail = '}},fixed:FIXED_I172,native:NATIVE_I172},\n';
const start = text.indexOf(' // Rotation memory (new pin): the v24 instruction text');
const end = start < 0 ? -1 : text.indexOf(tail, start) + tail.length;
const anchor = ' ...HISTORICAL_MAIN_PROMPT_SOURCES.map(({id, files}) => ({';
let next: string;
if (start >= 0) next = text.slice(0, start) + row + text.slice(end);
else {
  const at = text.indexOf(anchor);
  if (at < 0) throw new Error('anchor row not found');
  next = text.slice(0, at) + row + text.slice(at);
}
if (process.argv.includes('--check')) {
  console.log(next === text ? 'registered row matches the current sources' : 'registered row is missing or differs from the current sources');
  process.exit(next === text ? 0 : 1);
}
writeFileSync(FILE, next);
console.log(`${start >= 0 ? 'replaced' : 'inserted'} ${ID} with ${Object.keys(manifest.files).length} files`);
