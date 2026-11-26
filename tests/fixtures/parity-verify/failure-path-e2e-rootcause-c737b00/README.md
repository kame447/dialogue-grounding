# Synthetic failure capture: holistic_v5 integration after the audit 31 fix, the 1.00 USD research Jev ceiling and its acceptance tests

Source commit c737b00 (full ID in capture-metadata.json). Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-777d882 the records differ at those 15 run-ID leaves only (the leaf-path set, 6917, is unchanged); the metadata differs in baseCommit and in the source digests of decision/naming-request.ts and jev-shadow-eval/local-openrouter.ts. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
