# S4 normal record for the #172 prompt version

`NORMAL-RECORDS.json` is the S4 normal record for the prompt version introduced at f7e55ad587233de4ca3959d003004202eba186ea:
- A partner's board place is separated from shape features.
- The accept wording has a place-only branch.

The original `../NORMAL-RECORDS.json` and its variants stay byte-identical to the baseline8af76e6 version. The independent verifier selects the version from `run.promptSources` and checks each record against that version's text.

## How it was derived

The record is derived from the original normal record deterministically, without hand-edited hashes.

1. The original replay tape was replayed with the code at f7e55ad.
2. Each request payload equals the original payload with exactly the #172 wording:
   - the task text sentence;
   - the memo extraction sentence;
   - the Jev decision guidance line;
   - the generator's accept sentence;
   - the accept scope.
3. Nine values map one-to-one from old to new:
   - the payload, message and instruction hashes of local_extraction, decision and generation;
   - `identity.prompts`.

   ai_extraction is unchanged. 50 hash leaves and 48 text leaves change.
4. `run.promptSources` is the producer's own `promptSourceManifest()` for the instruction source files at f7e55ad, and `trials[0].identity.prompts` is its digest.

## Checks

- The leaf-path set is unchanged.
- Replaying this tape with the f7e55ad code is `same_material_intervention_verified` and equals the recorded result.
- The independent intervention checks equal `../NORMAL-CHECKS.json`.

No real API, Keychain, `.env`, study data or live run was used.
