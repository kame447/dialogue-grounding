# Synthetic failure capture: holistic_v5 integration with v6 and the scoped_v3 agreement rule (audit 13 item 3, second adoption)

Source commit e83de8a9e59541e618e951a5cbba724c8a18a73a. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-c7eba70, records differ at 31 leaves: 15 run IDs and 16 instruction-source/identity hash leaves (source changes from fb2a3cb and e83de8a). The leaf-path set (6917) is unchanged. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
