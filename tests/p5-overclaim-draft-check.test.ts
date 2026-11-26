// The producer and replay go through their normal paths with only synthetic upstreams.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Label, Plan, Turn } from "./support/s4-v3-records.ts";
import { hash } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { RunBudget, promptSourceManifest } from "../dialogue-model/runtime/diagnostics/parity-live/audit.ts";
import { defaultGenerationRetryVersion, isGenerationV14, validGenerationRetryVersion } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { validJevSharedConstrualTrace } from "../dialogue-model/runtime/v2/jev-turn.ts";
import { researchHash } from "../dialogue-model/runtime/v2/research-profile.ts";
import { selectParticipantJev } from "../dialogue-model/runtime/web/participant-jev-wiring.ts";

// Only this isolated test opts the existing synthetic harness into the new client capability.
const supportUrl = new URL("./support/s4-v3-records.ts", import.meta.url).href;
const hook = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== supportUrl) return result;
    const old = "classifyDraftAct: (i: any, o: any) => native.classifyDraftAct!(i, o)";
    const source = String(result.source);
    assert.equal(source.split(old).length, 2);
    return { ...result, source: source.replace(old,
      old + ", classifyDraftSharedClaim: (i: any, o: any) => native.classifyDraftSharedClaim!(i, o)") };
  },
});
const { buildRecords, OWN, runTurn } = await import("./support/s4-v3-records.ts").finally(() => hook.deregister());

const conditions = ["repair-first", "bypass-enabled"] as const;
const [left, right] = OWN.ownAnchors.map((a: { id: string }) => a.id) as [string, string];
const sail = "帆";
const detail = "切れ込みの形";
const looseEnd = "切れ込みの形はまだ照合できていません。";
const useSail = "その見立ては共通の目印になります。" + looseEnd;
const safeNegation = "その見立てを目印にしましょう。細部まで同じではありません。";
const singleOverclaim = "これで両方が見ている図形は一つに特定できました。";
const singleOverclaimAlt = "もう候補は残っていません。そちらと私が指しているのは一つの同じ図形です。";
const detailOverclaim = "切れ目の形は二人の図形で完全に一致しています。";
const detailOverclaimAlt = "お互いの切れ込みを比べ終えました。あの部分に差はありません。";
const request = "その見立てを目印に、次の特徴を話せますか？";
const v12 = "jev_generation_retry_v12" as const;
const v13 = "jev_generation_retry_v13" as const;
const v14 = "jev_generation_retry_v14" as const;
const technicalTrial = { version: "adaptive_repair_v3" } as const;
const promptSources = await promptSourceManifest();

function segment(
  quote: string,
  targets: string[],
  proposition: string,
  respondsToTurn: number | null = null,
  linkedIssueId: string | null = null,
  aspect = "construal",
  name: string | null = null,
) {
  return JSON.stringify([{ segmentId: "s1", quote, targets, proposition, respondsToTurn, linkedIssueId, aspect, name }]);
}

function responseTo(claimId: string): Plan["choose"] {
  return (key, criteria) => key.endsWith("_antecedent")
    ? Object.entries(criteria).find(([, description]) => description.includes(JSON.stringify(claimId)))?.[0] ?? "none"
    : undefined;
}

function neutral(speech = "そう見えるんですね。", target = "figure_0"): Plan {
  return { action: "accept", target, referent: target.startsWith("figures_") ? "multiple" : target, speech };
}

function humanFirst(targets = [left], target = "figure_0", reading = sail): Turn {
  const human = `私には大まかに${reading}に見えます。`;
  const ai = `こちらでも大まかには${reading}に見えます。`;
  return {
    human,
    plan: {
      ...neutral(ai, target),
      extraction: segment(human, targets, reading),
      act: "construe",
      aiExtraction: segment(ai, targets, reading, 1),
      aiActs: ["agree"],
      choose: responseTo("1:local1"),
    },
  };
}

function aiFirst({ targets = [left], target = "figure_0", reading = sail, start = 1 }: {
  targets?: string[]; target?: string; reading?: string; start?: number;
} = {}): Turn[] {
  const ai = `私の側では大まかに${reading}に見えます。`;
  const human = `こちらでも大まかに${reading}に見える点は同意します。`;
  return [
    {
      human: "どんな全体の形に見えますか？",
      plan: { ...neutral(ai, target), aiExtraction: segment(ai, targets, reading), aiActs: ["construe"] },
    },
    {
      human,
      plan: {
        ...neutral(undefined, target),
        act: "agree",
        extraction: segment(human, targets, reading, start + 1),
        choose: responseTo(`${start + 2}:pub1`),
      },
    },
  ];
}

function unresolved(targets = [left], target = "figure_0"): Turn {
  const human = "切れ込みの形はどんな形ですか？";
  return {
    human,
    plan: { ...neutral(looseEnd, target), act: "ask", extraction: segment(human, targets, detail, null, null, "contour") },
  };
}

type Candidate = { construal: string; figureIds: string[]; claimIds: string[] };
function candidates(criteria: Readonly<Record<string, string>>) {
  return Object.entries(criteria).filter(([key]) => key !== "none").map(([key, value]) =>
    ({ key, ...JSON.parse(value) as Candidate }));
}

function finish(speech = useSail, reading = sail, target = "figure_0", chooseUse = true, extra?: Plan["choose"]): Turn {
  return {
    human: request,
    plan: {
      ...neutral(speech, target),
      choose: (key, criteria, context) => {
        if (key === "shared_construal") {
          return (chooseUse ? candidates(criteria).find(c => c.construal === reading)?.key : "none") ?? "none";
        }
        return extra?.(key, criteria, context);
      },
    },
  };
}

async function runWithVersion(label: Label, turns: Turn[], generationRetryVersion: typeof v12 | typeof v13 | typeof v14) {
  const outcomes: Record<Label, Awaited<ReturnType<typeof runTurn>>[]> = { "repair-first": [], "bypass-enabled": [] };
  const records = await buildRecords({
    label,
    turns,
    dialoguePolicy: "holistic_v5",
    generationRetryVersion,
    technicalTrial,
    promptSources,
    onTurn: (side, outcome) => outcomes[side].push(outcome),
  });
  return { records, outcomes };
}

function assertS4Pass(records: Awaited<ReturnType<typeof runWithVersion>>["records"]) {
  const checks = verifyRecords(records).checks.filter(c => c.id.startsWith("intervention.trial.0.attempt.0."));
  assert.ok(checks.some(c => c.id.endsWith(".replay")));
  assert.ok(checks.every(c => c.status === "pass"), JSON.stringify(checks));
}

test("distinct overclaim verdicts trigger targeted rewrites, stop with unsafe_generation on repeat, and pass S4 in both strategies", async () => {
  const targets = [left, right], target = "figures_0_1";
  const prior = [...aiFirst({ targets, target }), unresolved(targets, target)];

  const cases = [
    { draft: singleOverclaim, choice: "single_identification_claimed" as const, code: "draft_shared_claim_single_id", repeat: singleOverclaimAlt },
    { draft: detailOverclaim, choice: "unconfirmed_detail_claimed" as const, code: "draft_shared_claim_unconfirmed_detail", repeat: detailOverclaimAlt },
  ];

  for (const { draft, choice, code, repeat } of cases) {
    const rewritePayloads: Record<Label, string> = { "repair-first": "", "bypass-enabled": "" };
    const rewriteJevPosts: Record<Label, number> = { "repair-first": 0, "bypass-enabled": 0 };

    for (const label of conditions) {
      const turn = finish(safeNegation, sail, target, true, (key, _criteria, context) =>
        key === "draft_shared_claim" ? (context.generationCalls === 1 ? choice : "none") : undefined);
      turn.plan.drafts = [draft, safeNegation];

      const run = await runWithVersion(label, [...prior, turn], v14);
      assertS4Pass(run.records);
      const outcome = run.outcomes[label].at(-1)!;
      assert.equal(outcome.speech, safeNegation);
      assert.equal(outcome.trace.generationGuard.regenerated, true);
      assert.deepEqual(outcome.trace.generationGuard.violations, [code]);
      assert.equal(outcome.trace.draftSharedClaims?.length, 2);
      assert.deepEqual(outcome.trace.draftSharedClaims?.map(r => [r.draft, r.status, r.choice]), [
        ["initial", "ok", choice],
        ["retry", "ok", "none"],
      ]);
      assert.deepEqual(outcome.state.judgments.at(-1).jevTurn.draftSharedClaims, outcome.trace.draftSharedClaims);

      const side = run.records.trials[0].replay[0].result.sides.find((s: { label: Label }) => s.label === label)!;
      const checkRequests = side.requests.filter((r: { phase: string }) => r.phase === "draft_shared_claim");
      assert.equal(checkRequests.length, 2);
      rewritePayloads[label] = hash(checkRequests.map((r: { payload: unknown }) => r.payload));
      rewriteJevPosts[label] = outcome.jev.length;

      // Repeated overclaim stops with existing unsafe_generation error, leaving state untouched.
      const before = run.records.trials[0].replay[0].tape.state;
      const events = run.records.trials[0].replay[0].tape.events;
      const stopPlan: Plan = {
        ...turn.plan,
        drafts: [draft, repeat],
        choose: (key, criteria, context) => key === "draft_shared_claim" ? choice : turn.plan.choose!(key, criteria, context),
      };
      await assert.rejects(
        runTurn(run.records.trials[0].profile, label, structuredClone(before), events, stopPlan, technicalTrial, v14),
        (err: any) => {
          assert.equal(err.code, "unsafe_generation");
          const trace = err.traces.at(-1);
          assert.equal(trace.publicSpeech, null);
          assert.equal(trace.status, "error");
          assert.ok(validJevSharedConstrualTrace(trace, Object.keys(before.ledger), v14));
          assert.equal(trace.generationGuard.regenerated, true);
          assert.equal(trace.generationGuard.fallback, false);
          assert.deepEqual(trace.generationGuard.violations, [code]);
          assert.deepEqual(trace.draftSharedClaims?.map((r: any) => [r.draft, r.status, r.choice]), [
            ["initial", "ok", choice],
            ["retry", "ok", choice],
          ]);
          assert.deepEqual(err.publication.durable.privateState, before);
          return true;
        },
      );
    }

    // Strategy parity: identical payloads and identical POST count across both strategies.
    assert.equal(rewritePayloads["repair-first"], rewritePayloads["bypass-enabled"]);
    assert.equal(rewriteJevPosts["repair-first"], rewriteJevPosts["bypass-enabled"]);
  }
});


test("qualifying drafts keep a negation, an open detail and a genuine single identification", async () => {
  const targets = [left, right], target = "figures_0_1";
  const pair = [...aiFirst({ targets, target }), unresolved(targets, target)];
  for (const label of conditions) {
    const samples: { prior: Turn[]; target: string; speech: string; choice: string }[] = [
      { prior: pair, target, speech: safeNegation, choice: "none" },
      { prior: pair, target, speech: useSail, choice: "none" },
      { prior: [humanFirst()], target: "figure_0", speech: "この一つの図形を目印にしましょう。", choice: "single_identification_claimed" },
    ];
    for (const sample of samples) {
      const turn = finish(sample.speech, sail, sample.target, true, key => key === "draft_shared_claim" ? sample.choice : undefined);
      const { records, outcomes } = await runWithVersion(label, [...sample.prior, turn], v14);
      assertS4Pass(records);
      const outcome = outcomes[label].at(-1)!;
      assert.equal(outcome.speech, sample.speech);
      assert.equal(outcome.trace.generationGuard.regenerated, false);
      assert.deepEqual(outcome.trace.generationGuard.violations, []);
      assert.deepEqual(outcome.trace.draftSharedClaims?.map(check => check.choice), [sample.choice]);
      if (sample.target === target) assert.equal(outcome.trace.sharedConstruals?.[0].openDetails[0].proposition, detail);
    }
  }
});

test("v14 is explicit and the default-off versions keep their HTTP bytes", async () => {
  assert.equal(defaultGenerationRetryVersion("two_stage_v3", "holistic_v5"), v12);
  assert.equal(isGenerationV14(v13), false);
  assert.equal(validGenerationRetryVersion(v14, "two_stage_v3", "holistic_v5"), true);
  assert.equal(validGenerationRetryVersion(v14, "two_stage_v3", "holistic_v4"), false);
  assert.equal(validGenerationRetryVersion(v14, "two_stage_v1", "holistic_v5"), false);
  // 228c0b9, hash of the ordered provider and SHA-256 of each raw POST body.
  const baseline = {
    [v12]: "5b240884ecae924f39fb1f54d32a6cc9507595307dad65b54af8222fe7d76ef0",
    [v13]: "b71f9494aa5ed0cde9d5ef858eaf907077682591ed2bd9f22b348b2ecefffd96",
  };
  const targets = [left, right], target = "figures_0_1";
  const pair = [...aiFirst({ targets, target }), unresolved(targets, target)];
  const adopted = [...pair, finish(safeNegation, sail, target)];
  const acceptedPosts = [];
  for (const label of conditions) {
    for (const version of [v12, v13]) {
      const { records, outcomes } = await runWithVersion(label, adopted, version);
      assertS4Pass(records);
      assert.equal(hash(outcomes[label].flatMap(turn => turn.httpBodies)), baseline[version]);
      assert.equal(outcomes[label].at(-1)!.trace.draftSharedClaims, undefined);
    }
    const { records, outcomes } = await runWithVersion(label, adopted, v14);
    assertS4Pass(records);
    const outcome = outcomes[label].at(-1)!;
    assert.ok(outcome.trace.executed.sharedClaimIds);
    assert.equal(outcome.trace.draftSharedClaims?.length, 1);
    acceptedPosts.push(outcome.jev.length);
    const attempt = records.trials[0].attempts[0];
    assert.equal(validJevSharedConstrualTrace(attempt, Object.keys(outcome.state.ledger), v13), false);
    const missing = structuredClone(records);
    const miss = missing.trials[0];
    for (const copy of [miss.attempts[0], miss.turns[0].trace[0],
      miss.turns[0].state.judgments.at(-1).jevTurn, miss.lastCommittedState.judgments.at(-1).jevTurn]) {
      delete copy.draftSharedClaims;
    }
    assert.equal(verifyRecords(missing).checks.find(c => c.id === "intervention.trial.0.attempt.0.shape")?.status, "mismatch");

    const declined = await runWithVersion(label, [...pair, finish(safeNegation, sail, target, false)], v14);
    assertS4Pass(declined.records);
    const trace = declined.outcomes[label].at(-1)!.trace;
    assert.equal(trace.executed.sharedClaimIds, undefined);
    assert.equal(trace.draftSharedClaims, undefined);
  }
  assert.deepEqual(acceptedPosts, [6, 6]); // Both had five Jev POSTs on the same v13 turn.
});

test("an unavailable check never publishes an unchecked adoption draft", async () => {
  const target = "figures_0_1", targets = [left, right], label = "repair-first";
  const final = finish(safeNegation, sail, target);
  const base = await runWithVersion(label,
    [...aiFirst({ targets, target }), unresolved(targets, target), final], v13);
  const trial = base.records.trials[0], { tape } = trial.replay[0];
  const drafts = [safeNegation, useSail];
  await assert.rejects(runTurn(trial.profile, label, tape.state, tape.events, {
    ...final.plan, drafts, failQuestion: "draft_shared_claim",
  }, technicalTrial, v14), (error: any) => {
    const trace = error.traces.at(-1);
    assert.equal(error.code, "unsafe_generation");
    assert.equal(trace.publicSpeech, null);
    assert.deepEqual(trace.generationGuard.violations, ["draft_shared_claim_unconfirmed"]);
    assert.deepEqual(trace.draftSharedClaims.map((check: any) => check.status), ["error", "error"]);
    assert.deepEqual(error.drafts, drafts);
    assert.equal(error.publication.status, "error");
    assert.deepEqual(error.publication.durable.privateState, tape.state);
    return true;
  });
});

test("the semantic stage follows the executed adoption and coexists with the naming stage", async () => {
  for (const label of conditions) {
    const veto = finish(useSail);
    Object.assign(veto.plan, { action: "defer", actionScores: { defer: 1, accept: 0.9 },
      speechByLabel: { "bypass-enabled": "その点はいったん保留にしましょう。" } });
    const routed = await runWithVersion(label, [...aiFirst(), veto], v14);
    assertS4Pass(routed.records);
    const requests = (side: { requests: { phase: string }[] }) =>
      side.requests.filter(request => request.phase === "draft_shared_claim").length;
    assert.deepEqual(routed.records.trials[0].replay[0].result.sides.map(requests), [1, 0]);

    const speech = "その見立ては目印にできます。羽と呼びたいのは、切れ込みのある形ですか？";
    const confirm = finish(speech);
    confirm.human = "この図形を「羽」と呼びませんか？";
    Object.assign(confirm.plan, { action: "confirm", act: "name_propose",
      extraction: segment(confirm.human, [], "羽という名前の提案", null, null, "name", "羽") });
    const named = await runWithVersion(label, [...aiFirst(), confirm], v14);
    assertS4Pass(named.records);
    const end = named.outcomes[label].at(-1)!;
    assert.equal(end.trace.executed.action, "confirm");
    assert.equal(end.trace.draftActs?.length, 1);
    assert.equal(end.trace.draftSharedClaims?.length, 1);
    assert.equal(end.speech, speech);
  }
});

for (const label of conditions) {
  test(label + " refuses a singleton overclaim after narrowing an ambiguous shared candidate", async () => {
    for (const { targets, target, referent } of [
      { targets: [left, right], target: "figures_0_1", referent: "multiple" },
      { targets: [left, right], target: "figures_0_1", referent: "figure_0" },
      { targets: [left], target: "figure_0", referent: "multiple" },
    ]) {
      const prior = [...aiFirst({ targets, target }), unresolved(targets, target)];
      const last = finish(safeNegation, sail, "figure_0", true, (key, _, context) =>
        key === "draft_shared_claim" ? context.generationCalls === 1 ? "single_identification_claimed" : "none" : undefined);
      last.plan.referent = referent;
      last.plan.drafts = [singleOverclaim, safeNegation];
      const { records, outcomes } = await runWithVersion(label, [...prior, last], v14);
      const outcome = outcomes[label].at(-1)!;
      assert.deepEqual(outcome.trace.executed.target, { kind: "single", figureId: left });
      assert.equal(outcome.trace.humanReferent?.scores?.[referent === "multiple" ? "multiple" : left], 1);
      assert.deepEqual(outcome.trace.sharedConstruals?.[0].figureIds, targets);
      assert.equal(outcome.speech, safeNegation);
      assert.deepEqual(outcome.trace.generationGuard.violations, ["draft_shared_claim_single_id"]);
      assertS4Pass(records);
    }
  });
}

for (const label of conditions) {
  test(label + " S4 and cold restore reject missing or changed checks on a stopped adoption", async () => {
    const target = "figures_0_1", targets = [left, right];
    const turn = finish(safeNegation, sail, target);
    const { records } = await runWithVersion(label, [...aiFirst({ targets, target }), turn], v14);
    const trial = records.trials[0], { tape } = trial.replay[0], { profile } = trial;
    const choose = turn.plan.choose!;
    let trace: any;
    await assert.rejects(runTurn(profile, label, tape.state, tape.events, {
      ...turn.plan, drafts: [singleOverclaim, singleOverclaimAlt],
      choose: (key, criteria, context) => key === "draft_shared_claim" ? "single_identification_claimed" : choose(key, criteria, context),
    }, technicalTrial, v14), (error: any) => {
      trace = error.traces.at(-1);
      return error.code === "unsafe_generation";
    });
    assert.equal(trace.draftSharedClaims.length, 2);
    trial.attempts = [trace];
    trial.turns = [{ ...trial.turns[0], trace: [structuredClone(trace)], state: structuredClone(tape.state), publicText: null }];
    trial.lastCommittedState = tape.state;
    trial.calls = [];
    trial.http = [];
    trial.replay = [];
    records.evidence.pairedReplay = [];
    const shapeBinding = (input: typeof records) => verifyRecords(input).checks
      .filter(check => /^intervention\.trial\.0\.attempt\.0\.(shape|binding)$/.test(check.id)).map(check => check.status);
    const options = { profile, generationRetryVersion: v14, technicalTrial,
      observer: { observeAll() {}, reobserve() {} }, jevDecision: { decide() {} },
      localGrounding: { classifier: { classify() {} }, aiPublicClaims: true, timeoutMs: profile.timeouts.localMs },
      ledger: new RunBudget({ lunaCalls: 5, lunaPosts: 5, lunaTokens: 1000, jevPosts: 10, jevUsd: 0.05 }),
    };
    const context = { referenceMemory: true, strategy: label, style: profile.utteranceStyle, legacy: [] };
    const restore = (attempt: any) => selectParticipantJev({
      options: { jevResearch: true, profileSha256: researchHash(profile), interventionPolicy: profile.interventionPolicy,
        questionLayout: "two_stage_v3", dialoguePolicy: "holistic_v5", generationRetryVersion: v14, technicalTrial },
      queueState: { privateState: tape.state, events: tape.events },
      jevTraces: [attempt], initialObservation: { memoSha256: researchHash(tape.state.observationMemo) },
      aiPublicSettlement: [], jevLedger: {},
    }, options, context);
    assert.deepEqual(shapeBinding(records), ["pass", "pass"]);
    assert.equal(restore(trace)?.generationRetryVersion, v14);
    const passed = (row: any) => {
      row.choice = "none";
      row.scores = { none: 1, single_identification_claimed: 0, unconfirmed_detail_claimed: 0 };
    };
    const variants = [
      (attempt: any) => { delete attempt.draftSharedClaims; },
      (attempt: any) => { attempt.draftSharedClaims.pop(); },
      (attempt: any) => attempt.draftSharedClaims.forEach(passed),
      (attempt: any) => passed(attempt.draftSharedClaims[1]),
    ];
    const damaged = variants.map(change => {
      const copy = structuredClone(records), affected = copy.trials[0];
      for (const attempt of [affected.attempts[0], affected.turns[0].trace[0]]) change(attempt);
      let restored = false;
      try { restored = restore(affected.attempts[0]) !== null; }
      catch (error) { assert.equal((error as { code: string }).code, "invalid_options"); }
      return { s4: shapeBinding(copy), restored };
    });
    assert.deepEqual(damaged, variants.map(() => ({ s4: ["mismatch", "mismatch"], restored: false })));

    await assert.rejects(runTurn(profile, label, tape.state, tape.events, {
      ...turn.plan, drafts: [singleOverclaim, " "],
      choose: (key, criteria, context) => key === "draft_shared_claim" ? "single_identification_claimed" : choose(key, criteria, context),
    }, technicalTrial, v14), (error: any) => {
      const incomplete = error.traces.at(-1);
      assert.equal(error.code, "generation_failed");
      assert.equal(incomplete.generationErrorCode, "empty_response");
      assert.deepEqual(incomplete.draftSharedClaims.map((row: any) => row.draft), ["initial"]);
      assert.equal(restore(incomplete)?.generationRetryVersion, v14);
      return true;
    });
  });
}
