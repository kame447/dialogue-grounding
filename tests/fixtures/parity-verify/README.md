# Frozen synthetic producer records

`producer-records.json` contains detached, unedited record bundles from the finalized
parity-live producer at `225122dbae9557933b1ccd62f4a74d3ac2a81b6e`.
`capture-metadata.json` records its source hashes and the fixture SHA-256.

- `known`: smoke plus both main labels, two human turns each, targeted observation,
  actual injected HTTP measurement, known nested `response.usage` tokens.
- `input_missing`: the same injected upstream leaves input usage absent; the native
  client/producer preserve null input plus known output, with unknown accounting.
- `both_missing`: the injected upstream leaves both usage sides absent; native
  nulls and separate unknown counts are retained.
- `explicit_retry`: the parent's complete mock capture with explicit output maximum,
  targeted observation and a simulated POST retry, from the same producer revision.

The first three were generated together in one local invocation using the producer's
existing synthetic `dependencies` / `instrumentedDependencies` helpers. Only the mock
upstream usage was varied. The native client, serializer, harness, ledger and record
writer were unchanged. The finalized producer files were temporarily copied unchanged
into this worktree for generation, verified against the committed source, then removed.
The fourth bundle was loaded from the parent's recorded run directory. Nothing in any
captured record was rewritten to fit verifier expectations.

All utterances and image material are synthetic. No real API, credential store,
participant data, semantic oracle or full test suite was used. Regression tests load
this JSON directly; they never import or run the producer. Small explicit event
timelines separately exercise stop obligations and cancellation scope.

These fixtures are provenance/schema examples, not proof of live model performance.
Canonical HTTP JSON hashes and image projections retain their separate domains;
unavailable original image bytes remain `not_reached` for independent recomputation.
