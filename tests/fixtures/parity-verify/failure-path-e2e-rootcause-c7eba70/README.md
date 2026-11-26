# Synthetic failure capture: holistic_v5 integrated branch (audit 13 item 3)

Source commit c7eba709a001a889379294ff94211a6ca1ab3975. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-2658c93, records differ at 41 leaves: 15 run IDs and 26 instruction-source/identity hash leaves (source changes from audit 13 items 1, 2, 4, the v5 mark and patch 16). The leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
