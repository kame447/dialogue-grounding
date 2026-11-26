# Synthetic failure capture: holistic_v5 integration with jev_generation_retry_v11 after the record-build fixes (A+C)

Source commit de1ee5a48332ada3172106625c211492cafcb9f0. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-01dfc67 the records differ at those 15 run-ID leaves and at the prompt-source digest of v2/jev-turn.ts (five scenarios) plus one identity/prompts digest that follows from it; the leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
