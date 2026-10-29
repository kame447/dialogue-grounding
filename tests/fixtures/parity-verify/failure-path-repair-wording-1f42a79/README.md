# Synthetic failure capture after the technical-trial repair wording change (#141 b)

Source commit 1f42a793deee6ffee8df6d7510ee2b8b8e2ece97 (technical-trial Jev path only: the shared self-correction sentence and the repair scope now state a mix-up only when public speech grounds it). Two independent captures were made on a clean tree with the generator (`node tests/support/generate-failure-fixture.ts <dir>`); they differ from each other only at 15 run-ID leaves.

Compared with the adopted failure-path-reobservation-persist-5935067 capture, records differ only at 21 leaves: 15 run IDs, 5 instruction-source hash leaves (`v2/dialogue-v2.mjs` in each of the 5 scenarios) and the derived `identity.prompts` digest. In the metadata only `baseCommit`, `fixtureSha256` and the `v2/dialogue-v2.mjs` source hash change; all 71 source hashes were checked against the commit's files. These scenarios run without technicalTrial, so request payloads, behavior, schema, failure, clocks, policy, calls/sends and storage are unchanged. Existing 3 run-ID exclusions are unchanged. Metadata records the actual base commit instead of the generator's historical `3071720` literal.

Earlier fixture directories remain byte-identical. Only the current provenance target URL and its baseCommit literal move. No real API, Keychain, .env, study data or live run was used.
