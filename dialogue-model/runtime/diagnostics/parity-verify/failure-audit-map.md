# Failure-path audit map

Fixed contract: REQUEST-16R C1–C7, REQUEST-16R2 R16R-1–3,
PREAPPROVAL-16R2, and parent Mail 8102/8105. The implementation and contract tests
were fixed before receiving new producer captures. All test names below are in
`tests/parity-verify-failure.test.ts` unless another file is stated. Tests are
synthetic and offline. They certify verifier behavior, not producer persistence or
actual timing. Existing producer fixtures and test expectations remain unchanged.

## C6: every input mapping

| Contract input | Check ID / result | Regression name |
| --- | --- | --- |
| Failure file absent | No `failure.*` checks; existing verification continues | `C6: absent failure file adds no failure-scope checks`; existing `fixed producer fixture connects nested usage, native full HTTP bodies, images and gates` (`tests/parity-verify.test.ts`) |
| Exact legacy `{code,calls,cache}` | `failure.schema` pass; `ledger.total.lunaCalls` counts known calls; `failure.http`, `.policy`, `.deadlines` not_reached / legacy_unrecorded | `legacy fixed synthetic shape retains its one known complete; unrecorded HTTP is unknown`; `loader reads failure.private.json independently, with no warmup or trials` |
| Neither legacy nor v1 shape | `failure.schema` mismatch / schema_violation | `partial new records cannot fall back to legacy acceptance`; `failure top-level wrong type … is schema_violation` |
| Missing required key, wrong type, unknown key | `failure.schema` mismatch / schema_violation | `closed failure schema rejects …` (missing http/call field, wrong cache type, unknown top/policy/receipt/configured key, wrong call ID type, unknown stage/version) |
| measured:false with records; policy status/value conflict | `failure.schema` mismatch / schema_violation | `closed failure schema rejects false measured with records`; `closed failure schema rejects failed policy with value` |
| Scope contradicts warmup-file presence | `failure.scope` mismatch / scope_contradiction | `after_warmup cannot re-own calls; scope requires the actual warmup file`; `warmup scope plus warmup file exposes scope and duplicate ownership` |
| Cross-file call/send ownership | `records.ownership` mismatch / duplicate_ownership; no silent dedup | `cross-file … ID ownership never silently deduplicates`; `PREAPPROVAL-16R2: missing trial output cannot hide known … duplication` |
| Calls/receipts contradict billing/evidence | `ledger.call.*`, `ledger.total.*`, `ledger.event_reconciliation`, `failure.http_binding.*`, `replay.http_receipts` mismatch for known contradictions | `warmup HTTP hash contradictions survive an otherwise valid failure schema`; `legacy missing HTTP cannot erase known complete-event count contradictions`; `missing output cannot hide recorded billing or stop contradictions` |
| Required output not saved | `records.trial_file.<order>`, `records.planned_mapping`, unresolved ledger/replay checks not_reached / output_missing | `missing trial output preserves started facts and reports output_missing, not guessed mapping failure`; `missing mapping source fields remain output_missing, while known duplicates still mismatch`; `PREAPPROVAL-16R2: physical field deletion and physical file loss have distinct outcomes` |
| Existing new-format row lacks plannedIndex; duplicate/missing mapping | `records.planned_mapping` mismatch / planned_mapping | `new mapping requires one owner for every planned index`; `duplicate planned index and started-plus-skipped both mismatch`; `missing skipped plannedIndex is malformed even alongside missing output` |
| Failure wrapper coexists with actual cache/stage/gate violation | Integrity checks may pass; actual `failure.cache`, `cache.immutable.*`, `gate.G1/G2` still mismatch | `real cache invariant violation survives a well-formed failure wrapper`; `PREAPPROVAL-16R2: failure integrity never masks actual cache or stage gate failures`; `saved cache receipt with missing warmup file is missing proof, while memo corruption remains a mismatch` |

## R16R-1–3 and the two audit interpretations

| Item | Check / evidence | Regression or remaining integration |
| --- | --- | --- |
| R16R-1: retain started trial and its calls after finalization failure | `records.ownership`, `ledger.total.lunaCalls`, `ledger.send_ownership`; after_warmup owns no copies | `after_warmup cannot re-own calls; scope requires the actual warmup file`; actual producer cache-read-failure capture remains **C7 pending** |
| R16R-1: save failure remains missing output; do not move started fact to skipped | `records.trial_file.<order>`, `records.planned_mapping` not_reached; `summary.runOrder` remains evidence of start | `PREAPPROVAL-16R2: physical field deletion and physical file loss have distinct outcomes`; producer save-failure/G3 capture remains **C7 pending** |
| PREAPPROVAL interpretation 1: no fictitious ledger/ownership mismatch is different from execution/gate success | Integrity `failure.schema`, `records.ownership` can pass while `cache.immutable.0`, `gate.G1/G2` mismatch | `PREAPPROVAL-16R2: failure integrity never masks actual cache or stage gate failures` |
| PREAPPROVAL interpretation 2: missing field differs from missing file; known duplicates survive either | `records.planned_mapping` mismatch vs not_reached; `records.ownership` still mismatch for known duplicate IDs | `PREAPPROVAL-16R2: physical field deletion and physical file loss have distinct outcomes`; `PREAPPROVAL-16R2: missing trial output cannot hide known … duplication` |
| R16R-2: observationOuterMs is a specified observation timeout, not observed cache-wide cancellation or timer firing | `failure.schema`, `failure.deadlines`; exact meaning in evidence-schema.md | `8102: configured/applied deadlines are distinct, and an inconsistent configured value mismatches`; `closed failure schema rejects unapplied outer timeout after cache started` |
| R16R-3 marker=1 | `records.planned_mapping`: complete bijection or known mismatch | `new mapping requires one owner for every planned index`; `R16R-3: all planned skips map once; omitting a whole skipped row mismatches when no output is missing`; `R16R-3: invalid plannedIndex … is a mapping violation` |
| R16R-3 marker absent, no indices | not_reached / legacy_unrecorded; excess started count still mismatch | `unchanged … fixture has legacy mapping, unchanged existing assertions` (all four frozen scenarios); `known legacy excess trials contradict the plan without inferring indices` |
| R16R-3 marker absent, indices present | mismatch / version_contradiction | `missing marker plus plannedIndex is version_contradiction; unknown marker is unknown_version`; `R16R-3: a skipped-only plannedIndex also contradicts a missing marker` |
| R16R-3 marker other than numeric 1 | mismatch / unknown_version | `R16R-3: marker … is an unknown version` (0, 2, string 1, null, true) |

## Parent type clarifications 8102 / 8105

| Item | Check ID | Regression name |
| --- | --- | --- |
| 8102 exact 10 warmup keys / exact 4 after_warmup keys | `failure.schema` | Closed-schema cases; `after_warmup cannot re-own calls; scope requires the actual warmup file` |
| 8102 native CallReceipt/HttpReceipt fields, existing optional HTTP hashes only | `failure.schema`, `failure.http_binding.*` | Closed-schema field/type cases; `warmup HTTP hash contradictions survive an otherwise valid failure schema` |
| 8102 final outcomes returned/unknown; started forbidden | `failure.schema` | `8102: closed unknown POST outcome is valid; a started POST outcome is not`; `closed failure schema rejects started HTTP after close` |
| 8102 cache audit or null; no guessed cache contents | `failure.schema`, `failure.cache`, `cache.*` | `closed failure schema rejects wrong cache type`; `real cache invariant violation survives a well-formed failure wrapper` |
| 8102 fixed configured/applied deadline structure; nullable native/client/call options | `failure.schema`, `failure.deadlines` | `8102: client setup without measurement keeps HTTP unknown and deadlines unapplied`; `8102: configured/applied deadlines are distinct, and an inconsistent configured value mismatches`; multi-complete case includes null call option |
| 8105 completeCalls bijection (existing IDs alone insufficient) | `failure.schema` mismatch / schema_violation | `8105: duplicate existing complete ID cannot replace another complete with the same list length`; `8105: omitting one of two complete deadlines leaves a schema violation`; closed-schema wrong complete call ID case |
| 8105 late usage for sent work, same send ID, no extra send or double counting; unknown at stop stays visible | `ledger.response_snapshot.*`, `ledger.event.*.response_ownership`, `ledger.event_reconciliation`, `ledger.stop_discipline`; latest usage and at-stop consumption in report | `8105: post-close usage revises the same Luna send and preserves unknown consumption at stop`; `8105: late usage with another send ID is rejected instead of becoming a new send`. Existing PV-4 late-billing/stop-obligation cases (`tests/parity-verify.test.ts`) still run unchanged. Producer delivery after close remains **C7 pending** |

## Read-only legacy application and remaining C7

The original failed run was loaded read-only; its file contents, mode and size were
compared before/after without exporting their digests. The private report contains
only status counts and grouped check IDs: pass 58, mismatch 0, not_comparable 0,
not_reached 20. `ledger.total.lunaCalls` and `ledger.send_ownership` pass;
`ledger.event_reconciliation` is not_reached. The known call remains counted, and
HTTP/policy/deadlines each retain legacy_unrecorded. Parent copied the 0600 report
to the requested private destination. No actual run values enter repository tests.

**Remaining integration:** C7 new producer-generated captures for warmup timeout,
policy GET failure, post-cache wiring failure, after-warmup finalization/cache-read
failure, trial save failure, and late usage. Contract tests above do not substitute
for those captures and do not certify producer persistence or timer behavior.
