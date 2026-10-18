import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../dialogue-model/runtime/web');
const out = resolve(import.meta.dirname, 'dist');
await mkdir(out, { recursive: true });
for (const file of ['index.html', 'app.js', 'style.css']) await cp(resolve(root, file), resolve(out, file));
