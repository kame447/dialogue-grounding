# Synthetic failure capture: holistic_v5 integration with jev_generation_retry_v10

Source commit 0cf4d9cb8c59ba8f9cb34f9f46157a78593d1f65. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-d710f9f, records differ at 26 leaves: 15 run IDs and 11 source/identity hash leaves (new trials are jev_generation_retry_v10). The leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
