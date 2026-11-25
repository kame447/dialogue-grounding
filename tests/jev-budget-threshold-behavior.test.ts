// The research Jev budget stops the run the same way at any threshold: the response that reaches the limit halts the ledger, the next send is refused before it
// leaves (budget_stop), and the decision client reports that refusal as network_error. Raising the ceiling changes only where this happens. Offline; no model call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { participantLedgerFetch } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';

const jevBody = JSON.stringify({ questions: { action: { criteria: {} } } });
const post = (fetchImpl: typeof fetch) => fetchImpl('https://offline.invalid/v1', { method: 'POST', body: jevBody });

for (const jevUsd of [0.05, 0.15, 0.45]) {
  test(`jevUsd ${jevUsd}: the response that reaches the limit halts the ledger and the next send is refused before it leaves`, async () => {
    const ledger = new RunBudget({ lunaCalls: 100, lunaTokens: 1e9, lunaPosts: 100, jevPosts: 10000, jevUsd });
    let sent = 0;
    const each = jevUsd / 4 + 1e-6; // the fourth response reaches the limit
    const fetchImpl = participantLedgerFetch(ledger, 'jev', 'gpt-6-luna', (async () => { sent++;
      return Response.json({ model: 'typesafe/jev-1.14-20261014', usage: { cost: each }, answers: {} }); }) as typeof fetch);
    for (let i = 0; i < 3; i++) await post(fetchImpl);
    assert.equal(ledger.halted, false, 'below the limit nothing halts');
    await post(fetchImpl);
    assert.equal(ledger.halted, true);
    assert.equal(ledger.haltReason, 'observed_jev_budget');
    await assert.rejects(post(fetchImpl), { message: 'budget_stop' });
    assert.equal(sent, 4, 'the refused send never reached the upstream');
    assert.equal(ledger.snapshot().jevPosts, 4);
    assert.deepEqual(ledger.snapshot().refusals.map((r: any) => [r.kind, r.reason]), [['call', 'budget_stop']]);
  });
}
