# Synthetic failure capture: #193 (holistic-first) merged with the synced #187 (main bcb8211)

Source commit c1e91122ccab02950277ae50a14eecafaeeaae58. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with the #193 capture failure-path-e2e-rootcause-2658c93, records differ at 36 leaves: 15 run IDs and 21 instruction-source/identity hash leaves (source changes from the main sync). The leaf-path set (6917) is unchanged and no request text changed. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
