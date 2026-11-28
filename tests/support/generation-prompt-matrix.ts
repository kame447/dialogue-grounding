// The generation prompts of v23 and v24 over a matrix of plans, flags and instructions, as one list of strings. A test pins a digest of this list taken from the production main
// (20b5366) and asks the current module for the same list: v24 and the earlier versions keep every byte. v25 adds a flag (`tidied`) and a constant; it changes nothing without them.
import { createHash } from 'node:crypto';

type Prompt = (input: any) => string;
const target = { kind: 'single', figureId: 'f0' } as const;
const multiple = { kind: 'multiple', figureIds: ['f0', 'f1'] } as const;
const issue = { kind: 'resolve_issue', issueId: 'q', claimId: '3:local1', sourceTurn: 3 } as const;
const base = { publicQuestions: [], visualDetail: false, humanLedTransition: false, closing: null, reconsidered: false, continuing: false,
  namingRequest: false, namingConflict: null, withdrawnName: null };

const ITEMS: Record<string, any[]> = {
  accept: [{ action: 'accept', target }],
  propose_name: [{ action: 'propose_name', target, name: '鳥' }],
  agree: [{ action: 'agree', target, name: '鳥' }],
  confirm: [{ action: 'confirm', target, visualPurpose: { kind: 'clarify_reference' } }],
  confirm_issue: [{ action: 'confirm', target, issue }],
  repair: [{ action: 'repair', target, visualPurpose: { kind: 'resolve_mismatch' } }],
  hold_open: [{ action: 'hold_open', target, issue }],
  carry_over: [{ action: 'carry_over', target, destination: { kind: 'partner_choice' } }],
  consult: [{ action: 'consult', target, issue }],
  revisit: [{ action: 'revisit', target: multiple }],
  confirm_repair: [{ action: 'confirm', target, visualPurpose: { kind: 'clarify_reference' } }, { action: 'repair', target, visualPurpose: { kind: 'resolve_mismatch' } }],
  accept_consult: [{ action: 'accept', target }, { action: 'consult', target, issue }],
};

/** Every prompt of the matrix, in a fixed order. `extra` is merged into every input (v25 passes `tidied`). */
export function promptMatrix(actionPrompt: Prompt, extra: Record<string, unknown> = {}): string[] {
  const out: string[] = [];
  for (const [name, items] of Object.entries(ITEMS)) for (const respondToRequest of [false, true]) for (const continuing of [false, true])
    for (const visualDetail of [false, true]) for (const omitVisualSources of [false, true]) for (const rotationSources of [false, true]) {
      const input = { ...base, ...extra, items, respondToRequest, continuing, visualDetail, omitVisualSources, rotationSources };
      try { out.push(name + '|' + actionPrompt(input)); } catch (error) { out.push(name + '|throws|' + (error as Error).message); }
    }
  for (const closing of [{ initiator: 'human', unresolved: true }, { initiator: 'ai', unresolved: true }, { initiator: 'ai', unresolved: false }])
    out.push('close|' + actionPrompt({ ...base, ...extra, items: [{ action: 'close', target: { kind: 'none' } }], closing }));
  out.push('moveOn|' + actionPrompt({ ...base, ...extra, items: ITEMS.confirm, humanLedTransition: true, respondToRequest: true, visualDetail: true }));
  out.push('naming|' + actionPrompt({ ...base, ...extra, items: ITEMS.confirm, namingRequest: true, respondToRequest: true, visualDetail: true,
    namingConflict: { agreedName: '猫', proposedNames: ['犬'] } }));
  out.push('withdraw|' + actionPrompt({ ...base, ...extra, items: ITEMS.confirm, withdrawnName: '鳥', reconsidered: true }));
  return out;
}

export const digestOf = (lines: readonly string[]): string => createHash('sha256').update(JSON.stringify(lines), 'utf8').digest('hex');
