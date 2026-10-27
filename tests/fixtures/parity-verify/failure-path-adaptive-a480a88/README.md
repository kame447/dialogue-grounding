# Synthetic failure capture after the adaptive repair integration

Source commit a480a8899511a5ee815079fbbf4096348bcbcb1e (adaptive human simulator, Jev repair prospect and open-issue veto rerank on main 49d1ab7). Two independent captures were made on a clean tree with the generator (`node tests/support/generate-failure-fixture.ts <dir>`); they differ from each other only at 15 run-ID leaves.

Compared with the adopted failure-path-s4i-59d5ab0 capture, records differ only at 15 run-ID leaves, 15 instruction-source hash leaves (`decision/jev-decision.ts`, `v2/dialogue-v2.mjs` and `v2/jev-turn.ts` in each of the 5 scenarios) and the derived `identity.prompts` digest. The new behavior is opt-in (`technicalTrial`) and off here, so request payloads, behavior, schema, failure, clocks, policy, calls/sends and storage are unchanged. Existing 3 run-ID exclusions are unchanged.

Earlier fixture directories remain byte-identical. Only the current provenance target URL and its baseCommit literal move. No real API, Keychain, .env, study data or live run was used.
