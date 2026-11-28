// S4 records in which a request says one text differently (the rotation memory's texts and layers).
// buildRecords (s4-v3-records.ts) records the requests of the real runtime. mutateRecord rewrites one text everywhere it is recorded, as if the runtime had
// said it that way from the start, and carries every changed hash through the whole record: the hash of a request payload (and of a Luna request's messages)
// is recorded in the calls, the http posts, the expected requests and the other side's copy, and the sha256 of a changed string (the AI extraction prompt)
// is recorded on its own. After that the only thing that can disagree is the relation between the request and the independent table, which is what S4 judges.
import { createHash } from 'node:crypto';
import { hash } from '../../dialogue-model/runtime/diagnostics/parity-verify/core.ts';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export type Edit = { from: string; to: string };

/** `text` with the character at `index` replaced by one that is not there (a BMP character, so lengths and offsets do not move). */
export function changeOneChar(text: string, index: number): string {
  const at = ((index % text.length) + text.length) % text.length;
  return text.slice(0, at) + (text[at] === '〇' ? '々' : '〇') + text.slice(at + 1);
}

/** The positions a one-character change is tried at: the first character, the middle one and the last one. */
export const positionsOf = (text: string): number[] => [0, Math.floor(text.length / 2), text.length - 1];

/** A copy of `records` in which `edit` rewrites the payload of every recorded request that `applies` accepts (every copy of it), with the changed hashes carried through. `changed` counts the payloads rewritten. */
export function editRequests<T>(records: T, applies: (request: any) => boolean, edit: (payload: any) => void): { records: T; changed: number } {
  const copy = structuredClone(records) as any;
  const renamed = new Map<string, string>();
  let changed = 0;
  const visit = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    if ((value.provider === 'luna' || value.provider === 'jev') && value.payload && typeof value.payload === 'object' && applies(value)) {
      const before = hash(value.payload), beforeMessages = Array.isArray(value.payload.messages) ? hash(value.payload.messages) : null;
      edit(value.payload);
      const after = hash(value.payload);
      if (after !== before) { changed++; renamed.set(before, after); }
      if (beforeMessages !== null) { const afterMessages = hash(value.payload.messages); if (afterMessages !== beforeMessages) renamed.set(beforeMessages, afterMessages); }
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(copy);
  let text = JSON.stringify(copy);
  for (const [before, after] of renamed) text = text.split(before).join(after);
  return { records: JSON.parse(text), changed };
}

/** True when every recorded request still carries the hash of its own payload (and a generation request that of its messages): the record is consistent apart from what was changed on purpose. */
export function requestHashesConsistent(records: unknown): boolean {
  if (!records || typeof records !== 'object') return true;
  const value = records as any;
  if ((value.provider === 'luna' || value.provider === 'jev') && value.payload && typeof value.payload === 'object') {
    if (value.payloadSha256 !== hash(value.payload)) return false;
    if (value.phase === 'generation' && value.completeMessagesSha256 !== hash(value.payload.messages)) return false;
  }
  return Object.values(value).every(requestHashesConsistent);
}

/** True when some string of `records` holds `text`. */
export function holds(records: unknown, text: string): boolean {
  if (typeof records === 'string') return records.includes(text);
  if (!records || typeof records !== 'object') return false;
  return Object.values(records).some(child => holds(child, text));
}

/** A copy of `records` with `edit.from` replaced by `edit.to` in every string of it. `changed` is the number of strings that held it (0: the text is not in the record). */
export function mutateRecord<T>(records: T, edit: Edit): { records: T; changed: number } {
  const copy = structuredClone(records) as any;
  const renamed = new Map<string, string>();
  let changed = 0;
  const visit = (holder: any, key: string): void => {
    const value = holder[key];
    if (typeof value === 'string') {
      if (!value.includes(edit.from)) return;
      const next = value.split(edit.from).join(edit.to);
      changed++; renamed.set(sha256(value), sha256(next)); holder[key] = next;
      return;
    }
    if (!value || typeof value !== 'object') return;
    const request = (value.provider === 'luna' || value.provider === 'jev') && value.payload && typeof value.payload === 'object';
    const before = request ? hash(value.payload) : null;
    const beforeMessages = request && Array.isArray(value.payload.messages) ? hash(value.payload.messages) : null;
    for (const child of Object.keys(value)) visit(value, child);
    if (before !== null) {
      const after = hash(value.payload);
      if (after !== before) renamed.set(before, after);
      if (beforeMessages !== null) { const afterMessages = hash(value.payload.messages); if (afterMessages !== beforeMessages) renamed.set(beforeMessages, afterMessages); }
    }
  };
  visit({ root: copy }, 'root');
  let text = JSON.stringify(copy);
  for (const [before, after] of renamed) text = text.split(before).join(after);
  return { records: JSON.parse(text), changed };
}
