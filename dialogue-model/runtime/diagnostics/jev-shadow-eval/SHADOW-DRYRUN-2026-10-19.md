# Jev 2-axis shadow comparison: mock dry run and live synthetic run (2026-10-19)

This is a sanitized summary with aggregates only: no utterance text, no answer key, no case content. AI-session turns are referred to by seq number only. The private report and the run outputs are in `private-runs/jev-grounding/shadow-eval/`.

## Live synthetic run (2026-10-19, researcher-approved)

- **Setup.** Proxy 97346e3c, built from main b80d7bc. `RESEARCH_GROUNDING_ENABLED` was on only for this run. It sent from-scratch synthetic cases only: no historical text and no AI-session text.
- **Calls: 40** (1 smoke + 39 main) out of an approved 50. 40 ok, 0 failed. The 10-call reserve was not used.
- **Model:** `typesafe/jev-1.14-20261014`. One call judges both axes.
- **Latency:** smoke 593 ms; main p50 417 ms, p95 514 ms, max 534 ms.
- **Tokens:** smoke 2,495 in / 104 out; main 99,819 in / 4,097 out.
- **Cost (reported by the API):** $0.000105 + $0.004192 = **$0.004297**.
- **Agreement with synthetic gold.** All synthetic gold is `weak` (authored by construction), so these are weak-gold numbers. There is no non-weak headline for this set.

  | Split | Cases | Target agreement | Name agreement | `unknown` verdicts |
  |---|---|---|---|---|
  | dev | 18 | 0.833 | 0.444 | 0.111 |
  | holdout | 21 | 0.857 | 0.238 | 0.19 |

  - **Target axis:** no gold-`supported` case was judged insufficient or contradicted. Recall on gold insufficient/contradicted was 0.778 (dev) and 0.917 (holdout). The misses were insufficient→supported ×2, insufficient→contradicted ×1, contradicted→insufficient ×2 and insufficient→unknown ×1.
  - **Name axis: label-semantics gap.** The judge returned `not_agreed` for 19 of the 23 gold-`unclear` cases, where no name had been proposed or settled. Gold `agreed` was judged correctly in 6 of 7 cases, and `not_agreed` in 4 of 4. Until the criterion separates "no name in play" from "name rejected", the name axis is unusable for flags.
- **Repeat stability:** 4 of 4 repeated identical inputs gave identical verdicts on both axes.
- **Probe replies** (scored locally, never sent; 33 rows including 3 repeats):

  | Tag | Detected | False flags |
  |---|---|---|
  | unfounded_wakarimasu | 6/6 | 1 |
  | early_naming | 5/5 | 0 |
  | contradictory_agreement | 7/8 | 1 |
  | over_confirmation | 2/2 | 0 |

  1 of 16 clean controls was flagged.
- **Limits:** few cases, all with weak author gold. Thresholds and flag rules are uncalibrated. These numbers are not evidence about real dialogues.

## Mock dry run: status at the time

- **Mock dry run:** no real calls. The live synthetic run is reported above.
- **Live proxy before the deploys, checked by ScarletDarwin at about 04:40 JST:**
  - `/v1/decisions` returned 404;
  - `/v1/decision-policy` returned 404;
  - `/v1/model-policy` returned 200.

  At that time no 2-axis route was deployed. The decisions route was deployed later as c23ac798, and the grounding route as 97346e3c, with grounding on only for the live run above.
- **Models used in the mock run: none.** The client was `mock-lexical`, an in-process lexical stand-in, not a model. Its verdicts carry **no evidential weight**: they only exercise the replay, metrics and audit.
- **Latency, cost, failures in the mock run:** none to report, since no external calls were made.

## Inputs (from jev-evalset, HumbleLangmuir)

- **AI session:** 87 events, 43 committed AI judgments, strategy repair-first. The task outcome was 3 of 6 matched (provisional scoring).
- **Historical source:** 837 utterance rows in 5 dialogues, 44 episodes.
  - M labels: M0 47, M1 30, M2 17, M3 46, M4 51 (blank 646).
  - P labels: P1 41, P2 15, P3 12, P4 12, P5 14 (blank 743).
  - ER labels: ER1 36, ER0 8 (blank 793).
  - a labels: blank 20.
- **How gold was extracted:** with the rule set `jev-grounding-derive/v2` (PR #50, head d98b3b7), from M/P/ER/a labels and local context.
  - A blank label is never read as "no misalignment".
  - a11 is not taken as same-referent confirmation.
  - ER1 is not taken as independent correctness.
  - Every historical case has `correctnessKnown: false`.
  - Every M-derived target is `weak`. In this set, `contradicted` now appears only in AI1 (4 cases) and in the synthetic cases.
- **Splits are by dialogue:** H4 holdout, H1 dev, H2/H3/H5 train, AI1 dev.
- **Cases used in the dry run:** 438 in total.
  - 360 historical local-window and episode-end cases. Under v2, M-derived targets are all `weak` and `contradicted` needs an explicit denial. Historical local windows therefore have 0 contradicted cases, and only the name axis at the 43 episode ends counts as `derived` headline gold.
  - 43 AI-turn cases.
  - 35 from-scratch synthetic cases.
- **Case metrics:** the runner reports case metrics per split. Headline numbers exclude `weak` labels, and each split is also broken down into `explicit`, `derived` and `weak` (parent decision on #50). With the mock client these agreement numbers are meaningless, so they are not quoted here.
- **Case audit:** no duplicate ids, no group in more than one split, no turns after the focal turn, and 0 historical cases marked sendable. The 35 sendable cases are all synthetic.

## AI-87 replay (mock)

- **Leakage audit.** Judge inputs equal the public prefix before each reply, so there are 0 future-turn leaks and 0 answer-key ids. There are no seq gaps and no unpaired judgments.
- **Behaviour of old replies (lexical plus recorded action):**

  | Behaviour | Turns |
  |---|---|
  | confirmation | 24 |
  | impression sharing | 18 |
  | naming | 12 |
  | understanding claims (「わかります」 etc.) | 11 |
  | agreement | 6 |
  | hold/revisit | 2 |
  | repair | 1 |

  The recorded actions were confirm 21, propose_name 9, agree 6, accept 5, repair 1, close 1.
- **Reviewed failures.** HumbleLangmuir's list is a provisional single-reviewer list built on the Argon audit. It has 12 turns with a failure tag detectable from public text:

  | Tag | Turns |
  |---|---|
  | unfounded_wakarimasu | 5 |
  | early_naming | 4 |
  | over_confirmation | 2 |
  | contradictory_agreement | 1 |

  Offline-only tags are reported separately and kept out of the denominator: state_mismatch 6 and wrong_target_agreement 3.
- **Mock detection:** 8 of 12 flagged. Detected seqs: 3, 5, 23, 27, 31, 55, 67, 69. Missed: 9, 11, 33, 61. These numbers only check the plumbing.
- **Rule ceiling.** The same flag rules were fed the reviewer's gold axes, with no judge involved:

  | Tag | Detected |
  |---|---|
  | unfounded_wakarimasu | 5/5 |
  | early_naming | 4/4 |
  | contradictory_agreement | 0/1 |
  | over_confirmation | 0/2 |

  10 of 27 reviewed clean turns were flagged. These are provisional false positives: mostly existence or affirmative claims and naming while the gold target is `insufficient`, on turns the reviewer did not tag.
- **Agree turns against the offline key:** 6 in total, 3 ended matched. The mock flagged 1 of the 3 that ended mismatched.

## Synthetic probes (gold by construction; mock)

- 30 probe replies, scored locally and never sent to a judge.
- Rule ceiling: unfounded_wakarimasu 5/5, early_naming 5/5, contradictory_agreement 6/7, over_confirmation 2/2.
- 1 of 15 clean controls was flagged.

## Residual problems

- **Real judge measured on synthetic cases only.** On the AI session and the historical cases the judge was mock only. The name-axis semantics gap must be fixed before name-based flags are used.
- **Thresholds and flag rules are uncalibrated.** Jev scores are relative/action scores, not the probability that a target is correct. The old judge's action probabilities are not reused.
- **Reviewer definition differs for over_confirmation.** The reviewer means a confirmation loop that makes no progress; the rule means confirming what is already grounded. contradictory_agreement on a self-correction that keeps the same name (seq 11) is not visible from public wording.
- **Lexical behaviour classification was tuned against the AI1 dev turns,** so it may overfit. There is no AI-session holdout. Historical holdout H4 is untouched by tuning.
- **Gold limits.** Historical gold is derived from labels, and every historical case has `correctnessKnown: false`. Historical target gold is all `weak`, and so are the synthetic cases (gold by construction) and 28 of the 43 AI1 cases. Headline (non-weak) target agreement therefore rests on just the 15 `derived` AI1 cases. Synthetic-case results must be read as a separate, weak-gold check. AI-turn and synthetic gold come from a single reviewer or author.
- **Offline-only failures** (wrong_target_agreement, state_mismatch) cannot be detected by a public-text judge.
