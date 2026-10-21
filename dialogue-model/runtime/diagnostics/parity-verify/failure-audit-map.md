# Failure-path audit map

Fixed contract: REQUEST-16R C1–C7, REQUEST-16R2 R16R-1–3,
PREAPPROVAL-16R2, and parent Mail 8102/8105. The implementation and contract tests
were fixed before receiving new producer captures. All test names below are in
`tests/parity-verify-failure.test.ts` unless another file is stated. C7 connection
tests are in `tests/parity-verify-producer-failure.test.ts`. Tests are
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
| Failure wrapper coexists with actual cache/stage/gate violation | Integrity checks may pass; actual `failure.cache`, `cache.immutable.*`, `gate.G1` still mismatch; G2 preserves valid turn evidence while primary execution guards remain independent | `real cache invariant violation survives a well-formed failure wrapper`; `PREAPPROVAL-16R2: failure integrity never masks actual cache or stage gate failures`; `saved cache receipt with missing warmup file is missing proof, while memo corruption remains a mismatch` |

## R16R-1–3 and the two audit interpretations

| Item | Check / evidence | Regression or remaining integration |
| --- | --- | --- |
| R16R-1: retain started trial and its calls after finalization failure | `records.ownership`, `ledger.total.lunaCalls`, `ledger.send_ownership`; after_warmup owns no copies | `after_warmup cannot re-own calls; scope requires the actual warmup file`; `C7 trial cache-read failure preserves native receipts without double accounting or certifying G1` |
| R16R-1: save failure remains missing output; do not move started fact to skipped | `records.trial_file.<order>`, `records.planned_mapping` not_reached; `summary.runOrder` remains evidence of start | `PREAPPROVAL-16R2: physical field deletion and physical file loss have distinct outcomes`; `C7 failed trial save keeps started fact and G3 failure, with output_missing rather than invented native calls` |
| PREAPPROVAL interpretation 1: no fictitious ledger/ownership mismatch is different from execution/gate success | Integrity `failure.schema`, `records.ownership` can pass while `cache.immutable.0`, `gate.G1` mismatch. G2 pass is compatible with independently rejected execution/progression | `PREAPPROVAL-16R2: failure integrity never masks actual cache or stage gate failures` (one G2 expectation change approved in Astra 8162 / parent 8164) |
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
| 8105 late usage for sent work, same send ID, no extra send or double counting; unknown at stop stays visible | `ledger.response_snapshot.*`, `ledger.event.*.response_ownership`, `ledger.event_reconciliation`, `ledger.stop_discipline`; latest usage and at-stop consumption in report | `8105: post-close usage revises the same Luna send and preserves unknown consumption at stop`; `8105: late usage with another send ID is rejected instead of becoming a new send`. Existing PV-4 late-billing/stop-obligation cases (`tests/parity-verify.test.ts`) still run unchanged. These verify record accounting; actual late producer delivery requires separate producer evidence. |

## Read-only legacy application and C7 connection

The original failed run was loaded read-only with the failure-path implementation
at 12a1597; its file contents, mode and size were
compared before/after without exporting their digests. The private report contains
only status counts and grouped check IDs: pass 58, mismatch 0, not_comparable 0,
not_reached 20. `ledger.total.lunaCalls` and `ledger.send_ownership` pass;
`ledger.event_reconciliation` is not_reached. The known call remains counted, and
HTTP/policy/deadlines each retain legacy_unrecorded. Parent copied the 0600 report
to the requested private destination. No actual run values enter repository tests.

The C7 suite consumes the five actual synthetic producer-output scenarios from the
parent's finalized fixture, read-only, by case names and record structure. It imports
no producer/generator code and does not pin fixture digests. Default fixture location
is `tests/fixtures/parity-verify/failure-path/producer-records.json`;
`PARITY_FAILURE_FIXTURE` accepts a read-only path before parent integration.

| Capture | Connection checks |
| --- | --- |
| observation_timeout | No mismatch; one measured POST/complete; unknown token fields remain unknown; cache_get started; outer/complete deadline records; all smoke gates not_reached |
| policy_get_failed | No mismatch; one policy GET, zero complete/POST; policy failed/null; outer timeout null, no complete deadline |
| post_cache | Exactly the actual missing-POST `ledger.complete_post` mismatch; schema/ownership/billing and native event reconciliation remain coherent |
| cache_read_failed | Saved started trial retains native Luna/Jev calls and POSTs; mismatch count zero; G2 and gate.claim.G2 pass from committed-turn evidence; G1 cannot pass without its missing per-trial receipt; overall passed stays false and no main starts |
| cache_read_and_save_failed | Saved failure/snapshot retain started fact and failed saving/G3; absent trial produces output_missing/not_reached, with no guessed duplicate ownership or fabricated calls |

**Astra RULING-C7-G2 (parent 8157, expectation approval 8164):** G2 is committed-turn
evidence. The implementation preserves in-turn failure checks and keeps the broader
primaryFailure for separate execution/progression checks. No code-name exception is
used. `gate.claim.execution` (reason overall_passed_requires_no_primary_execution_failure)
rejects false overall claims; `gate.primary_error_progression` (reason
main_started_after_primary_execution_failure) rejects main after an earlier primary
failure. Both derive directly from failure/call/attempt/stage facts, not G1–G4.

| Ruling regression | Test in parity-verify-producer-failure.test.ts |
| --- | --- |
| Unmodified producer capture: G2/claim pass, overall false, execution failure retained, no main | `C7 trial cache-read failure preserves native receipts without double accounting or certifying G1` |
| Only overall passed changed to true, failure unchanged | `G2 ruling: failure plus only trial overall passed=true is a contradiction`; summary variant |
| Main starts after the primary failure | `G2 ruling: main begun after a recorded primary error violates independent progression` |
| Same code before any valid turn | `G2 ruling: a cache_read_failed code before any valid turn cannot certify G2` |
| In-turn failure boundary retained | `G2 ruling retains in-turn … failures` (call, attempt, stage, image); existing raw validation tests run unchanged |

TDD evidence: before implementation, `PARITY_FAILURE_FIXTURE=<read-only capture path>
node --test tests/parity-verify-producer-failure.test.ts` against verifier 12a1597
gave 19 tests, 15 pass / 4 fail. Failures: the unmodified cache-read capture, both
overall-passed corruptions, and primary-error-before-main progression. The no-valid-turn
case and in-turn failures already held. RED log: `/private/tmp/sol3-c7-g2-red.log`.
After implementation and the single pre-approved existing expectation change, the
three focused verifier files gave 173/173 pass. GREEN log:
`/private/tmp/sol3-c7-g2-green.log`; strict typecheck passed.

C7 does not certify actual late producer delivery or timer operation; late-usage
accounting remains covered by the independent contract tests.

## POSTAUDIT-22: strict types, policy consistency and saved gate contradictions

Regression file: `tests/parity-verify-schema-audit.test.ts`. Existing tests, producer
code and fixtures are unchanged. Enum membership now requires an actual string;
there is no coercion, trimming, case conversion or recursive normalization.

| Item | Check / fixed boundary | Regression family |
| --- | --- | --- |
| R121-1 strict enums, including nested legacy records | `failure.schema` mismatch / schema_violation; normal strings retained | `R121-1 …: genuine string remains valid`; `R121-1 …: rejects … without coercion` (both stages, HTTP outcome/kind/method, call provider/status, cache status/reason/observation, policy.status, nested legacy call/cache) |
| R121-1 other scalar boundaries | Booleans and integers cannot be strings, arrays, objects, null or the wrong numeric kind | `R121-1 …: boolean rejects …`; `R121-1 …: integer rejects …` |
| R121-2 obtained policy | `failure.policy` mismatch / obtained_policy_matches_contract_and_requested_model; purpose dialogue_turn, ready true, provider openai/gemini, existing model syntax/length, match every recorded warmup Luna requestedModel | `R121-2 obtained policy rejects … independently of JSON types`; `R121-2 obtained policy rejects malformed model …` |
| R121-2 known state contradiction | `failure.policy` mismatch / policy_required_before_observation when cache_get/post_cache or complete-start evidence coexists with failed/not_requested policy | `R121-2 cache_get before complete still requires obtained policy`; `R121-2 observed complete requires policy even when the stage is unknown` |
| R121-2 normal failures and model choice | No model ID pinned; policy GET/client setup failures remain unresolved, legacy policy remains legacy_unrecorded | `R121-2 policy follows recorded requested model instead of pinning a research model ID`; existing-provider cases; `R121-2 genuine policy GET failure, client setup and legacy stay distinct` |
| R121-3 known contradiction inside a saved snapshot | `gate.claim.snapshot` mismatch / overall_passed_contradicts_component_gate; independent of trial-file presence and execution claims | `R121-3 missing trial cannot hide a summary overall/component contradiction`; trial-snapshot variant; known-false/other-missing variant |
| R121-3 missing evidence and temporal scope | Missing components without a known contradiction are not_reached; absent trial remains output_missing; later failure cannot invalidate an earlier good snapshot | `R121-3 unchanged save-failure capture keeps missing output and zero mismatches`; `R121-3 unknown components are not guessed false`; `R121-3 later failure does not invalidate an earlier good smoke snapshot or G4` |

Policy vocabulary comes from the existing native getModelPolicy contract
(`dialogue-model/runtime/client.mjs`); model syntax/maximum length comes from the
existing Worker model-policy contract (`workers/research-ai-proxy/src/modelPolicy.mjs`).
The verifier reimplements these validations and imports neither implementation.
It compares the recorded model to recorded requests, never a new research model ID.

TDD RED: `node --test tests/parity-verify-schema-audit.test.ts` against 6eb2d7b,
156 tests, 127 pass / 29 fail (13 strict-enum coercions, 11 policy checks, 5 snapshot
checks). Log: `/private/tmp/sol3-r121-red.log`. After the minimum implementation,
the same 156 tests pass; log: `/private/tmp/sol3-r121-green-focused.log`.
All four focused verifier files then pass 329/329, including the unchanged 173
existing regressions; log: `/private/tmp/sol3-r121-green.log`. Strict typecheck passes.
