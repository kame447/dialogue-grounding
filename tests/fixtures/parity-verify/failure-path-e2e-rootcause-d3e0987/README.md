# Synthetic failure capture: holistic_v5 integration with the audit 20 fix (v9)

Source commit d3e0987c11dc11c83d1f55cf81cf4f840e087ff3. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-fa609da, records differ at 26 leaves: 15 run IDs and 11 source/identity hash leaves. The leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
