# Synthetic failure capture: #177 (e2e-rootcause) merged with main bcb8211

Source commit 3c377b86e8b0421f68631c61d47074c033a51e62. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with the #177 capture failure-path-e2e-rootcause-0b2e01d, records differ at 36 leaves: 15 run IDs and 21 instruction-source/identity hash leaves (jev-turn.ts, jev-decision.ts, bypass-acceptance-related sources changed by the usagePolicy/questionLayout merge). The leaf-path set (6917) is unchanged and no request text changed. Main's usage-only changes carry no prompt text.
The earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
