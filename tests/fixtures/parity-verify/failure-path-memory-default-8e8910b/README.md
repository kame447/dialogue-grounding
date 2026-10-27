# Synthetic failure capture after the reference-memory default change

Captured from the working tree based on commit 8e8910b3889531c8654baf4426818bff7197c996 with the reference-memory default-on change applied. The metadata source map binds the exact working-tree bytes, including the changed `v2/dialogue-v2.mjs`; the base commit alone does not identify those changed bytes.

The existing `writeFailureFixture` API generated the producer records and source hashes without modification. Metadata records the actual base commit rather than the generator's historical hard-coded `3071720` value and explicitly identifies the working-tree change. The fixture test independently generates two fresh captures and compares both with this capture, retaining the same three run-ID exclusions.

Compared with `failure-path-adaptive-aa6673d`, the records have 21 changed leaves: 15 run IDs, five instruction-source hashes for `v2/dialogue-v2.mjs`, and one derived `identity.prompts` digest. Request payloads, behavior, schema, failures, clocks, policy, calls, sends and storage are unchanged. The source map has one changed hash. All earlier fixture directories and historical literal pins remain unchanged; only the current comparison target and its base-commit assertion move.

The capture uses the existing five offline scenarios with synthetic input and mock transports. No real API, Keychain, private research data or live run is used.
