# Sol3 independent verifier evidence v1

Write one `verifier-evidence.private.json` beside run.private.json, summary.private.json,
warmup.private.json and trial-N.private.json. Private, 0600, no secrets/authorization
headers/image base64. Synthetic own-image bytes may be represented by their byte SHA
at the replay boundary; record that projection explicitly, identically for both labels.
This is additional evidence, not permission for live execution or semantic scoring.

```ts
type Evidence = {
  version: 1;
  runId: string; // exact run.private.json runId
  pairedReplay: ReplayPair[];
  events: LedgerEvent[];
  cache: CacheReceipt[];
};
type ReplayPair = {
  trialOrder: number;
  turn: number; // human event seq; bind to trial.replay tape's final event
  left: ReplaySide;
  right: ReplaySide;
};
type ReplaySide = {
  label: 'repair-first' | 'bypass-enabled';
  material: unknown; // full identical frozen replay inputs: state/events/model/profile
  materialSha256: string;
  requests: Array<{
    provider: 'luna' | 'jev'; phase: string;
    payloadDomain: 'canonical_http_json';
    payload: unknown; // entire parsed HTTP body AFTER the sole image projection
    payloadSha256: string; // canonical projected body; independently recomputed
    preProjectionPayloadSha256: string; // canonical original full HTTP body
    completeMessagesSha256?: string; // Luna messages BEFORE projection; diagnostic
  }>;
};
type LedgerEvent = {
  seq: number; // strictly increasing run-global integer; authoritative order
  at: string; // ISO-8601 UTC, nondecreasing; never used to reorder seq
  type: 'complete' | 'reserve' | 'send' | 'response' | 'stop' | 'commit' | 'policy_get' | 'refused';
  provider?: 'luna' | 'jev';
  instanceId?: string; // stable unique ID for EACH native Jev adapter/classifier/
                      // aiPublic transport instance or Luna client; no reuse across trials
  trialOrder?: number | null; // null = warm-up
  label?: 'repair-first' | 'bypass-enabled' | 'warmup';
  callId?: number; // logical complete/adapter-call ID, existing CallReceipt.id
  sendId?: number; // unique run-global HTTP ID, existing SendReceipt.id
  phase?: string;
  status?: 'ok' | 'error' | 'unknown' | 'refused';
  costUsd?: number | null; // response: Jev cost or null; null is unknown, NEVER 0
  inputTokens?: number | null; outputTokens?: number | null; // response: Luna fields
  requestedModel?: string; model?: string | null;
  reason?: string;
  inFlight?: number[]; // stop: ALL sent but not yet completed send IDs, including unknown
  scope?: 'run' | 'trial' | 'instance';
  scopeDetail?: 'logical_call'; // instance + call identity, not instance lifetime
};
type CacheReceipt = {
  trialOrder: number | null; // null = warm-up
  status: 'MISS' | 'HIT';
  beforeSha256: string | null; // null ONLY if warm-up file absent
  afterSha256: string;
  memo: unknown; // detached INITIAL memo at read, before any targeted reobservation
  memoSha256: string;
  validated: boolean; // native observation/cache schema/model validation completed
  requestedModel: string; returnedModel: string;
} | {
  trialOrder: number;
  status: 'not_attempted';
  reason: string; // closed setup_failed:<stage>; no memo/hash/validated fields
};
```

Canonical JSON: finite JSON primitives, object keys lexicographically sorted at every
depth, array order preserved, compact JSON strings/numbers. SHA-256 is lowercase hex
of UTF-8 canonical JSON, or literal file bytes for cache-file hashes. No native hashing,
normalization or ledger helper will be imported by Sol3.

Normalization is PRE-LISTED: top-level replay envelope `label`, `runId`, `timestamp`,
`timestamps`, `startedAt`, `finishedAt`, `createdAt` only. The `requests[].payload` and
`material` subtrees are compared in full; even keys named label/timestamp INSIDE a
model payload remain significant. Profile hashes exclude only top-level profile.label.
Do not silently expand this list to match live results.

Replay request order is significant. Capture EACH label's request independently at
the same send boundary, after effective settings/dynamic questions/criteria/instructions
are assembled. Include model/output limit/timeout effective context in material; do
not derive one label from the other. Existing taped request hashes remain separately
checked, but one list plus labelsEqual is insufficient for independent parity proof.
The required boundary for BOTH providers is full canonical HTTP JSON, not raw-body-byte
parity. `material.boundary` is `{luna:'canonical_http_json', jev:'canonical_http_json',
hashScheme:'canonical_json_sha256_not_raw_body_bytes'}`. `material.state/events/profile`
bind directly to the native tape/trial; optional frozen luna/jev/reobservations bind too.
Messages-only legacy evidence cannot establish the approved full HTTP parity check.

Hash domains are separate. `payloadSha256` recomputes the full projected HTTP object;
`preProjectionPayloadSha256` binds to tape.expectedRequests[].requestSha256. If no
projection occurs it is also independently recomputed. Where original image bytes
are absent, the pre-projection recomputation is not_reached: matching self-reported
hashes alone is not full proof. The only permitted projection is an own-image data URL
at messages[i].content[j].image_url.url to exactly `{projection:'own_image_bytes_sha256',
mimeType,byteSha256}`, matching material.own.ownImage. No other subtree is projected.
Compare both complete projected payload/material trees; do not remove body fields.

Luna's body keys are exactly purpose/messages and, only for an explicit request,
max_completion_tokens. purpose is dialogue_turn and explicit maximum equals the profile.
Tape Luna entries additionally carry messagesSha256, actualSendMeasured and sendIds.
HttpReceipt callId/sendId/requestSha256/hashScheme bind EACH actual POST/retry to the
canonical original HTTP object. CallReceipt.requestSha256 remains the legacy messages
diagnostic; expectedHttpRequestSha256/httpRequestSha256 are full HTTP hashes. Each
complete response's token fields are at response.usage.inputTokens/outputTokens.

Events: `complete` means Luna complete entry (not retries); `reserve` occurs atomically
before each allowed POST attempt; `send` immediately precedes actual fetch invocation;
`response` records received billing, including known-cost schema failures. Append later
response revisions for previously unknown billing using the SAME sendId. Never sum
revisions twice. `policy_get` is outside POST/complete budgets. `refused` is not a send.
All provider events carry provider/instanceId/trialOrder/label/callId/phase; reserve,
send,response carry sendId; response carries provider-specific cost/usage fields and
model/requestedModel. `stop` carries reason and inFlight; `commit` carries trialOrder.
Emit stops immediately, including timeout/phase abort and Jev unknown/instance cap;
no new sends/commits after run stop. If a stop is only trial/instance scoped, add
`scope: 'run' | 'trial' | 'instance'` (default run) and the matching identity fields.
Late response revisions are allowed, new sends are not. Record Jev per-instance prior
observed maximum alongside costs implicitly derivable from response order: .05 rule
checks spent + prior maximum before next send; not a strict final spending guarantee.
An actually-sent Jev call aborted/timed out while billing is unresolved creates a RUN
stop obligation immediately, even if a producer labels its event logical-call/instance
scoped. A missing or too-narrow stop is a mismatch. Pre-send refusals and cleanup of
already-billed calls do not create that unknown-charge obligation. Known run USD/token
thresholds apply to commits as well as sends. Later cost backfill never removes a past
stop obligation. Luna logical-call abort alone does not terminate its client's lifetime.
Parent decision 8054: the descriptive logical-call/instance abort and same-send
unknown/response/stop bookkeeping may occur contiguously before the required run-scope
stop. No reserve, complete, send, commit, policy GET or unrelated bookkeeping may
intervene. Record the run stop even when late billing becomes known before it;
only a narrower stop or no run stop is a mismatch, and backfill never cancels the duty.

Public packets contain only prefix/sha256; prefix elements contain only speaker/turn/text.
The verifier checks increasing unique turns, filename trial/checkpoint, absence of future
turns, and exact agreement with recorded public events/committed speech through that
checkpoint. Contradictions mismatch; insufficient public source evidence is not_reached.

Cache: include warm-up and every entered trial, bind trialOrder to trial-N.private.json.
Every trial before==after==warm after, cache HIT, memo SHA identical. Warm-up must MISS,
complete count 1, POST count 1..3, validated=true, exact returned/requested model match.
Receipt alone is not evidence of actual POST count: reconcile ledger plus call/http records.
Parent decision 8021: a trial failing during setup before cached.get records
status=not_attempted with setup_failed:<stage>, no invented HIT/memo/validated flag.
Its cache checks are not_reached; the trial remains failed/not_reached.

Coverage remains computed from native trace/state. An approved conservative rejection
requires independent contract evidence; reason strings or harness coverage results
alone cannot prove it. Public naming agreement stays independent blind-review pending.
