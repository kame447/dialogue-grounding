# Synthetic failure capture after the rotation-mode change (#142)

Source commit 1fbb836e8a075266cb3fd727b8b97cfb94e6b286 (the #139/#142 integration: researcher-selectable rotation mode in `stimuli/scatter-v2.mjs`, researcher-saved reception protocol; on main 16732f8). Two independent captures were made on a clean tree with the generator (`node tests/support/generate-failure-fixture.ts <dir>`); they differ from each other only at 15 run-ID leaves.

Compared with the adopted failure-path-luna-public-acts-74923ab capture, records differ only at those 15 run IDs: the default rotation mode (`relative_pm90`) produces the same seed-1701 images, anchors, requests, behavior, failures, clocks, calls and storage. In the metadata only `fixtureSha256` and the `stimuli/scatter-v2.mjs` source hash change; all 71 source hashes were checked against the commit's files. Existing 3 run-ID exclusions are unchanged. Metadata records the actual base commit instead of the generator's historical `3071720` literal.

Earlier fixture directories remain byte-identical. Only the current provenance target URL and its baseCommit literal move. No real API, Keychain, .env, study data or live run was used.
