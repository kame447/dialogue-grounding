# Synthetic failure capture after the #172 wording, merged with main bcb8211

Source commit eaa8e9c6a0e4007a881aaa5a93bfacd71a8fdd3a (merge of origin/main bcb8211 into fix/i172-partner-position-reference). Prompt wording is shared by both strategies and is the #172 wording unchanged:
- `TASK_INSTRUCTIONS_V2`, the memo extraction prompt and Jev's referent and decision instructions separate a partner's place on their own board from shape features.
- The accept wording has an explicit branch for a place-only turn: ask for the shape. Every other accept keeps its original wording.

Two independent captures were made on a clean tree with the generator (`node tests/support/generate-failure-fixture.ts <dir>`); they differ from each other only at 15 run-ID leaves.

Compared with the adopted failure-path-i184-usage-b8785e7 capture, records differ only at 166 leaves (same accounting as the pre-merge f7e55ad capture): 15 run IDs; 65 instruction-source/identity hash leaves; 74 request-text leaves, each equal to the previous text with exactly the #172 wording; and the request/payload digests derived from those texts. The leaf-path set (6917 leaves) is unchanged, so behavior, schema, failure, clocks, policy, calls/sends and storage are unchanged.

In the metadata only `baseCommit`, `fixtureSha256` and the source hashes of the changed instruction files differ. The earlier f7e55ad capture of this branch was never adopted on main and is removed. Earlier adopted fixture directories remain byte-identical. No real API, Keychain, .env, study data or live run was used.
