# Synthetic failure capture: holistic_v5 integration with the v9 quote-span fix

Source commit 9f3b963c6b174d3636a05e7898bbbfdfea76f207. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-9fce9f1, records differ at 21 leaves: 15 run IDs and 6 source/identity hash leaves. The leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
