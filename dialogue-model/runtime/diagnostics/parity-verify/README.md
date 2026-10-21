# Independent offline parity verifier

Specification v1, fixed before inspecting run results. This tool reads record files only;
it never calls models, loads credentials, evaluates natural-language meaning, or imports
the parity-live implementation. Its conclusions concern recorded evidence, not the
authenticity or completeness of unrecorded network traffic.

Each check returns `pass`, `mismatch`, `not_comparable` (different upstream material),
or `not_reached` (required evidence absent). Missing evidence never counts as success.

## Fixed rules

- Reimplement canonical JSON (sorted object keys, ordered arrays) and SHA-256 locally.
  Only top-level record metadata keys `label`, `runId`, `timestamp`, `timestamps`,
  `startedAt`, `finishedAt`, `createdAt` may be omitted when comparing replay envelopes.
  Nested model payload keys, instructions, dynamic questions, criteria, token limits,
  model IDs, and every other setting remain significant. Profile hashing excludes only
  its top-level `label`. Compare actual frozen upstream materials before pre-wire
  payloads; an upstream difference is not a label-derived mismatch.
- Compare effective profile hashes, memo hashes, cache keys and immutable cache-file
  snapshots across labels. Recompute hashes wherever raw values are recorded. Trial
  cache reads must be HIT with zero initial-observation POSTs. Warm-up must be MISS,
  one observation complete and one to three POSTs, with a validated memo and matching
  response model. Targeted reobservation is separate.
- Recompute reservations, actual HTTP sends and complete entries independently.
  Jev HTTP <=208, Luna complete <=131, Luna POST <=393; policy GET is separate.
  Reservations precede sends and cover them; retries do not become complete entries.
  Unknown Jev cost stops the whole run; unknown Luna input/output usage remains
  unknown, never zero. Recompute known totals plus unknown counts. Jev instance
  spending follows its existing USD .05 rule (including the previous observed maximum
  cost prediction); USD 2 and known Luna tokens 1,500,000 are stopping thresholds,
  not guaranteed spending caps. No new sends or state commits after stop; list all
  already-sent calls still in flight at stop, including late usage updates.
- G1: validated warm-up and trial cache invariants above. G2: at least one stage-one
  human turn has both referent and decision sent, received, model-matched, and validated,
  plus a committed public utterance; images only in observation. Any stage-one primary
  error blocks progression, including failures in conditional paths. G3: persisted
  public/trace/snapshot records, external private file permissions, manifest/profile,
  model and usage records. G4: public leakage checks and no unknown Jev billing;
  budget consistency and stop discipline are additional independent checks. Compare claimed
  gates with these recomputations; do not use claimed gate booleans as evidence.
- Coverage requires each path's actual execution, validation, commit and subsequent
  application evidence. AI partial application is candidate-level `partial_demonstrated`;
  approved conservative rejection needs contract evidence, not a reason string alone.
  No opportunity/unselected = `not_observed`; final pending or missing next repair turn
  = `not_reached`; primary failure/contract violation = `wiring_failed` even with a failed
  pending present. Repair progress must have a recorded next-turn update (unknown is
  allowed). Human-link acceptance proves wiring only. Public name agreement and ledger
  agreement remain separate evidence; the verifier does not infer public agreement.

Synthetic negative tests must change one item at a time and detect the corruption.
No live results or semantic judgments are used to choose the rules.

## Usage and record support

```sh
node dialogue-model/runtime/diagnostics/parity-verify/index.ts /private/path/to/run
node --test tests/parity-verify.test.ts
```

The CLI emits a JSON report. Exit 0 means all checks passed, 2 means a mismatch or
invalid input, and 3 means unresolved/not-comparable evidence without a mismatch.
The importable APIs are `loadRecords`, `verifyRecords`, and `verifyDirectory` in
`index.ts`. They have no network, runtime-pipeline, credential or harness dependencies.

The loader reads only `run.private.json`, `summary.private.json`, `warmup.private.json`,
`trial-N.private.json`, `public-N-S.packet.json`, `billing.private.jsonl`, and the optional
`verifier-evidence.private.json` described in [evidence-schema.md](evidence-schema.md).
It reads no paths embedded in those files, rejects symlinks/oversized files, and checks
actual record permissions/external location. The report contains check IDs, closed
reason codes, hashes/counts, and technical classifications, never prompt/response text.

Native v1 records retain useful profile, call, usage, trace, graph and packet evidence.
Their one-sided replay hash list plus `labelsEqual`, gate `passed`, and `cacheStable`
are not independent proof. Without additional evidence the corresponding checks stay
`not_reached`. A cache read never attempted due to setup failure uses `not_attempted`
and remains `not_reached`, per parent decision 8021; fabricated HIT/validation is rejected.

Gates use the smoke trial's own budget snapshot and evidence: later main-trial failures
do not retroactively alter the smoke result. Whole-run checks still expose those failures.
In-flight reporting preserves consumption known at stop and separately shows later
obtained billing. Count caps apply before each send; observed spending/token thresholds
can be exceeded by calls already sent. Policy GETs never consume POST generation counts.

`live_demonstrated` is a technical path class; every cell separately says `live` or
`mock_only`. Naming semantics remain `not_reached` for blind review. Conservative rejection
is certified only for independently provable prior pruning or public-window exclusion;
other rejection contracts without sufficient raw evidence remain `not_reached`.
Leak checks cover lexical credential/image/internal-ID patterns and recorded prompt-line
echoes, not general semantic information disclosure. Luna messages-only replay proves
the recorded complete-call boundary; it does not claim actual HTTP-byte identity.
