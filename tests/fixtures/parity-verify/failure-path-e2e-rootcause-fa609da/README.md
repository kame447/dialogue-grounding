# Synthetic failure capture: holistic_v5 integration with v9 (generation-guard marker forms)

Source commit fa609da3f09d57af997581a1e342f6b6e5fd2b4b. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-5664324, records differ at 21 leaves: 15 run IDs and 6 source/identity hash leaves (the new trials are jev_generation_retry_v9). The leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
