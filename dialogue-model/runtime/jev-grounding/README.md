# Jev grounding eval set (data-free tooling)

Offline tooling for evaluating two closed-set evidence axes per turn, judged in
shadow only:

- **target**: public evidence that both sides identify the same figure —
  `supported` / `insufficient` / `contradicted` / `unknown`;
- **name**: public evidence that a name for it was jointly adopted —
  `agreed` / `unclear` / `not_agreed` / `no_name` / `unknown`
  (grounding-criteria/v2: `unclear` needs an explicit naming proposal or a 仮称
  offered as the name by context; a 見立て or impression alone is `no_name`;
  `not_agreed` = a proposed name rejected, competing, withdrawn or not adopted;
  borderline 仮称 decisions are recorded with their rationale and marked weak).

This directory holds code only. Cases built from the historical dialogues or the
AI session stay under `private-runs/jev-grounding/evalset/` (directory 0700,
files 0600) and are never committed. Nothing here calls a model.

| File | Role |
| --- | --- |
| `evalcase.ts` | Case type shared with the shadow runner, runtime validator, `toJudgeInput()` (public history only), `assertSendable()` |
| `labels.ts` | Parsers for a1–a30 / M0–M4 / P1–P6 / ER0–ER1 / episode markers, active-M restoration, label distributions |
| `derive.ts` | Conservative gold rules (`jev-grounding-derive/v3`) for episode-end and local-window cases |
| `skeleton.ts` | Label-skeleton rendering with an invented lexicon (local-only) |
| `split.ts` | Seeded per-dialogue split, leave-one-dialogue-out folds, leakage check |
| `metrics.ts` | Per-axis confusion / accuracy / macro-F1 / abstention, failure-tag detection with a pluggable flag policy |
| `ai-session.ts` | AI-session turns as cases (history ends before the AI reply), offline answer-key check |
| `build-evalset.ts` | Researcher CLI; output guard shared with `naming-task.mjs` (canonical path, no repository or `.git` checkout); prints counts only |
| `name-scenes.ts` | Historical name-state scenes (row refs only), label-only proxies, comparison with a reader |
| `compare-name-scenes.ts` | Researcher CLI for the scene comparison; prints counts only |

## What the labels can and cannot support

- Blank labels are never mapped to a value. A blank M continues the last explicit
  M of the same episode; before the first M of an episode the state is unknown.
- ER1 supports the name axis (`agreed`) at episode end only; ER0 leaves it
  null because it cannot tell `no_name`, `unclear` and `not_agreed` apart. ER1 is joint adoption, not
  independent correctness: `correctnessKnown` is always false for historical cases.
- M does not record its dimension (target, position, orientation, name…), so
  every target value derived from M is `weak` (`axisQuality.target`), and M2
  alone gives `insufficient`: `contradicted` also needs an explicit denial (a12 /
  Deny). Whether M4 at a commitment point may count as target sharing is a
  researcher decision; until then weak gold stays out of the headline:
  `evaluate()` excludes it by default, and `evaluate(cases, predictions, ["weak"])`
  reports it separately.
- a11 / a3 / a9 / a4 mark commitment positions (where an unfounded 「わかります」
  would sit); they are never evidence of a shared referent by themselves.
- P5 (approximate adoption) leaves the target axis null: what stayed incomplete
  is not recorded.
- Local-window cases use labels up to the focal row only (the focal M was
  annotated with 1–3 turns of local post-context); never ER or later rows.
- The 5 dialogues shaped the annotation criteria, so agreement on them is a
  regression check, not generalisation (`annotation/evaluation.md`).

## Historical name states (task D)

The annotation scheme has no "naming proposal" label, so whether a name was
proposed, left open, rejected or adopted has to be read from the utterances.
Reader scenes (`NameScene`) hold row references only and live under
private-runs. `compareScenes()` scores three label-only proxies against them:
ER1 at the row (`erOnly`), the superseded "impression = candidate" reading
(`impressionAsProposal`), and a11 with an acknowledged impression
(`agreementTag`). They measure how far the labels can stand in for a reader;
none of them is gold, and none says whether both people meant the same figure.

## Confidence

Any Jev score evaluated with these tools is a relative / action confidence until
calibrated against human gold. It is not P(correct target), and the current
action-selection probabilities are not reused as such.

## Build (researcher only)

```sh
node dialogue-model/runtime/jev-grounding/build-evalset.ts \
  --historical <private>/historical-human-utterances.jsonl \
  --record <private>/record-<id>.json --ai-annotations <private>/ai-session-annotations.private.json \
  --out <private>/jev-grounding/evalset --procedural H1:E0
```

Only from-scratch synthetic cases may be sent to a model. Historical cases, their
skeletons and AI-session cases are `externalModelAllowed: false`.
