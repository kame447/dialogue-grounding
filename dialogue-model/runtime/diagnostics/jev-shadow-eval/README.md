# Jev 2-axis shadow comparison (offline)

This is a research-only runner. It compares the old v2 system's recorded behaviour with an independent 2-axis grounding verdict:

- **target-identification evidence**: `supported` / `insufficient` / `contradicted` / `unknown`
- **name-agreement evidence**: `agreed` / `unclear` / `not_agreed` / `unknown`

It is a shadow only. It never writes to a record, a ledger or a dialogue, it is not shown to participants, and it does not change `repair-first` or `bypass-enabled`.

## What it does

- **AI-session replay (mock only).** For every AI reply in a v2 record, the judge input is built from two things:
  - the public turns *before* that reply;
  - the AI's own committed judgment for it (an unverified hypothesis).

  The input never contains the reply itself, future turns, the scoring key, partner-side slots or figure ids. `audit.ts` checks this, and the run refuses to proceed if any of it leaks.
- **Old reply behaviours.** `replay.ts` classifies each reply from its recorded action and public wording: understanding claims (「わかります」 and similar), naming, agreement, confirmation, impression sharing, hold/revisit, repair.
- **Shadow flags.** `metrics.ts` raises a flag where the verdict and the reply disagree: `unfounded_wakarimasu`, `early_naming`, `contradictory_agreement`, `over_confirmation`. An `unknown` or failed verdict abstains.
- **Labelled cases.** Cases come from jev-evalset. Each axis is compared with provisional gold per split, together with a risk-flag false-positive rate and the share of `unknown` verdicts.
- **Data audit.** It checks seq gaps, unpaired judgments, split leakage by group, historical cases marked sendable, and label distributions.

## Limits

- Flag rules and thresholds are fixed heuristics and **uncalibrated**.
- Jev scores are relative/action scores, not the probability of a correct target. The old judge's action probabilities are not reused as P(correct).
- Historical gold comes from annotation labels:
  - a blank label is not "no misalignment";
  - a11 is not confirmation of the same referent;
  - ER1 is not independent correctness.
- Flags outside the known-failure list are not confirmed false positives, because that list is not exhaustive.
- The mock client (`mock-client.ts`) is a lexical stand-in, not a model. Its verdicts only exercise the plumbing.

## Running

```sh
node dialogue-model/runtime/diagnostics/jev-shadow-eval/run.ts \
  --record <record.json> [--cases <cases.jsonl>] [--failures <failures.jsonl>] --out <private dir>
```

- `--out` must be outside the repository. The run writes `shadow-run.json`, `shadow-report.private.md` and `shadow-summary.sanitized.md`, all mode 0600, with no utterance text.
- The default client is the mock.
- `--client live --max-calls N` (1 ≤ N ≤ 50) is opt-in. It refuses `--record` and sends only cases with `source: "synthetic"` and `externalModelAllowed: true`.
- The live client needs the grounding judge route (`/v1/grounding-evidence`, PR #52) and its client modules under `dialogue-model/runtime/grounding/`. As of 2026-10-19 the route is not deployed, and deploying it needs researcher approval. Check the live status again before any live run.
- The sendability guard duplicates jev-evalset's guard (#50). Once #50 merges, it should be replaced by that one.
