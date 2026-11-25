# Synthetic failure capture: #177 (e2e-rootcause) merged with main bcb8211

Source commit 62aeddf399840f3a3aea8c77997dac70d417e105. Two captures with `node tests/support/generate-failure-fixture.ts <dir>` on a clean tree differ only at 15 run-ID leaves.
Compared with the #177 capture failure-path-e2e-rootcause-0b2e01d, records differ at 36 leaves: 15 run IDs and 21 instruction-source/identity hash leaves (jev-turn.ts, jev-decision.ts, bypass-acceptance-related sources changed by the usagePolicy/questionLayout merge). The leaf-path set (6917) is unchanged and no request text changed. Main's usage-only changes carry no prompt text.
The earlier capture directories stay byte-identical. No real API, Keychain, .env, study data or live run was used.
Compared with the previous sync capture (3c377b8, never adopted on a pushed branch): 15 run IDs and 11 instruction-source/identity hash leaves (jev-decision.ts, jev-turn.ts, participant-jev-wiring.ts source changes for the usage-only failure evidence).
