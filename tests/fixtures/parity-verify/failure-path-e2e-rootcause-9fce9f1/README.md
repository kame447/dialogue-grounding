# Synthetic failure capture: holistic_v5 integration with the audit 22 fix (v9)

Source commit 9fce9f14bbc9a1f9172a41e5326628d7ef38ce24. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-d3e0987, records differ at 21 leaves: 15 run IDs and 6 source/identity hash leaves. The leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
