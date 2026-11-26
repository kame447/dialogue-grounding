# Synthetic failure capture: holistic_v5 integration with jev_generation_retry_v11 after the audit 25 fixes

Source commit c4404b1a84731fea6ab0289da54177e4eeefb754. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-43a384f, records differ at 26 leaves: 15 run IDs and 11 source/identity hash leaves (prompt sources jev-turn.ts and generation-guard.ts, one trial prompt identity). The leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
