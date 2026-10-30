# Synthetic failure capture after the adaptive_repair_v3 repair facts (#14 A2)

Source commit e6e2c67ef56cbfee1a6a61e16d913d7ac353293c (opt-in technical trial adaptive_repair_v3: mechanical repair facts in Jev's input; OFF, v1 and v2 requests unchanged). Two independent captures were made on a clean tree with the generator (`node tests/support/generate-failure-fixture.ts <dir>`); they differ from each other only at 15 run-ID leaves.

Compared with the adopted failure-path-argon-wording-44c0610 capture, records differ only at 26 leaves: 15 run IDs, 10 instruction-source hash leaves (`v2/jev-turn.ts` and `decision/jev-decision.ts` in each of the 5 scenarios) and the derived `identity.prompts` digest. In the metadata only `baseCommit`, `fixtureSha256`, the source hashes of `decision/bypass-acceptance.ts`, `decision/contract.ts`, `decision/jev-decision.ts` and `v2/jev-turn.ts` change, and `decision/repair-facts.ts` is added (72 source files, all checked against the commit's files). These scenarios run without technicalTrial, so request payloads, behavior, schema, failure, clocks, policy, calls/sends and storage are unchanged. Existing 3 run-ID exclusions are unchanged.

Earlier fixture directories remain byte-identical. Only the current provenance target URL and its baseCommit literal move. No real API, Keychain, .env, study data or live run was used.
