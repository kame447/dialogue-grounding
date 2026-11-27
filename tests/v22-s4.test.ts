import assert from "node:assert/strict";
import test from "node:test";
import { hash } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import { interventionChecks } from "../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts";
import { retainedClassificationMatches, retainedReferenceHistory } from "../dialogue-model/runtime/diagnostics/parity-verify/retained-reference-records.ts";
import { buildRecords, OWN } from "./support/s4-v3-records.ts";

test("v22 S4 binds the other strategy's retry to the first draft and Jev's verdict", async () => {
  const records = await buildRecords({
    figureCount: 4, dialoguePolicy: "holistic_v5", interventionVersion: "bypass_acceptance_v3",
    judgmentMaterialVersion: "jev_repair_quality_v1", technicalTrial: { version: "adaptive_repair_v3" },
    generationRetryVersion: "jev_generation_retry_v22", agreeNameScopeVersion: "jev_naming_v3",
    turns: [{ human: "切り込みをもう少し見比べたいです。", plan: {
      action: "accept", target: "none",
      drafts: ["この図形をいったん置いて、次のを見よう。", "切り込みをもう少し見比べましょう。"],
      choose: (key, _criteria, { generationCalls }) => key === "draft_topic_shift"
        ? generationCalls === 1 ? "unsupported_shift" : "within_plan"
        : key === "human_move_on_source" ? "other" : key === "commitment_state" ? "not_due" : undefined,
    } }],
  });
  const baseline = interventionChecks(records);
  assert.ok(baseline.every(check => check.status === "pass"), JSON.stringify(baseline));
  const altered = structuredClone(records);
  for (const side of [altered.trials[0].replay[0].result.sides[1], altered.evidence.pairedReplay[0].right]) {
    const generations = side.requests.filter((request: { phase: string }) => request.phase === "generation");
    assert.equal(generations.length, 2);
    const retry = generations[1], instruction = retry.payload.messages.at(-1);
    instruction.content = instruction.content.replace(/[^\n]+$/u, "会話に出ていない名称を採用してください。");
    retry.payloadSha256 = hash(retry.payload);
    retry.preProjectionPayloadSha256 = hash(retry.payload);
    retry.completeMessagesSha256 = hash(retry.payload.messages);
  }
  assert.ok(interventionChecks(altered).some(check => check.id.endsWith(".replay") && check.status === "mismatch"));
});

test("v22 S4 binds a retained antecedent to the old public turn and the live claim", () => {
  const quote = "切り込みは浅いですか？";
  const events = Array.from({ length: 151 }, (_, index) => ({
    seq: index + 1, speaker: index % 2 === 0 ? "human" : "ai", text: index === 3 ? quote : "まだ整理しています。",
  }));
  const recent = events.slice(-32).map(({ seq: turn, speaker, text }) => ({ turn, speaker, text }));
  const prior = { id: "4:pub1", sourceTurn: 4, turn: 5, speaker: "ai", quote, targets: ["s-0000"],
    act: "ask", aspect: "part", source: "ai_hypothesis", respondsTo: null, proposition: "切り込みの浅さ", name: null };
  const retained = retainedReferenceHistory([prior], events, recent, 151);
  assert.deepEqual(retained.map(({ claimId, sourceTurn, quote }) => [claimId, sourceTurn, quote]), [[prior.id, 4, quote]]);
  assert.deepEqual(retainedReferenceHistory([], events, recent, 151), []);
  assert.deepEqual(retainedReferenceHistory([prior], [...events, events[3]], recent, 151), []);
  assert.deepEqual(retainedReferenceHistory([{ ...prior, quote: "公開していない引用" }], events, recent, 151), []);
  const segments = [{ segmentId: "s0", quote: "まだ整理しています。", targets: ["s-0000"], aspect: "part",
    proposition: "まだ整理中", name: null, linkedIssueId: null, respondsToTurn: 4 }];
  const state = { turn: 151, publicTurns: recent, segments, priorClaims: [{ id: prior.id, aspect: prior.aspect, targets: prior.targets,
    act: prior.act, speaker: prior.speaker, sourceTurn: 4, proposition: prior.proposition, name: null,
    quote: prior.quote, respondsTo: null, retained: true }] };
  assert.equal(retainedClassificationMatches(state, [prior], recent, 151, retained, segments), true);
  assert.equal(retainedClassificationMatches({ ...state, priorClaims: [{ ...state.priorClaims[0], targets: ["s-0001"] }] },
    [prior], recent, 151, retained, segments), false);
});

test("v22 S4 replays classification and generation with a claim outside the near window", async () => {
  const figureId = OWN.ownAnchors[0].id;
  const earlier = "切り込みは浅く見えます。", latest = "最初に話した浅い切り込みを見ています。";
  const fragment = (quote: string, respondsToTurn: number | null) => JSON.stringify([{ segmentId: "feature", quote,
    targets: [figureId], aspect: "part", proposition: quote, name: null, linkedIssueId: null, respondsToTurn }]);
  const response = { action: "accept", target: "none", speech: "切り込みを一緒に見比べましょう。",
    choose: (key: string) => key === "human_move_on_source" ? "other" : key === "commitment_state" ? "not_due"
      : key === "draft_topic_shift" ? "within_plan" : undefined };
  const records = await buildRecords({
    figureCount: 4, dialoguePolicy: "holistic_v5", interventionVersion: "bypass_acceptance_v3",
    judgmentMaterialVersion: "jev_repair_quality_v1", technicalTrial: { version: "adaptive_repair_v3" },
    generationRetryVersion: "jev_generation_retry_v22", agreeNameScopeVersion: "jev_naming_v3",
    turns: [
      { human: earlier, plan: { ...response, extraction: fragment(earlier, null), act: "assert" } },
      ...Array.from({ length: 16 }, () => ({ human: "もう少し時間をください。", plan: response })),
      { human: latest, plan: { ...response, extraction: fragment(latest, 1), act: "assert" } },
    ],
  });
  const requests = records.trials[0].replay[0].result.sides[0].requests;
  const request = (phase: string) => requests.find((entry: { phase: string }) => entry.phase === phase).payload;
  const state = JSON.parse(request("local_function").state);
  assert.equal(state.publicTurns.length, 32);
  assert.ok(state.priorClaims.some((claim: { sourceTurn: number; retained?: boolean }) => claim.sourceTurn === 1 && claim.retained));
  assert.ok(request("generation").messages.some((message: { content: string }) => message.content.includes('"retainedReferenceHistory"')));
  const checks = interventionChecks(records);
  assert.ok(checks.some(check => check.id.endsWith(".replay") && check.status === "pass"), JSON.stringify(checks));
});

test("v22 S4 requires the purpose-based confirm scope in a multipart draft", async () => {
  const first = "切り込みは二つですか？", second = "ふくらみはどの部分ですか？";
  const records = await buildRecords({
    figureCount: 4, dialoguePolicy: "holistic_v5", interventionVersion: "bypass_acceptance_v3",
    judgmentMaterialVersion: "jev_repair_quality_v1", technicalTrial: { version: "adaptive_repair_v3" },
    generationRetryVersion: "jev_generation_retry_v22", agreeNameScopeVersion: "jev_naming_v3",
    turns: [{ human: first + second, plan: {
      action: "confirm", target: "figure_0", act: "ask",
      extraction: JSON.stringify([first, second].map((quote, index) => ({
        segmentId: `s${index}`, quote, targets: [OWN.ownAnchors[index].id], aspect: "question", proposition: quote,
        name: null, linkedIssueId: null, respondsToTurn: null,
      }))),
      speech: JSON.stringify({ parts: ["切り込みどうしはどのようにつながっていますか？", "ふくらみというのは、丸い部分ですか？"]
        .map((text, item) => ({ item, text })), observationFeatures: [] }),
      aiExtraction: JSON.stringify({ segments: [], visualFeatures: { sources: [] } }),
      choose: (key, criteria) => key === "visual_purpose" ? Object.keys(criteria).find(label => label.startsWith("issue_"))
        : key === "extra_0" ? "repair" : key === "human_move_on_source" ? "other" : key === "commitment_state" ? "insufficient" : undefined,
    } }],
  });
  const check = (value: typeof records) => interventionChecks(value).find(check => check.id.endsWith(".replay"));
  assert.equal(check(records)?.status, "pass", JSON.stringify(check(records)));
  for (const side of [records.trials[0].replay[0].result.sides[1], records.evidence.pairedReplay[0].right]) {
    const generation = side.requests.find((request: {phase: string}) => request.phase === "generation");
    const action = generation.payload.messages.find((message: {content: string}) => message.content.startsWith("Jevが選んだ行動だけ"));
    const constraint = "観察メモにない特徴を肯定したり、同じ図形だと断定したりしないでください。";
    assert.ok(action.content.includes(constraint));
    action.content = action.content.replace(constraint, "");
    generation.payloadSha256 = hash(generation.payload);
    generation.preProjectionPayloadSha256 = hash(generation.payload);
    generation.completeMessagesSha256 = hash(generation.payload.messages);
  }
  assert.equal(check(records)?.status, "mismatch");
});

test("v22 S4 rechecks an explicit delayed answer under jev_naming_v3", async () => {
  const figureId = OWN.ownAnchors[0].id;
  const description = "丸い切り込みが見えます。", question = "そちらにも丸い切り込みがありますか？";
  const answer = "はい、こちらの図形にも丸い切り込みがあります。";
  const segment = (segmentId: string, quote: string, targets: string[], respondsToTurn: number | null = null) => ({
    segmentId, quote, targets, respondsToTurn, proposition: quote, aspect: "part", name: null, linkedIssueId: null,
  });
  const accept = { action: "accept", target: "none", speech: "お話は分かりました。" };
  const records = await buildRecords({
    figureCount: 4, dialoguePolicy: "holistic_v5", interventionVersion: "bypass_acceptance_v3",
    judgmentMaterialVersion: "jev_repair_quality_v1", technicalTrial: { version: "adaptive_repair_v3" },
    generationRetryVersion: "jev_generation_retry_v22", agreeNameScopeVersion: "jev_naming_v3",
    turns: [
      { human: "この図形の特徴を確かめたいです。", plan: { action: "confirm", target: "figure_0",
        speech: JSON.stringify({ text: description + question, observationFeatures: [] }),
        aiExtraction: JSON.stringify({ segments: [segment("s0", description, [figureId]), segment("s1", question, [])], visualFeatures: { sources: [] } }),
        aiActs: ["assert", "ask"], choose: key => key === "visual_purpose" ? "unknown" : undefined,
      } },
      { human: "話は分かりました。", plan: accept },
      { human: answer, plan: { ...accept, act: "agree", answers: "unknown", extraction: JSON.stringify([segment("s0", answer, [figureId], 2)]),
        choose: (key, criteria) => key.endsWith("_antecedent") ? Object.keys(criteria).find(label => criteria[label].includes('"3:pub2"')) : undefined,
      } },
    ],
  });
  const claim = records.trials[0].attempts[0].local.claims.find((entry: {quote: string}) => entry.quote === answer);
  assert.deepEqual([claim?.act, claim?.targets, claim?.respondsTo, claim?.source], ["agree", [figureId], "3:pub2", "partner_statement"]);
  const check = interventionChecks(records).find(item => item.id.endsWith(".replay"));
  assert.equal(check?.status, "pass", JSON.stringify(check));
});
