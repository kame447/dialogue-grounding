# Synthetic failure capture: holistic_v5 integration with jev_generation_retry_v11 (final batch, scoped_v6)

Source commit 4cf12c259cc62ce6f3e6e3607a38777a3bc51657. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-c4404b1, records differ at 31 leaves: 15 run IDs and 16 source/identity hash leaves (prompt sources jev-turn.ts, generation-guard.ts and decision/jev-decision.ts in five scenarios, one trial prompt identity). The leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
