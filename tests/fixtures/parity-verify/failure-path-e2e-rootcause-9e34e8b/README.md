# Synthetic failure capture: holistic_v5 integration with v8 and scoped_v5 (audit 17, fourth adoption)

Source commit 9e34e8be8fea7969291d6e4f4f6796fbfa77739e. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-7efc0bf, records differ at 26 leaves: 15 run IDs and 11 instruction-source/identity hash leaves (source changes from 6179272 and 9e34e8b). The leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
