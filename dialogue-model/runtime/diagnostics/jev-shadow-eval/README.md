# Jev 2-axis shadow comparison (offline)

This is a research-only runner. It compares the old v2 system's recorded behaviour with an independent 2-axis grounding verdict:

- **target-identification evidence**: `supported` / `insufficient` / `contradicted` / `unknown`
- **name-agreement evidence** (`grounding-criteria/v2`, 2026-10-19): `agreed` / `unclear` / `not_agreed` / `no_name` / `unknown`. These come from public utterances only. A 見立て such as 「鳥みたい」 is identification, not a naming proposal, so it counts as `no_name`; `unclear` needs an explicit proposal, or a 仮称 offered as the name. Runs before v2 used 4 levels, where "no name yet" counted as `not_agreed`. v1 and v2 results are compared side by side, never pooled.

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

## Versions

Every live verdict records the server-owned `criteriaVersion`, and every case may carry a `goldVersion`. The run summary lists both. Per-split and all-split tables give per-class precision and recall, and the private run file lists the individual name-axis errors that involve `no_name`.

`compare.ts` lines up two runs over the same case ids (`--old`, `--new`, `--out`; private, 0600). It states the limits of the comparison: a different criterion, a different gold version, and missing per-case verdicts in runs made before per-case results were kept.

## Running

```sh
node dialogue-model/runtime/diagnostics/jev-shadow-eval/run.ts \
  --record <record.json> [--cases <cases.jsonl>] [--failures <failures.jsonl>] --out <private dir>
```

- `--out` must be outside the repository. The run writes `shadow-run.json`, `shadow-report.private.md` and `shadow-summary.sanitized.md`, all mode 0600, with no utterance text.
- The default client is the mock.
- `--client live --max-calls N` (1 ≤ N ≤ 50) is opt-in. It refuses `--record` and sends only cases with `source: "synthetic"` that pass `assertSendable` (`externalModelAllowed: true`).
- The live client uses the grounding judge (`dialogue-model/runtime/grounding/`, `/v1/grounding-evidence`) with the research proxy config (`RESEARCH_AI_PROVIDER=cloudflare`). The route answers only while the proxy's `RESEARCH_GROUNDING_ENABLED` is on, and that is a researcher decision. Check the live status before any live run.
- Sendability and the case judge input come from jev-evalset (`jev-grounding/evalcase.ts`: `assertSendable`, `toJudgeInput`). A live run additionally requires `source: "synthetic"`.

## Temporary local OpenRouter diagnostic (`--client local-openrouter`)

This client is **temporary**. The researcher approved it on 2026-10-19 because the research proxy's `grounding-criteria/v2` deploy is waiting for Cloudflare re-authentication. It calls OpenRouter Decisions **directly from this machine, bypassing the proxy**. It does not replace the proxy, and the proxy's v2 update still needs that re-authentication and a deploy.

- **Opt-in per run.** No default configuration enables it.
- **Inputs it refuses.** It takes `--cases` only, and every line must be a valid `source: "synthetic"` case marked `externalModelAllowed`; otherwise it refuses the file. It also refuses `--record` and `--failures`, so no historical, AI-session or participant text is accepted.
- **Caps.** `--max-calls` must be between 1 and 51, and cumulative `usage.cost` is capped at $0.05. The cap is checked before each call, and a response without a cost fails closed.
- **Stop conditions.** The run stops on 401/403, 402 or 404, on a missing key, a key leak, the cost cap or a missing cost.
- **Same as the proxy.** The request is the proxy's own `buildGroundingPayload` (same model, questions, criteria, URL and 15 s timeout), and the response goes through the proxy's `sanitizeGroundingVerdict`, its key barrier and the client's `parseGroundingVerdict`. A test checks that the request body is byte-identical to the proxy's upstream request.
- **The key.** It is read from the macOS Keychain (`security find-generic-password -s dialogue-grounding-openrouter-api-key -a research -w`) with `execFile`, not a shell, and kept in memory only. It is never in argv, env, logs, files or error messages. Responses and every output file are scanned for the key; any hit aborts, and nothing is written. Upstream error bodies are not read.
- **Output.** The output directory must be outside any Git worktree (directory 0700, files 0600). Only sanitized verdicts and fixed error codes are stored.
