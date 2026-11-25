# Synthetic failure capture after repaired S2 integration

Source commit1b10f5c6e8543849ca276e16a2a76e4b8c9ab315; tree41b86928f87f2a3f7dea426eb8745763ebe4ac8f. Both independent captures were made on a clean tree. All66 generator/producer/instruction source hashes match working bytes and git blobs. The generator API was called directly; its old CLI baseCommit3071720 did not label this capture.

Original failure-path and adopted failure-path-s1-s4-2ce098d remain byte-identical. Compared with the adopted current capture, records differ only at15 run-ID leaves. Two fresh captures also differ only at those15 leaves. Prompt-source, derived hash, behavior, schema, failure, clocks, policy, calls/sends and storage are unchanged. Existing3 run-ID exclusions are unchanged.

The metadata source map changes65→66 (live/replay changed; model-policy added). The S2F repair changes only the record-only collector and does not add a producer closure difference relative to acc6d88, but the source commit was genuinely rebound and fresh captures were still obtained. Previous unapplied proposalfb474c1a is retained as history, not relabelled.

Only the current provenance target URL and its baseCommit literal are proposed to move. Historical test literals/assertions, generator and all behavioral expectations remain untouched. This directory requires exact-byte R2-D-S2 pre-application approval. No real API, Keychain, .env, study data or live run was used. Japanese quality Argon未評価.
