import { readFileSync, writeFileSync } from 'node:fs';
const OUT = process.env.OUT!;
const sets: [string, string][] = [['A: main 75c66cc（同形式の静的メモで代用）', 'inv-main'], ['B: 4e09b62 移植後（parts つき）', 'inv-merged'], ['C: 新しい版・典型の組', 'inv-rot-typical'], ['D: 新しい版・最悪の組', 'inv-rot-worst']];
const text = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p?.type === 'text' ? p.text : '').join('') : '';
const est = (s: string) => { let cjk = 0; for (const ch of s) if (ch.charCodeAt(0) > 0x7f) cjk++; return Math.round(cjk + (s.length - cjk) / 3.5); };
const rows: string[] = [];
const kinds = ['local_extraction', 'jev:human_referent', 'jev:action', 'jev:target', 'generation', 'ai_extraction', 'observation_targeted'] as const;
function measure(r: any, kind: string) {
  if (kind.startsWith('jev:')) {
    const q = r.body.questions, key = kind.slice(4), qq = q[key]; if (!qq) return null;
    const stateN = r.body.state.length, ins = qq.instructions.length, crit = JSON.stringify(qq.criteria).length;
    return { chars: stateN + ins + crit, tokens: est(r.body.state + qq.instructions + JSON.stringify(qq.criteria)), detail: `state ${stateN} / 指示 ${ins} / 基準 ${crit}` };
  }
  const msgs: any[] = r.body.messages; const total = msgs.reduce((a, m) => a + text(m.content).length, 0);
  const big = Math.max(...msgs.map(m => text(m.content).length));
  return { chars: total, tokens: est(msgs.map(m => text(m.content)).join('')), detail: `最大メッセージ ${big}` };
}
for (const [label, file] of sets) {
  let data: any[]; try { data = JSON.parse(readFileSync(`/private/tmp/claude-502/-Users-Shogo--agentstack-worktrees-HappySomerville/e7f6ea23-5a8f-4e4d-a62e-3dd66e83a0c9/scratchpad/out/${file}.json`, 'utf8')); } catch { continue; }
  rows.push(`\n#### ${label}`);
  rows.push('| 図形数 | 呼び出し | 合計字 | 概算tok | 内訳 |'); rows.push('|---:|---|---:|---:|---|');
  for (const n of [3, 4, 6]) {
    for (const [scene, ks] of [['s1_whole_question', kinds.slice(0, 6)], ['s2_feature_confirm_reobserve', ['observation_targeted']]] as const) {
      const d = data.find(x => x.figures === n && x.scene === scene && x.label === 'repair-first'); if (!d || d.error) continue;
      for (const k of ks) {
        const r = d.requests.find((q: any) => q.provider === (k.startsWith('jev:') ? 'jev' : 'luna') && (k.startsWith('jev:') ? !!q.body.questions[k.slice(4)] : q.phase === k)); if (!r) continue;
        const m = measure(r, k); if (m) rows.push(`| ${n} | ${k} | ${m.chars} | ${m.tokens} | ${m.detail} |`);
      }
    }
  }
}
writeFileSync(OUT, rows.join('\n'));
console.log(rows.join('\n').split('\n').filter(l => /^\| 6 /.test(l) || /^####/.test(l)).join('\n'));
