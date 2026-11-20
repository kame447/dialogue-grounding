# Synthetic failure capture after the #172 wording (partner board place, place-only accept)

Source commit f7e55ad587233de4ca3959d003004202eba186ea. Prompt wording is shared by both strategies:
- `TASK_INSTRUCTIONS_V2`, the memo extraction prompt and Jev's referent and decision instructions separate a partner's place on their own board from shape features.
- The accept wording has an explicit branch for a place-only turn: ask for the shape. Every other accept keeps its original wording.

Two independent captures were made on a clean tree with the generator (`node tests/support/generate-failure-fixture.ts <dir>`); they differ from each other only at 15 run-ID leaves.

Compared with the adopted failure-path-repair-facts-e6e2c67 capture, records differ only at 166 leaves:
- 15 run IDs.
- 20 instruction-source hash leaves: `judgment/instructions.mjs`, `local-grounding/extract.ts`, `decision/jev-decision.ts` and `v2/dialogue-v2.mjs` in each of the 5 scenarios.
- The derived `identity.prompts` digest.
- In `cache_read_failed`, the request text and the hashes derived from it:
  - 52 text leaves, each equal to the previous text with exactly the #172 wording.
  - 78 hash leaves derived from those requests, including the Jev payload digests `actionInputs` and `humanReferent`.

The leaf-path set (6917 leaves) is unchanged, so behavior, schema, failure, clocks, policy, calls/sends and storage are unchanged.

In the metadata only `baseCommit`, `fixtureSha256` and the source hashes of those four files change. All 72 source hashes were checked against the commit's files. Existing 3 run-ID exclusions are unchanged.

The unmerged intermediate capture failure-path-partner-position-d4fa8fe (same branch, before the accept branch) is removed; it was never adopted on main. Earlier adopted fixture directories remain byte-identical. Only the current provenance target URL and its baseCommit literal move. No real API, Keychain, .env, study data or live run was used.
