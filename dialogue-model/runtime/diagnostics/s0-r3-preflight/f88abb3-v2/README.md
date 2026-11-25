# S0 r3 dry preflight: main f88abb3, manifest v2

This is a new, dry-only diagnostic for baseline
`f88abb32736141ac7ad6dd2fee4740df3a019490`. It does not replace the old
`launch-draft.ts`, pins, digests, runbook, or checker. It cannot authorize or
start a live run. `--live` and `--live-approved` always return
`draft_live_unapproved` with exit status 2 before reading a manifest.

From the repository root:

```sh
node dialogue-model/runtime/diagnostics/s0-r3-preflight/f88abb3-v2/preflight.ts --check-draft
node dialogue-model/runtime/diagnostics/s0-r3-preflight/f88abb3-v2/preflight.ts --dry-mock
node --test tests/s0-r3-preflight.test.ts
```

The optional second argument is a mock manifest JSON file. It must pass the
existing v2 validator and have `approval: "pending"`. This candidate keeps the
existing seed 1701, caps and nine-trial order. Its timeouts are the engineering
candidate values from the S1 contract, for mock execution only. They are not
latency measurements or a final live selection.

`pins.json` records SHA-256 for all 184 runtime files tracked at the baseline.
The checker requires that baseline to be an ancestor of HEAD and verifies
every pinned file on disk. Descendant commits adding only this tooling can
pass; changed runtime bytes cannot. The report separately records baseline
HEAD, subject HEAD, pins digest, normalized manifest digest and profile digest.
The pins do not cover future files or the new diagnostic itself; the
delivery SHA-256 list for the latter is kept with the private research record.

The ordinary test suite compares the audited fixed subject record (HEAD plus
184 source digests) at a pure comparison boundary. It does not require the
evolving checkout to match f88abb3, or require historical Git objects in a
shallow CI clone. The CLI always verifies the actual checkout's disk bytes and
ancestry; changing a pinned source still rejects that checkout. The initial
reviewed delivery and the record of the correction and its focused verification
are kept with the private research record, not in this repository.

`--dry-mock` uses fixed synthetic Luna/Jev dependencies and the existing public
synthetic script catalog. It never reads environment credentials, Keychain,
private run paths or `.env`, and never delegates to the private launcher.
Temporary synthetic output/cache directories are removed on completion. The
focused suite disables global fetch and checks:

- Baseline source/profile/manifest consistency, rejection of the old baseline
  and modified source bytes.
- Duplicate Luna timeout, v3 and approved mock manifest rejection; live refusal.
- Accepted snapshot preservation and shared profile across both labels.
- Unknown Jev version rejection with a saved fixed error and known synthetic cost.
- The AI extraction deadline, abort propagation, no commit after failure, no
  following stage after timeout, and unchanged saved trial after a late reply.

The suite reuses the frozen S1/S2 contracts; it adds no semantic labels or
research success oracle. `wiring_passed` is a synthetic technical result, not
evidence of real model transport, measured HTTP billing, Japanese quality,
participant UI wiring or readiness for the real experiment.

When S4I v3 or other runtime changes enter main, generate a new version in a
new directory and review its pins/manifest. Preserve this f88abb3 v2 snapshot.
This diagnostic does not generate final live pins or replace the separate
start request, approval, live launcher and real-model verification.
