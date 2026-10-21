# Synthetic failure-path producer captures

Regenerate explicitly from the repository root with Node 24:

```sh
node tests/support/generate-failure-fixture.ts
node --test tests/parity-failure-fixture.test.ts
```

The optional generator argument chooses another output directory. CI reads the
frozen fixture and creates fresh captures only in temporary directories; it
does not rewrite this directory. `producer-records.json` contains parsed,
unmodified JSON/JSONL values from five actual `runParityLive` executions using
mock dependencies, native clients/serializers and instrumented mock fetch.
No verifier implementation participates in generation. This is mechanical
failure-path evidence, not a semantic oracle or authorization for a live run.

- `observation_timeout`: enter the native completion POST, then advance the
  observation deadline by 20000 ms. Preserve the unknown POST receipt and
  `cache_get` stage with `observationCallStarted: true`.
- `policy_get_failed`: inject HTTP 401 on policy GET. Preserve its receipt,
  `policy_get` stage, failed policy state and absent observation application.
- `post_cache`: measure GET but deliberately omit the completion POST. Preserve
  the real `cache_warmup_http_wiring` violation; do not hide it as missing data.
- `cache_read_failed`: after the first trial's Luna/Jev sends, remove the cache
  during AI extraction. Finalization preserves the started trial and receipts
  with `cache_read_failed`; the four-key after-warmup failure owns no calls.
- `cache_read_and_save_failed`: also create a 0700 directory at the trial-record
  path, making the atomic trial save fail. Keep the missing trial, failed saving
  and G3, and started fact in summary/evidence; never fabricate a trial file or
  move its planned index into skipped.

The Date clock starts at 1700000000000 and the monotonic clock at 0 for each
case. Only the timeout case advances them. This stabilizes durations, memo
timestamps and their derived hashes before the producer writes its records.
Random run UUIDs remain in the frozen records. Comparison excludes exactly
these three paths (`*` means a single scenario name):

```text
*/run/runId
*/summary/runId
*/evidence/runId
```

There is no recursive field-name normalization: timestamps in payloads,
call/send IDs, instance IDs, receipt ordering, hashes, materials, failure
codes, gates and planned indices remain significant. Two independent captures
must match each other and the frozen capture after those exact exclusions.

`capture-metadata.json` records the literal fixture SHA-256, case names,
comparison paths, clock settings and SHA-256 for the generator's local import
closure plus all producer instruction-source files. These hashes identify the
source snapshot used at capture time (producer base 3071720). They do not
claim that future source changes leave output unchanged. The source regression
fails with an explicit regeneration message whenever the current snapshot
differs; do not update hashes without regenerating producer records.

`storage` and `directories` contain actual lstat results before temporary
cleanup: regular records are 0600, private directories are 0700. The directory
at the deliberately failed trial path is identified as nonregular, with mode
0700. The aggregate fixture is written 0600 in a 0700 directory; Git does not
preserve these permission bits on checkout, so permission regression uses the
actual producer captures rather than assuming checkout modes are private.

All messages, credentials, transports and image material are synthetic. Images
are created in memory and only producer hashes/projections are retained.
Tests reject exact own-image base64, data-image URLs, long base64 strings and
authentication-like string values. Field names such as `inputTokens` remain
valid schema keys. No network, Keychain or private research input is used.
