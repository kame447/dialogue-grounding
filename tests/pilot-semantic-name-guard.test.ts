import assert from "node:assert/strict";
import test from "node:test";
import type { DraftAct } from "../dialogue-model/runtime/decision/contract.ts";
import { promptSourceManifest } from "../dialogue-model/runtime/diagnostics/parity-live/audit.ts";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { contentPublicationRecovery, currentTurnNamingSource, namingCodesWithoutQuestion } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { buildRecords, normal, OLD, OWN, runTurn } from "./support/s4-v3-records.ts";
import type { Label, Turn } from "./support/s4-v3-records.ts";
import { researchTrialProfileV3 } from "../dialogue-model/runtime/v2/research-profile.ts";

const [figure, other] = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
const name = "「へ」の煙突";
const proposal = `こちらの形を「${name}」と呼びませんか？`;
const shape = "端に切れ目がある";
const description = `私の側では、${shape}形に見えます。`;
const technicalTrial = { version: "adaptive_repair_v3" } as const;
const generationRetryVersion = "jev_generation_retry_v15" as const;
const options = { dialoguePolicy: "holistic_v5", generationRetryVersion, agreeNameScopeVersion: "scoped_v11", technicalTrial } as const;
const promptSources = await promptSourceManifest();
const strategies = ["repair-first", "bypass-enabled"] as const;
const box = structuredClone(OLD.state.observationMemo);
box.figures[0].analytic.shapes = [shape];
const manifest = normal.run.manifest;
const profile = researchTrialProfileV3(manifest.lunaRequest, manifest.timeouts, "two_stage_v3", "holistic_v5");

function segment(quote: string, proposition: string, aspect: string, label: string | null = null) {
  return JSON.stringify([{ segmentId: "1", quote, proposition, targets: [figure], respondsToTurn: null,
    linkedIssueId: null, aspect, name: label }]);
}

const focus: Turn = {
  human: "そちらからはどんな形に見えますか？",
  plan: { action: "accept", target: "figure_0", referent: "figure_0", speech: description,
    aiExtraction: segment(description, shape, "part"), aiActs: ["assert"] },
};

function named(drafts: readonly string[], choices: readonly DraftAct[], human = proposal): Turn {
  return { human, plan: { action: "agree", target: "figure_0", referent: "figure_0", drafts, prospect: "no_open_issue",
    act: "name_propose", extraction: segment(human, human, "name", name),
    choose: (key, _criteria, { generationCalls }) => key === "draft_naming" ? choices[generationCalls - 1] : undefined } };
}

function checks(records: Awaited<ReturnType<typeof buildRecords>>) {
  const verified = verifyRecords(records);
  const rows = verified.checks.filter(c => c.id.startsWith("intervention.trial.0.attempt.0."));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((c: { status: string; id: string }) => [c.id, c.status]),
    rows.map((c: { id: string }) => [c.id, "pass"]));
}

async function record(label: Label, turn: Turn) {
  let last: Awaited<ReturnType<typeof runTurn>> | undefined;
  const records = await buildRecords({ ...options, label, memo: box, promptSources, turns: [focus, turn],
    onTurn: (side, r) => { if (side === label) last = r; } });
  assert.ok(last);
  return { last, records };
}

test("old v13 stops despite two semantic approvals of the intended synthetic name", async () => {
  const turn = named(["「「へ」の煙突」にしましょう。", "へ の煙突にしましょう。"], ["adopt_chosen", "adopt_chosen"]);
  await assert.rejects(buildRecords({ ...options, generationRetryVersion: "jev_generation_retry_v13",
    memo: box, turns: [focus, turn] }), (e: any) => {
    assert.equal(e.code, "unsafe_generation");
    assert.equal(e.publication.status, "error");
    const trace = e.traces.at(-1);
    assert.equal(trace.executed.action, "agree");
    assert.equal(trace.publicSpeech, null);
    assert.deepEqual(trace.generationGuard.violations, ["name_mismatch", "name_not_shown"]);
    assert.deepEqual(trace.draftActs.map((a: { choice: DraftAct }) => a.choice), ["adopt_chosen", "adopt_chosen"]);
    return true;
  });
});

test("a contextual name needs a unique current public pair", () => {
  const selected = { action: "agree", target: { kind: "single", figureId: figure }, name } as const;
  const own = { name, figureId: figure, sourceTurn: 3 };
  assert.equal(currentTurnNamingSource(selected, [own], 3), true);
  assert.equal(currentTurnNamingSource(selected, [own], 5), false);
  assert.equal(currentTurnNamingSource(selected, [own, { ...own, figureId: other }], 3), false);
  assert.equal(currentTurnNamingSource(selected, [own, { ...own, name: "別の呼び名" }], 3), false);
  assert.equal(currentTurnNamingSource(selected, [own], 3, [{ sourceTurn: 3, name, targets: [other] }]), false);
});

for (const label of strategies) {
  test(`${label} recovers when both drafts use a direction without a viewpoint`, async () => {
    const draft = "左側に丸い穴が一つある形ですか？";
    const turn: Turn = {
      human: "その形を見分ける特徴はありますか？",
      plan: { action: "confirm", target: "figure_0", referent: "figure_0", drafts: [draft, draft] },
    };
    const { last, records } = await record(label, turn);
    assert.equal(last.publication.status, "committed");
    assert.equal(last.trace.executed.action, "confirm");
    assert.equal(last.trace.finalAction?.action, "confirm");
    assert.equal(last.trace.publicationRecovery?.act, "restate_selected_action");
    assert.deepEqual(last.trace.generationGuard.violations, ["orientation_leak"]);
    assert.equal(last.speech, "その形の特徴について、もう少し詳しく教えてもらえますか？");
    assert.deepEqual(last.state.ledger, records.trials[0].replay[0].tape.state.ledger);
    checks(records);
  });

  for (const [wording, choice] of [
    ["「「へ」の煙突」にしましょう。", "adopt_chosen"],
    ["“へ”の煙突にしましょう。", "adopt_chosen"],
    ["へ の煙突と呼びましょう。", "adopt_chosen"],
    ["それでいきましょう。", "adopt_context"],
  ] as const) {
    test(`${label} publishes equivalent naming: ${choice} ${wording}`, async () => {
      const { last, records } = await record(label, named([wording], [choice]));
      assert.equal(last.speech, wording);
      assert.deepEqual(last.state.ledger[figure], { status: "agreed", name });
      assert.equal(last.trace.generationGuard.regenerated, false);
      assert.equal(last.trace.draftActs?.length, 1);
      assert.equal(last.trace.draftSharedClaims, undefined);
      checks(records);
    });
  }

  for (const [x, choice] of [
    ["羽根と呼びましょう。", "adopt_other"],
    ["別の形の方を「「へ」の煙突」と呼びましょう。", "adopt_other"],
    ["相手は「へ」の煙突と言いました。", "recount_only"],
    ["その名前はまだ保留にしましょう。", "decline_or_hold"],
    ["その呼び名には賛成できません。", "decline_or_hold"],
  ] as const) {
    test(`${label} recovers without adopting: ${x}`, async () => {
      const { last, records } = await record(label, named([x, x], [choice, choice]));
      assert.equal(last.publication.status, "committed");
      assert.equal(last.trace.executed.action, "agree");
      assert.equal(last.trace.finalAction?.action, "confirm");
      assert.equal(last.trace.publicationRecovery?.act, "confirm_current_topic");
      assert.equal(last.state.judgments.at(-1).publicationRecovery.reason, "draft_content_mismatch");
      assert.deepEqual(last.state.ledger, records.trials[0].replay[0].tape.state.ledger);
      assert.equal(last.trace.draftActs?.length, 2);
      assert.notEqual(last.speech, x);
      assert.equal(last.publication.durable.privateState.aiPublic.pending.status, "skipped_fallback");
      checks(records);
    });
  }

  test(`${label} recovers from an unselected name and preserves the queue after reload`, async () => {
    const wrong = "羽根と呼びましょう。";
    const turn = named([wrong, wrong], ["adopt_other", "adopt_other"]);
    const { last, records } = await record(label, turn);
    checks(records);
    const events = [...last.publication.publicEvents, {
      id: "event-5", seq: 5, speaker: "human", text: "端の切れ目が目印です。",
    }];
    const continued = await runTurn(profile, label, JSON.parse(JSON.stringify(last.state)), events,
      { action: "accept", target: "figure_0", referent: "figure_0", speech: "切れ目が手がかりになるんですね。" },
      technicalTrial, generationRetryVersion);
    assert.equal(continued.publication.status, "committed");
    assert.deepEqual(continued.state.ledger, last.state.ledger);
    assert.equal(continued.state.judgments[1].judgment.action, "confirm");
    const forged = structuredClone(records);
    const attempt = forged.trials[0].attempts[0];
    attempt.publicationRecovery.act = "restate_selected_action";
    assert.ok(verifyRecords(forged).checks.some(c => c.id.startsWith("intervention.trial.0.attempt.0.") && c.status === "mismatch"));

    const rejected = named([wrong, wrong], ["adopt_other", "adopt_other"]);
    rejected.plan.action = "confirm";
    const nonNaming = await record(label, rejected);
    assert.equal(nonNaming.last.trace.finalAction?.action, "confirm");
    assert.equal(nonNaming.last.trace.publicationRecovery?.act, "restate_selected_action");
    assert.deepEqual(nonNaming.last.state.ledger, records.trials[0].replay[0].tape.state.ledger);
    checks(nonNaming.records);
  });
}

test("an unambiguous selected proposal needs no new Jev request", () => {
  const original = ["name_not_shown"];
  assert.deepEqual(namingCodesWithoutQuestion(original, "へ の煙突と呼びませんか？", "propose_name", name), []);
  assert.deepEqual(namingCodesWithoutQuestion([], "「鳥」と呼びませんか？", "propose_name", "鳥"), []);
  assert.deepEqual(namingCodesWithoutQuestion([], "別の形を「鳥」と呼びませんか？", "propose_name", "鳥"), ["draft_act_missing_evidence"]);
  assert.deepEqual(namingCodesWithoutQuestion([], "羽根と呼びませんか？", "confirm", null), ["draft_act_mismatch"]);
});

test("only content codes admit a local recovery; credential and unavailable checks still stop", () => {
  const selection = { action: "confirm", target: { kind: "single", figureId: figure } } as const;
  const codes = ["orientation_leak", "unsupported_topic_shift"];
  assert.equal(contentPublicationRecovery(codes, selection)?.judgment.action, "confirm");
  assert.equal(contentPublicationRecovery(["draft_shared_claim_unconfirmed_detail"], selection)?.judgment.action, "confirm");
  for (const code of ["internal_credential", "internal_image", "internal_prompt_echo", "draft_act_unconfirmed", "empty_utterance"]) {
    assert.equal(contentPublicationRecovery([...codes, code], selection), null);
  }
});
