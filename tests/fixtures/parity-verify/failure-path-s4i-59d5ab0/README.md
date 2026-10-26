# Synthetic failure capture after the S4 I integration

Source commit 59d5ab0b6104788234220e8e793e7e835a69d303 (S4 I on main f88abb3). Two independent captures were made on a clean tree with the generator API (`writeFailureFixture`); they differ from each other only at 15 run-ID leaves.

Compared with the adopted failure-path-s2-1b10f5c capture, records differ only at 15 run-ID leaves, 10 instruction-source hash leaves (`v2/dialogue-v2.mjs` and `v2/jev-turn.ts` in each of the 5 scenarios) and the derived `identity.prompts` digest (`researchHash(promptSources)`, live.ts:478). Request payloads, behavior, schema, failure, clocks, policy, calls/sends and storage are unchanged. Existing 3 run-ID exclusions are unchanged.

Earlier fixture directories remain byte-identical. Only the current provenance target URL and its baseCommit literal move. No real API, Keychain, .env, study data or live run was used.
