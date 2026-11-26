# Synthetic failure capture: holistic_v5 integration with the audit 19 fix (fifth adoption)

Source commit 56643241f6846dd3db5f2b2ea8b7d2ef227d9f91. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-9e34e8b, the records differ only at the 15 run-ID leaves (leaf-path set 6917 unchanged); the source-file hashes in the metadata differ for local-grounding/verify.ts (the audit 19 fix). Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
