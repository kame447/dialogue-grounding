# Synthetic failure capture: holistic_v5 integration with jev_generation_retry_v11 after the audit 28 and 28n fixes

Source commit 01dfc675f5d1dbce8ffcbc49a604aacd48c884f9. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-4cf12c2 the records differ only at those 15 run-ID leaves (the prompt sources are unchanged); the source-file digests in the metadata changed with the naming-request.ts fixes. The leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
