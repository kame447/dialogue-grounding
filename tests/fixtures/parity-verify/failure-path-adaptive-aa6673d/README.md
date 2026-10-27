# Synthetic failure capture after the agreement gate

Source commit aa6673d5ac2118e8fbcea6de7e8e05455fa94c70 (agreement gate for repair prospects, adaptive_repair_v2, on main f52e669). Two independent captures were made on a clean tree with the generator (`node tests/support/generate-failure-fixture.ts <dir>`); they differ from each other only at 15 run-ID leaves.

Compared with the adopted failure-path-adaptive-a480a88 capture, records differ only at 15 run-ID leaves, 5 instruction-source hash leaves (`v2/jev-turn.ts` in each of the 5 scenarios) and the derived `identity.prompts` digest. The gate is opt-in (`technicalTrial` version adaptive_repair_v2) and off here, so request payloads, behavior, schema, failure, clocks, policy, calls/sends and storage are unchanged. Existing 3 run-ID exclusions are unchanged.

Earlier fixture directories remain byte-identical. Only the current provenance target URL and its baseCommit literal move. No real API, Keychain, .env, study data or live run was used.
