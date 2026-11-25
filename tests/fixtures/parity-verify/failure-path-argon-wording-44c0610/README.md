# Synthetic failure capture after the Argon wording clarification (#141 b)

Source commit 44c0610946f295da8b893760e8ea2af48dcfc81b (technical-trial Jev path only: the two repair sentences now name the repair condition and the grounding in earlier utterances explicitly). Two independent captures were made on a clean tree with the generator (`node tests/support/generate-failure-fixture.ts <dir>`); they differ from each other only at 15 run-ID leaves.

Compared with the adopted failure-path-repair-wording-1f42a79 capture, records differ only at 21 leaves: 15 run IDs, 5 instruction-source hash leaves (`v2/dialogue-v2.mjs` in each of the 5 scenarios) and the derived `identity.prompts` digest. In the metadata only `baseCommit`, `fixtureSha256` and the `v2/dialogue-v2.mjs` source hash change; all 71 source hashes were checked against the commit's files. These scenarios run without technicalTrial, so request payloads, behavior, schema, failure, clocks, policy, calls/sends and storage are unchanged. Existing 3 run-ID exclusions are unchanged.

Earlier fixture directories remain byte-identical. Only the current provenance target URL and its baseCommit literal move. No real API, Keychain, .env, study data or live run was used.
