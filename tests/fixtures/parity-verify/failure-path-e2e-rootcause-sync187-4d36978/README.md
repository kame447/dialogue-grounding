# Synthetic failure capture: #187 (human-name-accept-loop) merged with the synced #177 (main bcb8211)

Source commit 4d369783e1e641bdbbb75eb62cb34f96aa08aba7. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with the #187 capture failure-path-e2e-rootcause-2b409d0, records differ at 36 leaves: 15 run IDs and 21 instruction-source/identity hash leaves (source changes from the main sync). The leaf-path set (6917) is unchanged and no request text changed. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
