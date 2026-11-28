// Summarise captured requests: per request kind, message/section sizes, estimated tokens, and strategy parity.
import { readFileSync, writeFileSync } from 'node:fs';
const IN = process.env.IN!, OUT = process.env.OUT!;
const data = JSON.parse(readFileSync(IN, 'utf8')) as any[];
const est = (s: string) => { let cjk = 0; for (const ch of s) if (ch.charCodeAt(0) > 0x7f) cjk++; return Math.round(cjk * 1.0 + (s.length - cjk) / 3.5); };
const text = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p?.type === 'text' ? p.text : '[image]').join('') : JSON.stringify(c);

function kindOf(r: any): string {
  if (r.provider === 'luna') return r.phase;
  const keys = Object.keys(r.body.questions);
  if (keys.includes('human_referent')) return 'jev:human_referent';
  if (keys.includes('action')) return 'jev:action';
  if (keys.includes('target')) return 'jev:target';
  if (keys.some(k => k.endsWith('_support'))) return 'jev:ai_support';
  if (keys.some(k => k.endsWith('_act'))) { const st = JSON.parse(r.body.state); return Object.hasOwn(st, 'aiSeq') ? 'jev:ai_function' : 'jev:local_function'; }
  return 'jev:' + keys.slice(0, 3).join('+');
}
type Row = { i: number; kind: string; total: number; tokens: number; parts: string };
function describe(r: any): Row & { i: number } {
  if (r.provider === 'luna') {
    const msgs: any[] = r.body.messages;
    const sizes = msgs.map(m => ({ role: m.role, n: text(m.content).length }));
    const total = sizes.reduce((a, b) => a + b.n, 0);
    const tokens = est(msgs.map(m => text(m.content)).join(''));
    const parts = sizes.map(s => s.role[0] + s.n).join(' ');
    return { i: 0, kind: kindOf(r), total, tokens, parts };
  }
  const q = r.body.questions as Record<string, { instructions: string; criteria: Record<string, string> }>;
  const stateN = r.body.state.length;
  const qs = Object.entries(q).map(([k, v]) => ({ k, ins: v.instructions.length, crit: JSON.stringify(v.criteria).length }));
  const total = stateN + qs.reduce((a, b) => a + b.ins + b.crit, 0);
  const tokens = est(r.body.state + Object.values(q).map(v => v.instructions + JSON.stringify(v.criteria)).join(''));
  const parts = `state${stateN} ` + qs.map(x => `${x.k}:i${x.ins}/c${x.crit}`).join(' ');
  return { i: 0, kind: kindOf(r), total, tokens, parts };
}

const lines: string[] = [];
const byKey = new Map<string, any[]>();
for (const d of data) { const k = `${d.figures}|${d.scene}`; byKey.set(k, [...(byKey.get(k) ?? []), d]); }
const parityReport: string[] = [];
for (const [key, pair] of byKey) {
  const [n, scene] = key.split('|');
  const a = pair.find(p => p.label === 'repair-first'), b = pair.find(p => p.label === 'bypass-enabled');
  if (!a || a.error) { lines.push(`### ${n}図形 / ${scene}: ERROR ${a?.error}`); continue; }
  lines.push(`### ${n}図形 / ${scene}（action=${a.action}、repair-first）`);
  lines.push('| # | 呼び出し | 合計字 | 概算tok | 内訳（system=s, user=u, assistant=a の字数／jevは state・質問の instructions(i)・criteria(c)） |');
  lines.push('|---|---|---:|---:|---|');
  a.requests.forEach((r: any, idx: number) => { const d = describe(r); lines.push(`| ${idx + 1} | ${d.kind} | ${d.total} | ${d.tokens} | ${d.parts} |`); });
  if (b && !b.error) {
    let first = -1;
    for (let i = 0; i < Math.min(a.requests.length, b.requests.length); i++) if (JSON.stringify(a.requests[i].body) !== JSON.stringify(b.requests[i].body)) { first = i; break; }
    parityReport.push(`${n}図形/${scene}: 要求数 ${a.requests.length}/${b.requests.length}、最初に差が出る要求 ${first < 0 ? 'なし（全件同一）' : '#' + (first + 1) + ' ' + kindOf(a.requests[first])}`);
  }
  lines.push('');
}
lines.push('## 両方略の要求の比較');
lines.push(...parityReport.map(s => '- ' + s));
writeFileSync(OUT, lines.join('\n'));
console.log(parityReport.join('\n'));
