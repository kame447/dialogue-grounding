// Regression for the 5-level name axis (agreed / unclear / not_agreed / no_name /
// unknown) end to end: research proxy route + sanitizer + client + default-off v2
// shadow + naming task + reference memory ON/OFF. Synthetic text, local mocks only:
// the fake Decisions upstream is an in-process function, never the network.
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { handleRequest as handleWorkerRequest } from "../workers/research-ai-proxy/src/index.mjs";
import { GROUNDING_CRITERIA_VERSION, GROUNDING_LEVELS, GROUNDING_MODELS, NAME_AGREEMENT_CRITERIA, sanitizeGroundingVerdict } from "../workers/research-ai-proxy/src/grounding.ts";
import { createGroundingJudgeClient, parseGroundingVerdict, type GroundingJudge } from "../dialogue-model/runtime/grounding/client.ts";
import { JUDGE_TIME_BUDGET_MS } from "../dialogue-model/runtime/judgment/luna.mjs";
import { renderDetail } from "../workers/tangram-experiment/src/admin/render.ts";
import { summarizeRecord } from "../workers/tangram-experiment/src/admin/summary.ts";
import { summarizeLatency } from "../workers/tangram-experiment/src/admin/latency.ts";
import { A, B, C, D, act, ref, assertSameBudget, createScriptedTrial, humanIds, ids, stableOptions, trial, type Step } from "./helpers/memory-harness.ts";
import { SCRIPT } from "./helpers/memory-script.ts";

type Rec = Record<string, any>;
const NAME_LEVELS = GROUNDING_LEVELS.name_agreement as readonly string[];
const LABEL = /(?<![A-Za-z0-9])(?:M[0-4]|P[1-5]|ER[01]|a[0-9]{1,2}|F[1-6])(?![A-Za-z0-9])/u;
const TOKEN = "no-name-proxy-token-at-least-thirty-two-characters";
const KEY = "sk-or-no-name-canary-openrouter-key";
const env = { RESEARCH_PROXY_TOKEN: TOKEN, RESEARCH_GROUNDING_ENABLED: "true", RESEARCH_DECISIONS_ENABLED: "false",
  OPENROUTER_DECISIONS_API_KEY: KEY, UPSTREAM_PROVIDER: "openai", DIALOGUE_MODEL: "gpt-6-luna", UPSTREAM_API_KEY: "chat-canary-key" };

test("the name axis has exactly the five researcher-approved levels, no_name among them", () => {
  assert.deepEqual([...NAME_LEVELS].sort(), ["agreed", "no_name", "not_agreed", "unclear", "unknown"]);
});

/**
 * Deterministic stand-in for Jev, a pure function of the shadow state (never of hidden
 * data), following the researcher's boundary (WildBose 6813): a 見立て/impression alone
 * (「鳥みたい」「船っぽい」) is NOT a naming proposal -> no_name; unclear only when a public
 * turn explicitly proposes a name for this target (「『鳥』と呼びませんか」「船にしましょうか」)
 * and adoption is unsettled; agreed only with the memory's explicit public acceptance;
 * not_agreed when a name record of the target was retracted. Names that exist only in AI
 * notes/claims/memory never count; they are used only to know which string to look for.
 * It shows the evidence the shadow receives drives the verdict; it says nothing about Jev quality.
 */
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
// Explicit proposal forms from the v2 criteria: 〇〇と呼びませんか / 〇〇にしましょうか / 名前は〇〇で.
const PROPOSAL = (name: string) => new RegExp("[『「]?" + escape(name) + "[』」]?(?:と呼|にしま|にしよ|でいきま|って呼)|名前は[『「]?" + escape(name), "u");
function oracle(stateText: string) {
  const state = JSON.parse(stateText);
  const target = state.aiSideClaims?.targetRef ?? null;
  if (!target || !state.publicDialogue?.length) return "unknown";
  const figure = state.aiMemory?.figures?.find((f: Rec) => f.ref === target) ?? null;
  const candidates = [figure?.name?.text, state.aiSideClaims?.candidateName, state.aiOwnNotes?.notes?.[target]?.name]
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  const proposed = candidates.some((name) => state.publicDialogue.some((turn: Rec) => PROPOSAL(name).test(turn.text)));
  if (proposed && figure?.name?.visibility === "public" && figure.name.agreement === "explicit") return "agreed";
  if (figure?.retracted?.some((r: Rec) => r.kind === "name")) return "not_agreed";
  return proposed ? "unclear" : "no_name";
}
const scores = (levels: readonly string[], chosen: string) => Object.fromEntries(levels.map((level) => [level, level === chosen ? 0.8 : 0.05]));

/** The real proxy route (auth, payload builder, sanitizer) over a fake Decisions upstream; the real client on top. */
function proxiedJudge({ fail = null as null | "status500" | "malformed" | "old_levels" } = {}) {
  const upstreamBodies: Rec[] = [];
  const upstream = async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    upstreamBodies.push(payload);
    if (fail === "status500") return new Response("SYNTHETIC-RAW-UPSTREAM-ERROR " + KEY, { status: 500 });
    const nameLevel = oracle(payload.state);
    const nameScores = fail === "old_levels"
      ? scores(["agreed", "unclear", "not_agreed", "unknown"], nameLevel === "no_name" ? "not_agreed" : nameLevel) : scores(NAME_LEVELS, nameLevel);
    return Response.json({ model: GROUNDING_MODELS.grounding_jev, provider: "TypeSafe", id: "gen-synthetic-no-name",
      answers: {
        identification: { type: "choice", choice: "insufficient", probabilities: scores(GROUNDING_LEVELS.identification, "insufficient"), confidence: 0.5 },
        name_agreement: fail === "malformed" ? { type: "choice", choice: "no-name", probabilities: nameScores, confidence: 0.5 }
          : { type: "choice", choice: fail === "old_levels" && nameLevel === "no_name" ? "not_agreed" : nameLevel, probabilities: nameScores, confidence: 0.5 },
      },
      usage: { input_tokens: 10, output_tokens: 2, cost: 0.00001 } });
  };
  const worker = (url: string, init: RequestInit) => handleWorkerRequest(new Request(url, init), env as never, upstream as never);
  const judge: GroundingJudge = createGroundingJudgeClient({ provider: "cloudflare", baseUrl: "https://research.test/v1", apiKey: TOKEN }, worker);
  return { judge, upstreamBodies };
}

async function run(steps: Step[], { referenceMemory = true, strategy = "repair-first", shadow = proxiedJudge() as ReturnType<typeof proxiedJudge> | null,
  restore = null as Rec | null, from = 0, to = steps.length } = {}) {
  const harness = await createScriptedTrial({ steps, referenceMemory, strategy, restore,
    extra: shadow ? { groundingShadow: { judge: shadow.judge, timeoutMs: 2000 } } : {} });
  for (let i = from; i < to; i++) await harness.say(i);
  const expected = (restore?.groundingShadow?.length ?? 0) + (shadow ? to - from : 0);
  for (let i = 0; i < 1000 && harness.task.researcherView().groundingShadow.length < expected; i++) await pause(2);
  await harness.task.persistNow();
  return { ...harness, upstreamBodies: shadow?.upstreamBodies ?? [], final: harness.records.at(-1)! };
}
// Per turn of SCRIPT under the stand-in (pre-utterance state, researcher boundary):
// 0 鳥みたい = impression only; 1 「鳥と呼びましょう」 = explicit proposal, not yet adopted on record;
// 2 and 4, 6-7 impressions/defer/revisit with no proposal on record yet for that figure; 5 no target;
// 3 the current human denial, judged before the AI repair is published: 棒 was publicly proposed in the AI's
//   turn-2 reply (a propose_name now shows its name), so a proposal is on record (unclear);
// 8 「波でいいです」 follows the AI's 「波」でどうでしょう？: a public name offer in a form the stand-in PROPOSAL
//   regex does not handle (a stand-in coverage gap, not a semantic borderline). Its label and oracle are
//   unchanged here: unclear or no_name, never agreed / not_agreed (no single level asserted);
// 9 a feature description only.
const BORDERLINE = "borderline";
const EXPECTED_SCRIPT_LEVELS = ["no_name", "unclear", "no_name", "unclear", "no_name", "unknown", "no_name", "no_name", BORDERLINE, "no_name"];
// Detached shadow calls may finish out of order; compare their public turn order.
const levels = (record: Rec) => [...record.groundingShadow].sort((a: Rec, b: Rec) => a.turnIndex - b.turnIndex)
  .map((r: Rec) => r.status === "ok" ? r.nameAgreement.level : r.status + ":" + r.error);
const visible = (r: Rec) => ({ events: r.events.map(({ seq, speaker, text }: Rec) => ({ seq, speaker, text })), ledger: r.ownLedger,
  privateState: r.queueState.privateState, judgments: r.judgments });

// Scenario scripts (synthetic). Each verdict is judged on the PRE-utterance state of its turn.
// Impression only: 見立て to identify the referent, never a naming proposal.
const IMPRESSION: Step[] = [
  { human: "鳥みたいな形がありますね", act: act("accept", A, null), reference: ref([A], "hypothesis", "refer"), reply: "羽を広げたような形のことですね。" },
  { human: "船っぽい形もある？", act: act("accept", B, null), reference: ref([B], "hypothesis", "refer"), reply: "細長くて船っぽいのがありますね。" },
];
const UNNAMED: Step[] = [
  { human: "細長い形がありますね", act: act("confirm", D, null, "くぼみの数"), reference: ref([D], "hypothesis", "refer"), reply: "くぼみはいくつありますか？" },
  { human: "くぼみは二つです", act: act("confirm", D, null, "くぼみの数"),
    reference: ref([D], "grounded", "feature_assertion", { feature: { slot: D, feature: "くぼみは二つ", polarity: "confirmed" } }), reply: "くぼみが二つの形ですね。" },
];
// Explicit proposal -> unclear until adopted; explicit acceptance -> agreed (visible to the next judgment).
const PROPOSAL_STEPS: Step[] = [
  { human: "その図形を『鳥』と呼びませんか", act: act("propose_name", A, "鳥"),
    reference: ref([A], "hypothesis", "name_proposal", { nameAcceptance: { slot: A, name: "鳥" } }), reply: "羽を広げたような形のことですね。" },
  { human: "うーん、どうでしょう", act: act("accept", A, null), reference: ref([A], "hypothesis", "refer"), reply: "ゆっくり考えましょう。" },
  { human: "やっぱり鳥と呼びましょう", act: act("agree", A, "鳥"),
    reference: ref([A], "grounded", "name_acceptance", { nameAcceptance: { slot: A, name: "鳥" } }), reply: "では、鳥と呼びましょう。" },
  { human: "次にいきましょう", act: act("accept", A, null), reference: ref([A], "hypothesis", "refer"), reply: "はい、次を見てみましょう。" },
];
// The AI proposes publicly; the partner never answers it (no response is never agreement).
const BLANK: Step[] = [
  { human: "細長いのがあります", act: act("propose_name", D, "棒"), reference: ref([D], "hypothesis", "refer"), reply: "棒と呼びませんか？" },
  { human: "次の形はどうですか", act: act("accept", D, null), reference: ref([], "unresolved", "refer"), reply: "ほかの形も見てみますね。" },
  { human: "うん", act: act("accept", D, null), reference: ref([], "unresolved", "acknowledgment"), reply: "では続けましょう。" },
];
// A name for A must not block no_name for D.
const OTHER_FIGURE: Step[] = [
  ...PROPOSAL_STEPS.slice(0, 3),
  { human: "次は細長い形です", act: act("confirm", D, null, "くぼみの数"), reference: ref([D], "hypothesis", "refer"), reply: "くぼみの数を見てみますね。" },
];
// The same figure gets a different explicit name: the latest public name is the one on record.
const RENAMED: Step[] = [
  PROPOSAL_STEPS[0],
  { human: "鳥より、つばめと呼ぶ方がいいかも", act: act("propose_name", A, "つばめ"),
    reference: ref([A], "hypothesis", "name_proposal", { nameAcceptance: { slot: A, name: "つばめ" } }), reply: "つばめっぽさもありますね。" },
  { human: "つばめにしましょう", act: act("agree", A, "つばめ"),
    reference: ref([A], "grounded", "name_acceptance", { nameAcceptance: { slot: A, name: "つばめ" } }), reply: "つばめに決まりですね。" },
  { human: "次にいきましょう", act: act("accept", A, null), reference: ref([A], "hypothesis", "refer"), reply: "はい、次を見てみましょう。" },
];

test("researcher boundary: an impression alone is no_name, an explicit proposal is unclear, no response is never agreed", async () => {
  for (const referenceMemory of [true, false]) {
    const impression = await run(IMPRESSION, { referenceMemory });
    assert.deepEqual(levels(impression.final), ["no_name", "no_name"], "impression-only, memory " + referenceMemory);
    const proposal = await run(PROPOSAL_STEPS, { referenceMemory });
    // turn 1: judged before the AI's reply, the human's own explicit proposal is public -> unclear.
    // With memory OFF there is no public-acceptance record, so the stand-in never reaches agreed.
    assert.deepEqual(levels(proposal.final), referenceMemory ? ["unclear", "unclear", "unclear", "agreed"] : ["unclear", "unclear", "unclear", "unclear"]);
    const blank = await run(BLANK, { referenceMemory });
    assert.deepEqual(levels(blank.final), ["no_name", "unclear", "unclear"], "an unanswered AI proposal stays unclear");
    assert.ok(!levels(blank.final).includes("agreed"));
    assert.equal(blank.final.ownLedger[D].status, "tentative", "Luna's ledger never turns silence into agreement");
    if (referenceMemory) assert.notEqual(blank.final.referenceGraph.ownSlots[D].candidate?.agreement, "explicit");
  }
});

test("the v2 criteria text encodes the boundary for Jev (impression is not a proposal; explicit 呼びましょう/にしましょう is)", () => {
  assert.match(NAME_AGREEMENT_CRITERIA.no_name, /見立て/u);
  assert.match(NAME_AGREEMENT_CRITERIA.unclear, /提案/u);
  // unclear needs an explicit proposal (a reply that only agrees with a 見立て stays unclear after one).
  assert.match(NAME_AGREEMENT_CRITERIA.unclear, /明示的に提案/u);
  assert.match(NAME_AGREEMENT_CRITERIA.no_name, /名前の提案ではない/u);
  assert.match(NAME_AGREEMENT_CRITERIA.agreed, /返答がない|相槌/u, "no reply / backchannel is not agreement");
  // Agreeing with a 見立て without any proposal is still no_name, and unclear says so explicitly.
  assert.match(NAME_AGREEMENT_CRITERIA.no_name, /見立てに他方が同意しただけ/u);
  assert.match(NAME_AGREEMENT_CRITERIA.unclear, /提案がなく見立ての共有だけなら unclear ではなく no_name/u);
  assert.ok(!/未提案/u.test(NAME_AGREEMENT_CRITERIA.not_agreed), "not_agreed never covers 'nothing proposed' (that is no_name)");
});

test("memory ON and OFF: no_name passes through proxy, sanitizer, client, shadow and record for an unnamed figure", async () => {
  for (const referenceMemory of [true, false]) {
    const { final, upstreamBodies } = await run(UNNAMED, { referenceMemory });
    assert.deepEqual(levels(final), ["no_name", "no_name"], "memory " + referenceMemory);
    for (const record of final.groundingShadow) {
      assert.equal(record.nameAgreement.level, "no_name");
      assert.deepEqual(Object.keys(record.nameAgreement.scores).sort(), [...NAME_LEVELS].sort(), "scores cover all five levels");
      assert.equal(record.criteriaVersion, GROUNDING_CRITERIA_VERSION, "every verdict records the server-owned criteria version");
    }
    // The proxy asks the fixed closed question with all five criteria; the client never chooses them.
    for (const body of upstreamBodies) {
      assert.deepEqual(Object.keys(body.questions.name_agreement.criteria).sort(), [...NAME_LEVELS].sort());
      assert.equal(body.model, GROUNDING_MODELS.grounding_jev);
      assert.equal(Object.hasOwn(JSON.parse(body.state), "aiMemory"), referenceMemory);
    }
  }
});

test("a name said for a different figure does not block no_name; agreement and renaming are on the target's own record", async () => {
  const other = await run(OTHER_FIGURE);
  assert.deepEqual(levels(other.final), ["unclear", "unclear", "unclear", "no_name"]);
  const state = JSON.parse(other.upstreamBodies[3].state);
  assert.equal(state.aiMemory.figures.find((f: Rec) => f.ref === A).name.agreement, "explicit");
  assert.equal(state.aiMemory.figures.find((f: Rec) => f.ref === D).name, null);

  const renamed = await run(RENAMED);
  // turn 1: nothing on record yet; turn 2: 鳥 proposed; turn 3: つばめ proposed (replaces 鳥); turn 4: つばめ agreed.
  assert.deepEqual(levels(renamed.final), ["unclear", "unclear", "unclear", "agreed"]);
  const memory = JSON.parse(renamed.upstreamBodies[3].state).aiMemory.figures.find((f: Rec) => f.ref === A);
  assert.equal(memory.name.text, "つばめ");
  assert.ok(!JSON.stringify(memory).includes("鳥"), "a replaced name is not presented as the current name");
});

test("agree, negation/repair, defer/revisit: verdicts follow the pre-turn evidence and never claim more than memory holds", async () => {
  const { final, upstreamBodies } = await run(SCRIPT);
  const got = levels(final);
  assert.equal(got.length, SCRIPT.length);
  assert.ok(got.every((level: string) => NAME_LEVELS.includes(level)));
  for (const [index, body] of upstreamBodies.entries()) {
    const state = JSON.parse(body.state);
    const target = state.aiSideClaims?.targetRef;
    const figure = state.aiMemory.figures.find((f: Rec) => f.ref === target);
    if (got[index] === "agreed") assert.equal(figure?.name?.agreement, "explicit", "turn " + index + ": agreed only with an explicit public acceptance");
    const names = [figure?.name?.text, state.aiSideClaims?.candidateName, state.aiOwnNotes?.notes?.[target]?.name].filter(Boolean) as string[];
    const proposed = names.some((name) => state.publicDialogue.some((turn: Rec) => PROPOSAL(name).test(turn.text)));
    if (got[index] === "no_name") assert.ok(!proposed, "turn " + index + ": no_name only without an explicit public proposal for the target");
    if (got[index] === "unclear") assert.ok(proposed, "turn " + index + ": unclear needs an explicit public proposal");
  }
  // Turn 2 judges A's agreement before it is committed: a proposal on record, not yet agreed.
  assert.equal(got[1], "unclear");
  // B on the current human denial, before the AI repair is published: 棒 was publicly proposed at turn 2.
  assert.equal(got[3], "unclear");
  assert.deepEqual(got.map((level: string, i: number) => EXPECTED_SCRIPT_LEVELS[i] === BORDERLINE ? BORDERLINE : level), EXPECTED_SCRIPT_LEVELS);
  assert.ok(["no_name", "unclear"].includes(got[8]), "the borderline turn is never agreed / not_agreed");
});

test("the shadow stays default OFF and changes nothing: byte-identical Luna requests with no_name verdicts on vs off", async () => {
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    for (const referenceMemory of [true, false]) {
      const off = await run(SCRIPT, { strategy, referenceMemory, shadow: null });
      const on = await run(SCRIPT, { strategy, referenceMemory });
      assert.equal(Object.hasOwn(off.final, "groundingShadow"), false, "default off: no shadow field");
      assert.equal(Object.hasOwn(off.final.options, "groundingShadow"), false);
      assert.equal(JSON.stringify(on.requests.map((r) => ({ ...r, options: stableOptions(r.options) }))),
        JSON.stringify(off.requests.map((r) => ({ ...r, options: stableOptions(r.options) }))));
      on.requests.forEach((r, i) => assertSameBudget(r.options, off.requests[i].options, JUDGE_TIME_BUDGET_MS));
      assert.deepEqual(visible(on.final), visible(off.final));
    }
  }
});

test("restore keeps 5-level verdicts and still accepts records written with the old 4-level axis", async () => {
  const whole = await run(SCRIPT);
  const first = await run(SCRIPT, { to: 5 });
  const saved = JSON.parse(JSON.stringify(first.final));
  const second = await run(SCRIPT, { restore: saved, from: 5 });
  assert.deepEqual(levels(second.final), levels(whole.final));
  assert.deepEqual(second.final.groundingShadow.slice(0, 5), saved.groundingShadow);
  assert.ok(second.final.groundingShadow.every((r: Rec) => r.criteriaVersion === GROUNDING_CRITERIA_VERSION));
  // A record persisted before no_name existed (4 score keys) restores unchanged and still renders.
  const legacy = JSON.parse(JSON.stringify(saved));
  for (const record of legacy.groundingShadow) {
    record.nameAgreement = { level: "not_agreed", scores: { agreed: 0, unclear: 0, not_agreed: 1, unknown: 0 }, confidence: null };
    delete record.criteriaVersion; // v1 records carry no version

  }
  const restored = await run(SCRIPT, { restore: legacy, from: 5, to: 6 });
  assert.deepEqual(restored.final.groundingShadow.slice(0, 5), legacy.groundingShadow);
  assert.equal(restored.final.groundingShadow[5].nameAgreement.scores.no_name !== undefined, true);
  const html = renderDetail(restored.final, summarizeRecord(restored.final, "a".repeat(64), summarizeLatency(restored.final)), summarizeLatency(restored.final), 30);
  assert.match(html, /not_agreed/u);
  assert.match(html, /no_name|unclear|agreed/u);
});

test("API failures (upstream 500, malformed level, old 4-level reply) become code-only error records; the dialogue is unchanged", async () => {
  const off = await run(SCRIPT.slice(0, 4), { shadow: null });
  for (const fail of ["status500", "malformed", "old_levels"] as const) {
    const on = await run(SCRIPT.slice(0, 4), { shadow: proxiedJudge({ fail }) });
    assert.deepEqual(visible(on.final), visible(off.final));
    const raw = JSON.stringify(on.final);
    for (const secret of [TOKEN, KEY, "SYNTHETIC-RAW-UPSTREAM-ERROR"]) assert.ok(!raw.includes(secret));
    for (const record of on.final.groundingShadow) {
      // Every reply here is invalid, including an old 4-level one (no no_name score): rejected, never silently mapped.
      assert.equal(record.status, "error", fail + ": never an ok record");
      assert.match(record.error, /^[a-z][a-z0-9_]{0,39}$/u);
    }
  }
});

test("sanitizer and client reject malformed no_name verdicts: unknown level, missing or extra score keys, out-of-range scores", () => {
  const verdict = (name: Rec) => ({ model: GROUNDING_MODELS.grounding_jev, answers: {
    identification: { type: "choice", choice: "supported", probabilities: scores(GROUNDING_LEVELS.identification, "supported"), confidence: 0.5 },
    name_agreement: { type: "choice", choice: "no_name", probabilities: scores(NAME_LEVELS, "no_name"), confidence: 0.5, ...name } } });
  assert.equal(sanitizeGroundingVerdict(verdict({}), GROUNDING_MODELS.grounding_jev, "grounding_jev")?.nameAgreement.level, "no_name");
  const { no_name: _dropped, ...fourKeys } = scores(NAME_LEVELS, "unclear");
  for (const bad of [{ choice: "no-name" }, { choice: "none" }, { probabilities: fourKeys }, { probabilities: { ...scores(NAME_LEVELS, "no_name"), extra: 0 } },
    { probabilities: { ...scores(NAME_LEVELS, "no_name"), no_name: 1.5 } }, { confidence: 2 }]) {
    assert.equal(sanitizeGroundingVerdict(verdict(bad), GROUNDING_MODELS.grounding_jev, "grounding_jev"), null, JSON.stringify(bad));
  }
  const body = (level: string, keys: readonly string[]) => ({ purpose: "grounding_jev", model: GROUNDING_MODELS.grounding_jev,
    identification: { level: "supported", scores: scores(GROUNDING_LEVELS.identification, "supported"), confidence: null },
    nameAgreement: { level, scores: scores(keys, level), confidence: null }, criteriaVersion: GROUNDING_CRITERIA_VERSION });
  assert.equal(parseGroundingVerdict(body("no_name", NAME_LEVELS), "grounding_jev", 1).nameAgreement.level, "no_name");
  assert.throws(() => parseGroundingVerdict(body("not_agreed", ["agreed", "unclear", "not_agreed", "unknown"]), "grounding_jev", 1));
  // A verdict without, or with another, criteria version (an old v1 proxy) is never mixed in.
  for (const criteriaVersion of [undefined, "grounding-criteria/v1"]) {
    assert.throws(() => parseGroundingVerdict({ ...body("no_name", NAME_LEVELS), criteriaVersion }, "grounding_jev", 1));
  }
});

test("leak checks: shadow states sent upstream carry no partner ids, key, annotation labels or strategy, under 5 levels", async () => {
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    const { upstreamBodies } = await run(SCRIPT, { strategy });
    for (const body of upstreamBodies) {
      const text = JSON.stringify(body);
      for (const id of humanIds) assert.ok(!text.includes(id));
      assert.ok(!text.includes(JSON.stringify(trial.key)));
      assert.ok(!LABEL.test(body.state), "label-shaped token " + body.state.match(LABEL)?.[0]);
      assert.ok(!/repair-first|bypass-enabled/u.test(text));
      assert.ok(!text.includes(TOKEN) && !text.includes(KEY));
      assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
    }
    assert.ok(ids.length === 6 && C);
  }
});
