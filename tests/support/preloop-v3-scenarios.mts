// Synthetic scenarios for the pre-loop (legacy, style) replay tapes. Wording is synthetic; no study data.
import type { Scenario } from './preloop-v3-generate.mts';

const seg = (id: string, quote: string, aspect: string, targets: string[], name: string | null = null) =>
  ({ segmentId: id, quote, proposition: quote, aspect, targets, name, linkedIssueId: null, respondsToTurn: null });
export function scenarios(first: string): Scenario[] {
  const adaptive = { version: 'adaptive_repair_v3' };
  const proposeText = '「かかし」とかどう？';
  const proposeTurn = { human: proposeText, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', extraction: JSON.stringify([seg('s1', proposeText, 'name', [], 'かかし')]), act: 'name_propose',
    speech: '輪が細い棒につながる形ですか？' } };
  return [
    { name: 'S1-accept', turns: [{ human: 'どんな図形がありますか？', plan: { action: 'accept', target: 'none', speech: 'そう見えるんですね。' } }] },
    { name: 'S1-confirm-adaptive', technicalTrial: adaptive, turns: [{ human: '輪のついた形を見比べたいです。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: '輪の形ですか？' } }] },
    { name: 'S2-defer-veto', technicalTrial: adaptive, turns: [{ human: 'どれから話しましょうか。', plan: { action: 'defer', target: 'none', speech: '先に進みましょう。' } }] },
    { name: 'S3-propose-partner-name', technicalTrial: adaptive, turns: [proposeTurn,
      { human: 'ええと、それは決めずに別の話をしましょう。', plan: { action: 'propose_name', target: 'figure_0', name: 'かかし', speech: '「かかし」でどうでしょうか？', drafts: ['「かかし」でどうでしょうか？'] } }] },
    { name: 'S4-agree-unbound', technicalTrial: adaptive, turns: [proposeTurn,
      { human: 'さっきの呼び方でいいですか？', plan: { action: 'agree', target: 'figure_0', referent: 'figure_0', name: 'かかし', act: 'name_propose', speech: '「かかし」と呼びましょう。', drafts: ['「かかし」と呼びましょう。'],
        extraction: JSON.stringify([seg('s1', 'さっきの呼び方でいいですか？', 'name', [first], 'かかし')]) } }] },
    { name: 'S5-reobserve', turns: [{ human: '輪の切れ目を確かめてください。', plan: { action: 'confirm', target: 'figure_0', reobserve: true, speech: '輪の切れ目を確かめますね。' } }] },
    { name: 'S6-orientation-leak-regenerate', turns: [{ human: '形を教えてください。', plan: { action: 'accept', target: 'none', drafts: ['右向きに伸びた細い形ですね。', 'そう見えるんですね。'] } }] },
    { name: 'S7-orientation-leak-twice', turns: [{ human: '形を教えてください。', plan: { action: 'accept', target: 'none', drafts: ['右向きに伸びた細い形ですね。', '上に伸びた細い形ですね。'] } }] },
  ];
}
