# Synthetic failure capture after the public-name agree fix (#141)

Source commit c762d9780cac3d1d97e4bbb26ec8b2e3387a16e7 (agree candidates limited to publicly proposed or accepted names, with technicalTrial agreeNames evidence, on main 5302bda). Two independent captures were made on a clean tree with the generator (`node tests/support/generate-failure-fixture.ts <dir>`); they differ from each other only at 15 run-ID leaves.

Compared with the adopted failure-path-memory-default-8e8910b capture, records differ only at 26 leaves: 15 run IDs, 10 instruction-source hash leaves (`decision/jev-decision.ts` and `v2/jev-turn.ts` in each of the 5 scenarios) and the derived `identity.prompts` digest. The source map also changes for `decision/contract.ts` and `decision/bypass-acceptance.ts`. The new behavior is opt-in (`technicalTrial`) and off here, so request payloads, behavior, schema, failure, clocks, policy, calls/sends and storage are unchanged. Existing 3 run-ID exclusions are unchanged. Metadata records the actual base commit instead of the generator's historical `3071720` literal.

Earlier fixture directories remain byte-identical. Only the current provenance target URL and its baseCommit literal move. No real API, Keychain, .env, study data or live run was used.
