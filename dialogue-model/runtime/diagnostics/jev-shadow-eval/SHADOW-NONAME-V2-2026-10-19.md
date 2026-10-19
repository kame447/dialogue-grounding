# Jev 2-axis shadow: 5-level name axis (no_name) on synthetic cases (2026-10-19)

This is a sanitized summary: aggregates and synthetic case ids only, with no utterance text and no keys. The earlier 4-level run is reported separately in `SHADOW-DRYRUN-2026-10-19.md` and is left unchanged. The private run files are in `private-runs/jev-grounding/shadow-eval/local-v2-*-20261019/`.

## What changed since the v1 run

- **Name axis, `grounding-criteria/v2`** (researcher-approved option 3, with rule 6813). The axis now has 5 levels:
  - `agreed`: explicit joint adoption.
  - `unclear`: an explicit naming proposal, or a 仮称 offered as the name, whose adoption is not settled.
  - `not_agreed`: rejection, competing candidates, withdrawal, or assignment to another figure.
  - `no_name`: no proposal for this referent. A 見立て such as 「鳥みたい」 is identification, not a proposal.
  - `unknown`.

  Only public utterances count. The name axis says nothing about target correctness.
- **Synthetic gold v3.**
  - All 35 unique cases were re-read utterance by utterance under rule 6813. TanDirac reviewed non-blind (TanDirac wrote v1); NavyMaxwell reviewed blind for v2 and independently for v3.
  - Raw agreement was 35/35 on target, name and proposer. That is at ceiling and is weak evidence of reliability: one fresh, explicit rule applied to short, author-made cases.
  - Labels v1 and v2 are kept. Holdout labels were fixed by content before any v2 result, and the gold was frozen with sha256 hashes before the first call.
  - Two names are marked weak: I05 and N02.
- **Supplementary holdout block `holdout-add`.** 6 new cases (H01–H06) with explicit pending proposals or rejections, labelled blind by both reviewers (6/6 agreement). H04 and H06 are weak. This block is reported separately and never pooled into the comparison.

## Run

- **Route:** a temporary local OpenRouter Decisions client (#67, researcher-approved), because the proxy's v2 deploy is waiting for Cloudflare re-authentication. The request is byte-identical to the proxy's, and responses go through the proxy's sanitizer. Inputs were synthetic only.
- **Model:** `typesafe/jev-1.14-20261014`. **Criteria:** `grounding-criteria/v2`. **Gold:** `synthetic-gold/v3`, plus `v3+holdout-add`.
- **Calls:** 51 of 51 allowed; 51 ok, 0 failed.

  | Invocation | Calls | Cost |
  |---|---|---|
  | smoke | 1 | $0.000135 |
  | main (39 + 5 boundary repeats) | 44 | $0.006064 |
  | holdout-add | 6 | $0.000830 |
  | **total** | **51** | **$0.007029** (cap $0.05) |

- **Latency (main):** p50 343 ms, p95 471 ms, max 536 ms. About 3.3k input tokens per call.

## Results on the primary 39 cases (frozen gold v3)

| Split | Target | Name (all) | Name (non-weak) |
|---|---|---|---|
| dev (18) | 15/18 = 0.833 | 14/18 = 0.778 | 13/16 = 0.812 |
| holdout (21) | 20/21 = 0.952 | 16/21 = 0.762 | 16/21 = 0.762 |
| all (39) | 35/39 = 0.897 | 30/39 = 0.769 | — |

**Name axis, all 39** (gold → judged):

| Gold | Judged | Recall | Precision |
|---|---|---|---|
| agreed | agreed 5 | 5/5 | 5/6 |
| unclear | unclear 1, no_name 1 | 1/2 | 1/3 |
| not_agreed | not_agreed 3, unclear 2, agreed 1 | 3/6 | 3/3 |
| no_name | no_name 21 | 21/21 | 21/27 (5 of the 6 false `no_name` verdicts are gold `unknown`, U01–U04 including U02#r2, a criterion question; 1 is the weak `unclear` N02) |
| unknown | no_name 5 | 0/5 | — |

**Target axis, all 39:**

| Gold | Judged | Recall | Precision |
|---|---|---|---|
| supported | supported 13 | 13/13 | 13/15 |
| insufficient | insufficient 11, supported 2, contradicted 1, unknown 1 | 11/15 | 11/11 |
| contradicted | contradicted 6 | 6/6 | 6/7 |
| unknown | unknown 5 | 5/5 | 5/6 |

**Individual errors involving `no_name`** (gold → judged):
- SYN-U01, U02, U03, U04, U02#r2: unknown → no_name.
- SYN-N02 (weak): unclear → no_name.

**Other name errors:**
- SYN-C03 and C03#r2: not_agreed → unclear. 「どれのこと？」 plus rejection of the name is read as pending.
- SYN-C06: not_agreed → agreed. The name is accepted but for another figure.

**Target errors:** I05 and M01 insufficient → supported; I09 → contradicted; I04 → unknown.

**holdout-add (6, separate):**
- Target 6/6.
- Name 5/6; non-weak 4/4.
- `unclear` vs `no_name` is now distinguishable on held-out explicit proposals, but on 4 cases only. This is not a rate.
- The one miss is H06 (weak; one speaker offering two candidates): not_agreed → unclear.

**Repeat stability:** 9 of 9 identical-input pairs gave identical verdicts on both axes.

**Probe flags** (synthetic probe replies, scored locally, never sent; 37 rows):

| Tag | Detected | False flags |
|---|---|---|
| unfounded_wakarimasu | 7/7 | 1 |
| early_naming | 5/5 | 0 |
| contradictory_agreement | 9/9 | 3 |
| over_confirmation | 2/2 | 0 |

3 of 18 clean controls were flagged. The flag rules are uncalibrated, and they were checked only against weak, author-made probes.

## Comparison with the v1 run on the same 39 cases

| Split | Target v1 → v2 | Name v1 → v2 |
|---|---|---|
| dev | 0.833 → 0.833 | 0.444 → 0.778 |
| holdout | 0.857 → 0.952 (mostly C03's gold changing from contradicted to insufficient) | 0.238 → 0.762 |

**Limits of this comparison:**
- **Three things changed at once:** the criteria (v1 → v2), the levels (4 → 5) and the gold (v1, author-only → v3, double-reviewed). The name-axis gain mostly reflects aligning the criterion and the gold, not a better judge.
- **The holdout target gain mostly comes from one gold correction:** C03 changed from contradicted to insufficient.
- **Split level only:** the v1 run kept no per-case verdicts, so cases can't be compared one by one.

## Residual problems

The first four items below are candidate criterion lines, a researcher decision. Gold v3 is **not** changed after these results. If a `grounding-criteria/v3` is adopted, it must be headlined on **fresh** holdout cases written blind to these outputs. The present 39 + 6 cases were seen during criterion design and can only be reported as a dev/regression table.

- **No referent under discussion** (fillers, an image that isn't visible) is judged `no_name`, while the gold says `unknown`. The criterion needs a line deciding this; that is a researcher decision.
- **Assignment to another figure** is not applied: C06's name is accepted for a different figure and judged `agreed`.
- **「どれのこと？」 plus rejection of the name** is judged `unclear` rather than `not_agreed` (C03).
- **Competing candidates from one speaker** are judged `unclear` (H06). This needs a definition, or expert labels.
- **`unclear` has very little evidence:** 2 cases in dev and 4 in holdout-add.
- **Flag rule gap:** an agreement claim while the name is `unclear` would need to know who proposed the name, and the verdict doesn't carry that.
- **The gold is synthetic and author-made.** It says nothing about real dialogue. Thresholds are uncalibrated, and the scores are relative, not P(correct).
- **Proxy status:** the public proxy still runs criteria v1 with grounding OFF. Deploying v2 still needs the Cloudflare re-login. The experiment Worker is unchanged, and the shadow stays default OFF.
