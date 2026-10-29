# Synthetic failure capture after the public-name agree fix (#141)

Source commit a62eb003a4ba4866719788a881ccad987c3473f5 (the #150 agree fix c762d97 cherry-picked onto main badaaf0: agree candidates limited to publicly proposed or accepted names, with technicalTrial agreeNames evidence). Two independent captures were made on a clean tree with the generator (`node tests/support/generate-failure-fixture.ts <dir>`); they differ from each other only at 15 run-ID leaves.

Compared with the adopted failure-path-rotation-1fbb836 capture, records differ only at 26 leaves: 15 run IDs, 10 instruction-source hash leaves (`decision/jev-decision.ts` and `v2/jev-turn.ts` in each of the 5 scenarios) and the derived `identity.prompts` digest. The source map also changes for `decision/contract.ts` and `decision/bypass-acceptance.ts`; all 71 source hashes were checked against the commit's files. The new behavior is opt-in (`technicalTrial`) and off here, so request payloads, behavior, schema, failure, clocks, policy, calls/sends and storage are unchanged. Existing 3 run-ID exclusions are unchanged. Metadata records the actual base commit instead of the generator's historical `3071720` literal.

Earlier fixture directories remain byte-identical. Only the current provenance target URL and its baseCommit literal move. No real API, Keychain, .env, study data or live run was used.
