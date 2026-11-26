# Synthetic failure capture: holistic_v5 integration with the research Jev ceiling at 0.45 USD

Source commit d710f9fdf0b0e82cb98ce0401662199ffcfdee71. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with failure-path-e2e-rootcause-9f3b963, the records differ only at the 15 run-ID leaves (leaf-path set 6917 unchanged); the source-file hashes in the metadata differ for the constants file local-openrouter.ts. Earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
