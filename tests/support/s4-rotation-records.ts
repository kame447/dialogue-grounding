// #269: S4 records for the three stimulus rotation modes.
// buildRecords (s4-v3-records.ts) records the Jev requests through the offline replay, which always states the original relative_pm90 premise.
// retargetRotation rewrites exactly those requests to another mode: it sets the mode the request state records, puts a given premise sentence in
// place of the relative_pm90 one in every instructions string, and carries the new request hashes through the whole record, so the only thing that can
// disagree afterwards is the relation between the recorded mode and its sentence, which is what S4 has to judge.
// The sentences below are the task contract's, written here for this test; they are not read from the runtime.
import { hash } from '../../dialogue-model/runtime/diagnostics/parity-verify/core.ts';

export const PREMISE_PM90 = '課題の条件として、相手の盤面は自分の盤面と同じ図形を±90度ほど回転して提示しています（relative_pm90）。向きや方位を表す語（上・下・左・右・縦・横など）は、相手と自分で一致しない前提で扱い、向きに依存しない特徴で照合してください。';
export const PREMISE_90_180_270 = '課題の条件として、相手の盤面は自分の盤面と同じ図形をそれぞれ90度・180度・270度のいずれかの角度で回転して提示しています（relative_90_180_270）。向きや方位を表す語（上・下・左・右・縦・横など）は、相手と自分で一致しない前提で扱い、向きに依存しない特徴で照合してください。';
export type RotationMode = 'relative_pm90' | 'relative_0' | 'relative_90_180_270';
/** The premise the contract gives a mode; relative_0 states none. */
export const premiseOf = (mode: RotationMode): string | null => mode === 'relative_pm90' ? PREMISE_PM90 : mode === 'relative_90_180_270' ? PREMISE_90_180_270 : null;

type Request = { provider?: string; payload?: { state?: unknown; questions?: Record<string, { instructions?: unknown }> }; payloadSha256?: string; preProjectionPayloadSha256?: string };
const isJudgmentRequest = (value: any): value is Request => !!value && typeof value === 'object' && value.payload && typeof value.payload === 'object' &&
  typeof value.payload.state === 'string' && value.payload.questions && typeof value.payload.questions === 'object' && /"view":"judgment_v5"/u.test(value.payload.state);

/** The request payload of one judgment request with the recorded mode and premise replaced. Returns null when the payload is not a relative_pm90 judgment request. */
export function retargetPayload(payload: NonNullable<Request['payload']>, { stateMode, premise }: { stateMode: string; premise: string | null }) {
  const state = JSON.parse(payload.state as string);
  if (state.rotationMode !== 'relative_pm90') return null;
  const questions: Record<string, { instructions?: unknown }> = {};
  for (const [key, question] of Object.entries(payload.questions!)) {
    const text = question.instructions;
    if (typeof text !== 'string') { questions[key] = question; continue; }
    const at = text.indexOf('\n' + PREMISE_PM90);
    if (at < 0) { questions[key] = question; continue; }
    if (text.indexOf('\n' + PREMISE_PM90, at + 1) >= 0) throw new Error('the premise appears twice in ' + key);
    questions[key] = { ...question, instructions: text.slice(0, at) + (premise === null ? '' : '\n' + premise) + text.slice(at + 1 + PREMISE_PM90.length) };
  }
  return { ...payload, state: JSON.stringify({ ...state, rotationMode: stateMode }), questions };
}

/** A record set whose judgment requests record `stateMode` and state `premise` (null: no premise sentence). The original set is left as it is. */
export function retargetRotation<T>(records: T, edit: { stateMode: string; premise: string | null }): T {
  const copy = structuredClone(records) as any;
  const renamed = new Map<string, string>(), lengths = new Map<number, number>();
  let rewritten = 0;
  const walk = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (isJudgmentRequest(value)) {
      const next = retargetPayload(value.payload!, edit);
      if (next) {
        // The recorded hashes are those of the payload as sent; check that before relying on the same scheme for the new payload.
        const before = hash(value.payload), after = hash(next);
        if (value.payloadSha256 !== before || value.preProjectionPayloadSha256 !== before) throw new Error('an unexpected request hash scheme');
        lengths.set((value.payload!.state as string).length, (next.state as string).length);
        renamed.set(before, after); value.payload = next; value.payloadSha256 = after; value.preProjectionPayloadSha256 = after; rewritten++;
      }
      return;
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(copy);
  if (!rewritten) throw new Error('no relative_pm90 judgment request to retarget');
  // The same request hash is also recorded in the calls, the expected requests and the other side's copy.
  let text = JSON.stringify(copy);
  for (const [before, after] of renamed) { if (!text.includes(before)) throw new Error('hash not found'); text = text.split(before).join(after); }
  const result = JSON.parse(text);
  // The turn's own evidence records how many characters of state each request carried; another mode name is another length, so those figures follow.
  // (The figures of earlier turns belong to other requests and stay; the synthetic turns of this suite never share a length.)
  const follow = (value: any) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'stateChars' && typeof child === 'number' && lengths.has(child)) value[key] = lengths.get(child);
      else follow(child);
    }
  };
  follow(result);
  return result;
}

/** The records of a mode as the contract describes them. */
export const retargetToMode = <T>(records: T, mode: RotationMode): T => retargetRotation(records, { stateMode: mode, premise: premiseOf(mode) });
