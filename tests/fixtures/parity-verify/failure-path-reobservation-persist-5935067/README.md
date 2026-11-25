# Synthetic failure capture after the reobservation-persist fix (#141 c)

Source commit 593506790473d916dcb3caeb4b06386088f0c474 (validateJevPrivateStateV2 accepts the stage-one action set without request_observation after a turn's reobservation; offline adaptive-human synthetic Luna answers a targeted reobservation). Two independent captures were made on a clean tree with the generator (`node tests/support/generate-failure-fixture.ts <dir>`); they differ from each other only at 15 run-ID leaves.

Compared with the adopted failure-path-agree-names-a62eb00 capture, records differ only at 21 leaves: 15 run IDs, 5 instruction-source hash leaves (`v2/jev-turn.ts` in each of the 5 scenarios) and the derived `identity.prompts` digest. In the metadata only `baseCommit`, `fixtureSha256` and the `v2/jev-turn.ts` source hash change; all 71 source hashes were checked against the commit's files. Request payloads, behavior, schema, failure, clocks, policy, calls/sends and storage are unchanged. Existing 3 run-ID exclusions are unchanged. Metadata records the actual base commit instead of the generator's historical `3071720` literal.

Earlier fixture directories remain byte-identical. Only the current provenance target URL and its baseCommit literal move. No real API, Keychain, .env, study data or live run was used.
