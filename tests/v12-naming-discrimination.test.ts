import assert from "node:assert/strict";
import test from "node:test";
import { contrastFeatures } from "../dialogue-model/runtime/decision/naming-discrimination.ts";
import { interventionForStrategy } from "../dialogue-model/runtime/decision/bypass-acceptance.ts";
import { validateJevPrivateStateV2 } from "../dialogue-model/runtime/v2/jev-turn.ts";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import type { LocalSegmentProposal } from "../dialogue-model/runtime/local-grounding/contract.ts";
import type { ObservationMemo } from "../dialogue-model/runtime/observation/contract.ts";
import { buildRecords, OLD, OWN, runTurn, type Label, type Turn } from "./support/s4-v3-records.ts";

const slots: string[] = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
const [own, other] = slots;
const common = "穴がある";
const property = "突起が一つ";
const explanationFor = (feature: string) => `こちらでは、${feature}という特徴が見えます。`;
const questionFor = (feature: string) => `そちらの図形も、${feature}という特徴がありますか？`;
const explanation = explanationFor(property);
const question = questionFor(property);
const ordinaryStatement = "穴があります。";
const ordinaryQuestion = "そちらの図形にも穴がありますか？";
const denial = "いいえ、その図形ではありません。";
const oldName = "音符";
const name = "くぎ";
const original = "「音符」と呼びませんか。";
const proposal = "呼び名を変えて、「くぎ」にしませんか？";
const namedSubject = "この図形を「くぎ」と呼びませんか？";
const firstCount = "突起は一つです。";
const correctedCount = "突起は二つです。";
const identity = "私が見ている図形と同じです。";
const featureReply = "一つです。";
const agreement = "はい、「くぎ」と呼びましょう。";

function observation(source: "count" | "contradiction" | "common" = "count", feature = property): ObservationMemo {
  const memo = structuredClone(OLD.state.observationMemo) as ObservationMemo;
  for (const f of memo.figures) {
    f.analytic.shapes = source === "common" ? [common] : f.id === own ? [common, feature] :
      source === "count" ? [common, "突起が二つ"] : [common];
    f.reobservations = f.id === own || source !== "contradiction" ? [] : [{
      observedAt: memo.observedAt, issue: { aspect: "part", question: "突起が一つか", partnerConstrual: null },
      figureId: f.id, supports: [], contradicts: [property], unknown: [],
    }];
  }
  return memo;
}

function segment(segmentId: string, quote: string, aspect: LocalSegmentProposal["aspect"], targets: string[],
  respondsToTurn: number | null = null, proposition = quote, label: string | null = null): LocalSegmentProposal {
  return { segmentId, quote, aspect, targets, respondsToTurn, proposition, name: label, linkedIssueId: null };
}
const extraction = (...segments: LocalSegmentProposal[]) => JSON.stringify(segments);
const antecedent = (choices: Readonly<Record<string, string>>, id: string) =>
  Object.entries(choices).find(([, text]) => text.includes(id))?.[0];

function replayStatus(records: Awaited<ReturnType<typeof buildRecords>>) {
  return verifyRecords(records).checks.filter(c => c.id.startsWith("intervention.trial.0.attempt.0.")).map(c => c.status);
}

const opening: Turn = { human: original, plan: {
  action: "confirm", target: "figure_0", referent: "figure_0", speech: ordinaryStatement + ordinaryQuestion,
  act: "name_propose", aiActs: ["assert", "ask"],
  extraction: extraction(segment("name", original, "name", [own], null, original, oldName)),
  aiExtraction: extraction(segment("part", ordinaryStatement, "part", [own]), segment("check", ordinaryQuestion, "question", [own])),
} };

function deniedCheck(requireContrast = true, feature = property): Turn {
  const explanation = explanationFor(feature), question = questionFor(feature);
  return { human: denial, plan: {
    action: "confirm", target: "figure_0", referent: "figure_0", speech: explanation + question,
    act: "deny", answers: "not_an_answer", aiActs: ["assert", "ask"],
    extraction: extraction(segment("denial", denial, "question", [own], 2)),
    aiExtraction: extraction(segment("part", explanation, "part", [own]), segment("check", question, "question", [own])),
    choose: (key, choices) => {
      if (key === "segment_0_antecedent") return antecedent(choices, "3:pub2");
      if (key === "feature") {
        if (requireContrast) assert.ok(!Object.values(choices).some(c => JSON.parse(c).value === common));
        return Object.entries(choices).find(([, c]) => JSON.parse(c).value === feature)?.[0];
      }
    },
  } };
}

type Answer = "identity" | "both" | "feature" | "wrong" | "explicit-count" |
  "other-part" | "other-topic" | "negative-identity" | "uncertain-identity" | "clipped-negation" |
  "corrected-count" | "named-subject";
function answer(form: Answer): Turn {
  const positive = form === "identity" || form === "explicit-count" || form === "named-subject";
  const response = ({
    wrong: "穴があります。",
    "corrected-count": firstCount + "訂正します。" + correctedCount,
    "explicit-count": "突起は１つあります。",
    "other-part": "数えたのは穴です。穴は一つです。",
    "other-topic": "穴を数えました。一つです。",
  } as Partial<Record<Answer, string>>)[form] ?? featureReply;
  const quotedValue = form === "corrected-count" ? firstCount : form === "other-part" || form === "other-topic" ? featureReply : response;
  const naming = form === "named-subject" ? namedSubject : proposal;
  const identityText = ({
    "negative-identity": "私が見ている図形と同じではありません。",
    "uncertain-identity": "同じ図形かは分かりません。",
    "clipped-negation": "同じ図形ではありません。",
  } as Partial<Record<Answer, string>>)[form] ?? identity;
  const quotedIdentity = form === "clipped-negation" ? "同じ図形" : identityText;
  const referent = form === "feature" ? [] : [segment("identity", quotedIdentity, "referent", form === "both" ? [own, other] : [own], 4)];
  const segments = [
    segment("feature", quotedValue, "contour", [own], 4, property),
    ...(form === "corrected-count" ? [segment("correction", correctedCount, "contour", [own])] : []),
    ...referent,
    segment("name", naming, "name", [own], null, naming, name),
  ];
  return { human: response + (referent.length ? identityText : "") + naming, plan: {
    action: positive ? "agree" : "close", target: "figure_0", referent: "figure_0", speech: positive ? agreement : "その特徴について聞きました。",
    answers: "answers_checked_point",
    extraction: extraction(...segments),
    choose: (key, choices) => {
      const part = /^segment_(\d+)_(act|antecedent)$/u.exec(key);
      if (part) {
        const id = segments[Number(part[1])]?.segmentId;
        if (part[2] === "act") {
          const act = id === "name" ? "name_propose" : id === "correction" ? "assert" : "agree";
          if (Object.hasOwn(choices, act)) return act;
        }
        if (part[2] === "antecedent" && (id === "feature" || id === "identity")) {
          return antecedent(choices, id === "feature" ? "5:pub2" : "5:pub1");
        }
      }
      // A naming request cannot choose accept. Non-agreement on a different
      // topic is available to both strategies without an extra visual check.
      if (key === "action" && !positive) {
        assert.equal(Object.hasOwn(choices, "agree"), false);
        return "close";
      }
      if (key === "target" && !positive) return "none";
    },
  } };
}
const v5 = { dialoguePolicy: "holistic_v5", generationRetryVersion: "jev_generation_retry_v12",
  agreeNameScopeVersion: "scoped_v12", technicalTrial: { version: "adaptive_repair_v3" } } as const;

test("a naming contrast requires explicit, non-conflicting observations across the original candidate pool", () => {
  assert.deepEqual(contrastFeatures(observation("count"), slots, own), [property]);
  const memo = observation("contradiction");
  assert.deepEqual(contrastFeatures(memo, slots, own), [property]);
  const rival = memo.figures.find(f => f.id === other)!;
  rival.reobservations[0].unknown.push(property);
  assert.deepEqual(contrastFeatures(memo, slots, own), []);
  rival.reobservations[0].unknown = [];
  rival.analytic.shapes.push(property);
  assert.deepEqual(contrastFeatures(memo, slots, own), []);
  rival.analytic.shapes.pop();
  rival.reobservations = [];
  assert.deepEqual(contrastFeatures(memo, slots, own), []);
  assert.deepEqual(contrastFeatures(memo, [own], own), []);
  const counted = observation();
  const countedRival = counted.figures.find(f => f.id === other)!;
  const detail = { observedAt: counted.observedAt, issue: { aspect: "part" as const, question: "突起が二つか", partnerConstrual: null },
    figureId: other, supports: [], contradicts: ["突起は２つある"], unknown: [] };
  countedRival.reobservations = [detail];
  assert.deepEqual(contrastFeatures(counted, slots, own), []);
  countedRival.reobservations = [{ ...detail, contradicts: [], unknown: ["突起が二つある"] }];
  assert.deepEqual(contrastFeatures(counted, slots, own), []);
  countedRival.reobservations = [{ ...detail, contradicts: [property], unknown: ["突起が二つある"] }];
  assert.deepEqual(contrastFeatures(counted, slots, own), [property]);
});

for (const label of ["repair-first", "bypass-enabled"] as const satisfies readonly Label[]) {
  test(`naming v5 publishes and preserves a discriminatory renaming in ${label}`, async () => {
    const outcomes: Awaited<ReturnType<typeof runTurn>>[] = [];
    const records = await buildRecords({ ...v5, label, memo: observation(), turns: [opening, deniedCheck(), answer("identity")],
      onTurn: (side, outcome) => { if (side === label) outcomes.push(outcome); },
    });
    const [, check, result] = outcomes;
    assert.deepEqual(check.state.namingDenials, { [own]: 3 });
    assert.equal(check.state.judgments.at(-1).jevTurn.executed.feature, property);
    assert.equal(check.speech, explanation + question);
    assert.equal(check.luna.some(call => call.phase === "generation"), false);
    assert.equal(check.reobservations.length, 0);
    assert.equal(result.publication.status, "committed");
    assert.equal(result.speech, agreement);
    assert.deepEqual(result.state.judgments.at(-1).jevTurn.agreeNames, [{ name, figureId: own, sourceTurn: 5 }]);
    assert.deepEqual(result.state.ledger[own], { status: "agreed", name });
    assert.deepEqual(result.state.namingDenials, {});
    const restored = validateJevPrivateStateV2(JSON.parse(JSON.stringify(result.state)), slots, interventionForStrategy(label),
      "two_stage_v3", v5.dialoguePolicy, v5.generationRetryVersion);
    assert.deepEqual(restored.ledger[own], { status: "agreed", name });
    assert.deepEqual(replayStatus(records), ["pass", "pass", "pass", "pass"]);

    // Keep the true request stream and agreement, but substitute an ambiguous
    // extraction for the identity clause that made its naming source lawful.
    const forged = structuredClone(records);
    const attempt = forged.trials[0].attempts[0];
    attempt.local.extractor.segments.find((item: LocalSegmentProposal) => item.aspect === "referent").targets = [own, other];
    forged.trials[0].turns[0].trace = [structuredClone(attempt)];
    assert.equal(replayStatus(forged).at(-1), "mismatch");
  });
}

for (const label of ["repair-first", "bypass-enabled"] as const) {
  for (const form of ["identity", "explicit-count", "named-subject"] as const) {
    test(`naming v5 accepts ${form} in ${label}`, async () => {
      const outcomes: Awaited<ReturnType<typeof runTurn>>[] = [];
      const feature = form === "named-subject" ? property : "突起が一つある";
      const records = await buildRecords({ ...v5, label, memo: observation("count", feature),
        turns: [opening, deniedCheck(true, feature), answer(form)],
        onTurn: (side, outcome) => { if (side === label) outcomes.push(outcome); },
      });
      const [, check, agreed] = outcomes;
      assert.equal(check.speech, explanationFor(feature) + questionFor(feature));
      assert.equal(agreed.publication.status, "committed");
      assert.equal(agreed.speech, agreement);
      assert.deepEqual(agreed.state.ledger[own], { status: "agreed", name });
      assert.deepEqual(agreed.state.judgments.at(-1).jevTurn.agreeNames, [{ name, figureId: own, sourceTurn: 5 }]);
      assert.deepEqual(replayStatus(records), ["pass", "pass", "pass", "pass"]);
    });
  }

  test(`naming v5 cannot publish a check based on a contradicted rival count in ${label}`, async () => {
    const memo = observation();
    memo.figures[1].reobservations = [{
      observedAt: memo.observedAt, issue: { aspect: "part", question: "突起はいくつか", partnerConstrual: null },
      figureId: other, supports: [], contradicts: ["突起が二つある"], unknown: [],
    }];
    const turn = deniedCheck();
    turn.plan = { ...turn.plan, action: "confirm", target: "figure_1", speech: "別の図形にも穴がありますか？",
      aiActs: undefined, aiExtraction: undefined,
      choose: (key, choices) => {
        if (key === "segment_0_antecedent") return antecedent(choices, "3:pub2");
        if (key === "target") assert.equal(Object.hasOwn(choices, "figure_0"), false);
      } };
    const outcomes: Awaited<ReturnType<typeof runTurn>>[] = [];
    const records = await buildRecords({ ...v5, label, memo, turns: [opening, turn],
      onTurn: (side, outcome) => { if (side === label) outcomes.push(outcome); },
    });
    const result = outcomes.at(-1)!;
    assert.equal(result.publication.status, "committed");
    assert.equal(result.speech, turn.plan.speech);
    assert.deepEqual(result.state.judgments.at(-1).jevTurn.executed.target, { kind: "single", figureId: other });
    assert.deepEqual(result.state.ledger[own], { status: "unassigned", name: null });
    assert.deepEqual(result.state.judgments.at(-1).jevTurn.agreeNames, []);
    assert.deepEqual(replayStatus(records), ["pass", "pass", "pass", "pass"]);
  });

  test(`naming v5 records a published contrast with no extra sends in ${label}`, async () => {
    const outcomes: Awaited<ReturnType<typeof runTurn>>[] = [];
    const records = await buildRecords({ ...v5, label, memo: observation(), turns: [opening, deniedCheck()],
      onTurn: (side, outcome) => { if (side === label) outcomes.push(outcome); },
    });
    const [before, check] = outcomes;
    const oldState = structuredClone(before.state);
    delete oldState.namingDenials;
    oldState.agreeNameScopeVersion = "scoped_v11";
    const old = await runTurn(records.trials[0].profile, label, oldState, records.trials[0].replay[0].tape.events,
      deniedCheck(false).plan, v5.technicalTrial, v5.generationRetryVersion);
    assert.equal(old.speech, check.speech);
    assert.deepEqual(check.luna.map(call => call.phase), old.luna.map(call => call.phase).filter(phase => phase !== "generation"));
    assert.deepEqual(check.jev.map(call => Object.keys(call.answers)), old.jev.map(call => Object.keys(call.answers)));
    assert.equal(check.httpBodies.length, old.httpBodies.length - 1);
    assert.deepEqual(replayStatus(records), ["pass", "pass", "pass", "pass"]);
  });

  for (const form of ["both", "feature", "wrong", "other-part", "other-topic", "negative-identity", "uncertain-identity", "clipped-negation", "corrected-count"] as const) {
    test(`naming v5 holds the name after a ${form} response in ${label}`, async () => {
      const outcomes: Awaited<ReturnType<typeof runTurn>>[] = [];
      const records = await buildRecords({ ...v5, label, memo: observation(), turns: [opening, deniedCheck(), answer(form)],
        onTurn: (side, outcome) => { if (side === label) outcomes.push(outcome); },
      });
      const result = outcomes.at(-1)!;
      assert.equal(result.publication.status, "committed");
      if (form === "corrected-count") {
        assert.deepEqual(result.trace.local?.claims.filter(c => c.quote === firstCount || c.quote === correctedCount).map(c => [c.act, c.quote, c.targets]),
          [["agree", firstCount, [own]], ["assert", correctedCount, [own]]]);
      }
      assert.equal(result.state.judgments.at(-1).jevTurn.executed.action, "close");
      assert.equal(result.speech, "その特徴について聞きました。");
      assert.deepEqual(result.state.judgments.at(-1).jevTurn.agreeNames, []);
      assert.deepEqual(result.state.ledger[own], { status: "unassigned", name: null });
      assert.deepEqual(result.state.namingDenials, { [own]: 3 });
      assert.deepEqual(replayStatus(records), ["pass", "pass", "pass", "pass"]);
    });
  }

  test(`naming v5 keeps a rejected local denial and can continue without a common check in ${label}`, async () => {
    const outcomes: Awaited<ReturnType<typeof runTurn>>[] = [];
    const turn: Turn = { human: denial, plan: {
      action: "accept", target: "figure_0", speech: "どの図形か、まだ確かめられていません。",
      act: "deny", answers: "not_an_answer",
      extraction: extraction(segment("denial", denial, "contour", [other], 2)),
      choose: (key, choices) => {
        if (key === "segment_0_antecedent") return antecedent(choices, "3:pub1");
      },
    } };
    const records = await buildRecords({ ...v5, label, memo: observation("common"), turns: [opening, turn],
      onTurn: (side, outcome) => { if (side === label) outcomes.push(outcome); },
    });
    const result = outcomes.at(-1)!;
    assert.ok(result.trace.local?.verification.rejected.some(item => item.reason === "inconsistent_claim_response"));
    assert.ok(!result.trace.local?.claims.some(item => item.act === "deny"));
    assert.equal(result.state.judgments.at(-1).jevTurn.executed.action, "accept");
    assert.equal(result.publication.status, "committed");
    assert.deepEqual(result.state.namingDenials, { [own]: 3 });
    assert.deepEqual(result.state.ledger[own], { status: "unassigned", name: null });
    assert.deepEqual(result.reobservations, []);
    assert.deepEqual(replayStatus(records), ["pass", "pass", "pass", "pass"]);
  });
}
