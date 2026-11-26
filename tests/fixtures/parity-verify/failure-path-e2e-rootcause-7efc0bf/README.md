# Synthetic failure capture: holistic_v5 integration with v7 and scoped_v4 (audit 16, third adoption)

Source commit 7efc0bf91f90863399ff3e6a04f999e57ecd8bcd. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-e83de8a, records differ at 26 leaves: 15 run IDs and 11 instruction-source/identity hash leaves (source changes from 25425e9 and 7efc0bf). The leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
