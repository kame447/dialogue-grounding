import assert from "node:assert/strict";
import { test } from "node:test";
import { GENERATION_RETRY_V22, GENERATION_RETRY_V23, generationGuardCodes, validAgreeNameScope } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { generationActionPromptV23, generationTaskV23, GENERATION_INSTRUCTIONS_V23, MULTIPLE_CANDIDATES_V23, PUBLIC_QUESTIONS_V23 } from "../dialogue-model/runtime/v2/generation-prompt-v23.ts";
import { researchTrialProfileV3 } from "../dialogue-model/runtime/v2/research-profile.ts";
import { initialState, normal, OWN, runTurn, type Label, type Plan } from "./support/s4-v3-records.ts";

type Prompt = Parameters<typeof generationActionPromptV23>[0];
const single = { kind: "single", figureId: "f1" } as const;
const accept = { action: "accept", target: single } as const;
const confirm = { action: "confirm", target: single, visualPurpose: { kind: "resolve_mismatch" } } as const;
const repair = { action: "repair", target: single } as const;
const hold = { action: "hold_open", target: single, issue: { kind: "unknown" } } as const;
const plan = (options: Partial<Prompt> = {}) => generationActionPromptV23({
  items: [accept], closing: null, visualDetail: false, humanLedTransition: false, publicQuestions: [],
  reconsidered: false, continuing: false, namingRequest: false, namingConflict: null, withdrawnName: null,
  ...options,
});
const contract = (prompt: string) => prompt.split("\n").find(line => line.startsWith("【出力】"));
const count = (prompt: string, text: string) => prompt.split(text).length - 1;
const repairOnly = "取り違えや名前の取り消しを表明できるのは、repair の行動（複数の扱いでは repair の部分）だけです。";
const procedureWords = "「合意」「候補」「案」「受け取りました」などの手続き語";

test("v23 の課題教示は図形数と公開できる材料を示し、古い方略の選択を委ねない", () => {
  for (const size of [4, 6]) {
    const task = generationTaskV23(size);
    assert.match(task, new RegExp(`タングラム${size}図形`));
    assert.match(task, /観察メモ・作業メモと公開済みの会話/);
    assert.doesNotMatch(task, /方略|一手を選/);
  }
  for (const field of ["visualPurpose", "observationFeatures", "hold_open", "carry_over", "partner_choice", "old_issue", "retainedReferenceHistory"]) {
    assert.match(GENERATION_INSTRUCTIONS_V23.split("\n").find(line => line.includes("内部項目名や種別名"))!, new RegExp(field));
  }
  assert.ok(validAgreeNameScope("jev_naming_v3", GENERATION_RETRY_V23));
});

test("v23 は各経路の出力契約を一度だけ示し、人主導の移行を最後に分ける", () => {
  const plain = plan();
  assert.equal(contract(plain), undefined);
  assert.match(plain, /公開発話の本文だけ/);
  const formats: ReadonlyArray<[Partial<Prompt>, readonly string[]]> = [
    [{ items: [confirm], visualDetail: true }, ["text", "observationFeatures"]],
    [{ items: [accept, hold] }, ["parts", "observationFeatures"]],
    [{ items: [accept, confirm], visualDetail: true }, ["parts", "observationFeatures"]],
    [{ humanLedTransition: true }, ["text", "moveOn"]],
    [{ items: [confirm], visualDetail: true, humanLedTransition: true }, ["text", "observationFeatures", "moveOn"]],
    [{ items: [accept, hold], humanLedTransition: true }, ["parts", "observationFeatures", "moveOn"]],
    [{ items: [accept, confirm], visualDetail: true, humanLedTransition: true }, ["parts", "observationFeatures", "moveOn"]],
  ];
  for (const [options, keys] of formats) {
    const prompt = plan(options);
    assert.equal(count(prompt, "【出力】"), 1);
    assert.ok(contract(prompt)?.startsWith("【出力】" + keys.join("・") + " のキーだけ"));
    assert.doesNotMatch(prompt, /公開発話の本文だけ/);
    if (keys.includes("parts")) assert.match(prompt, /公開する順.*全番号を一度ずつ/u);
    assert.equal(prompt.includes("必ず空配列 []"), keys.includes("parts") && !options.visualDetail);
    assert.equal(prompt.includes('["analytic","shapes",0]'), options.visualDetail === true);
    assert.equal(prompt.includes("moveOn は最後に公開"), options.humanLedTransition === true);
    assert.match(prompt, /公開の問いと内部の対象候補を記した参照資料/u);
  }
});

test("v23 は確認、修復、受け止め、保留の範囲を扱いごとに示す", () => {
  assert.match(plan({ items: [confirm], visualDetail: true }), /選んだ論点の解消に必要な点だけ/);
  assert.match(plan({ items: [repair], visualDetail: true }), /公開の食い違い.*取り違えや名前の訂正/);
  const multiple = plan({ items: [accept, confirm, repair, hold], visualDetail: true });
  assert.match(multiple, /items の 0 番（accept）: .*相槌に同じ相槌.*この部分から/);
  assert.match(multiple, /items の 3 番（hold_open）: .*相手が示した特徴や見立ての短い反復.*この論点で直接の問い/);
  assert.doesNotMatch(multiple, /発話を終えて/);
  assert.equal(count(multiple, "述べる順序"), 1);
  assert.equal(count(multiple, "対象と論点の範囲で観察メモから"), 1);
  assert.match(multiple, /clarify_reference.*resolve_mismatch.*resolve_issue.*unknown/);
  for (const continuing of [false, true]) {
    const prompt = plan({ items: [confirm], continuing, visualDetail: !continuing, namingRequest: true });
    assert.doesNotMatch(prompt, /followUp|discriminatingFeature|detailFigureIds|判断メモ/);
    assert.equal(count(prompt, PUBLIC_QUESTIONS_V23), 1);
    if (continuing) assert.match(prompt, /今の候補の範囲で短く尋ね/);
  }
});

test("v23 は命名の扱いで相手の見立てへの理解を示すよう指示する", () => {
  const proposal = "相手の見立てを短く受け止め、観察メモに基づく全体の見立てと結び付けて理解を示してください。必要なら自分の見立てを一つ返せます。";
  const agreement = "相手の見立てを短く受け止め、観察メモに基づく全体の見立てと結び付けて、どの図形のことと理解したかを示してください。合意した後に同じ特徴を説明し直さないでください。";
  for (const [action, expected, other, namingRule] of [
    ["propose_name", proposal, agreement, /計画にある名前を「」で候補として示してください/],
    ["agree", agreement, proposal, /計画にある名前を「」で示し、その名前に決まったことを伝えてください/],
  ] as const) {
    const item = { action, name: "帆", target: single };
    for (const items of [[item], [item, repair]]) {
      const prompt = plan({ items, visualDetail: items.length > 1 });
      const line = prompt.split("\n").find(line =>
        line.startsWith(items.length > 1 ? `items の 0 番（${action}）: ` : `【行動 ${action}】`));
      assert.ok(line);
      assert.ok(line.includes(expected));
      assert.match(line, namingRule);
      if (action === "propose_name") assert.match(line, /合意は表明しないでください/);
      assert.equal(count(prompt, expected), 1);
      assert.equal(count(prompt, other), 0);
      assert.equal(count(prompt, "これまでの発話に根拠がある時だけ"), items.length - 1);
    }
  }
  assert.doesNotMatch(plan({ items: [accept, repair], visualDetail: true }), /相手の見立てを短く受け止め/);
});

test("v23 の終了と呼び名の取り下げに矛盾する別の指示を重ねない", () => {
  const close = { action: "close", target: { kind: "none" } } as const;
  for (const [closing, expected] of [
    [{ initiator: "human", unresolved: true }, /相手が終わりを希望/],
    [{ initiator: "ai", unresolved: true }, /呼び名が決まっていない図形が残っています/],
    [{ initiator: "ai", unresolved: false }, /終わりにしてよいか相談/],
  ] as const) {
    const prompt = plan({ items: [close], closing });
    assert.match(prompt, expected);
    assert.equal(count(prompt, "【行動 close】"), 1);
  }
  const namingConflict = { agreedName: "砂時計", proposedNames: ["飾り台"] };
  const competing = plan({ items: [repair], namingConflict });
  assert.match(competing, /今回の案で名前を変更せず/);
  const withdrawal = plan({ items: [repair], namingConflict, withdrawnName: namingConflict.agreedName, reconsidered: true });
  assert.match(withdrawal, /以前の採用を明示して取り下げ/);
  assert.doesNotMatch(withdrawal, /今回の案で名前を変更せず|proposedNames/);
});

test("v23 の公開ガードは視覚・移行・窓外の内部項目を公開しない", () => {
  const context = { action: "accept", candidateName: null, v3: true, holistic: true, adaptive: false, factored: false,
    ai: true, publicTexts: [], humanTexts: [],
    generationRetryVersion: GENERATION_RETRY_V23 } as const;
  for (const field of ["visualPurpose", "observationFeatures", "hold_open", "carry_over", "partner_choice", "retainedReferenceHistory"]) {
    assert.ok(generationGuardCodes(field, context).includes("internal_field"), field);
  }
});

const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v3", "holistic_v5", "bypass_acceptance_v3", "jev_repair_quality_v1");
const technical = { version: "adaptive_repair_v3" } as const;
const ids: string[] = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
const question = "切り込みは二つですか？";
const otherQuestion = "ふくらみはどの部分ですか？";
const answer = "切り込みは台のそばにありますか？";
const otherAnswer = "ふくらみはどんな形に見えますか？";
const segment = (id: string, quote: string, targets: string[], name: string | null = null) =>
  ({ segmentId: id, quote, proposition: quote, targets, aspect: name === null ? "question" : "name", name, linkedIssueId: null, respondsToTurn: null });
const noFeatures = JSON.stringify({ segments: [], visualFeatures: { sources: [] } });
const decision = (choices: Record<string, string> = {}): NonNullable<Plan["choose"]> => (key, criteria) =>
  choices[key] ?? (key === "visual_purpose" ? Object.keys(criteria).find(label => label.startsWith("issue_")) ?? "unknown" :
    ({ human_move_on_source: "other", commitment_state: "insufficient", draft_topic_shift: "within_plan" } as Record<string, string>)[key]);
type History = { state: ReturnType<typeof initialState>; events: { seq: number; speaker: "human" | "ai"; text: string }[] };

async function run(human: string, plan: Plan, label: Label = "bypass-enabled",
  version: typeof GENERATION_RETRY_V22 | typeof GENERATION_RETRY_V23 = GENERATION_RETRY_V23,
  history?: History) {
  const state = history?.state ?? initialState({ profile, generationRetryVersion: version, agreeNameScopeVersion: "jev_naming_v3" });
  const events = history?.events ?? [];
  const terra: { body: string; messages: { role: string; content: string }[] }[] = [];
  const result = await runTurn(profile, label, state, [...events, { seq: (events.at(-1)?.seq ?? 0) + 1, speaker: "human", text: human }],
    { aiExtraction: noFeatures, ...plan, captureRequest(provider, body) {
      if (provider === "luna") terra.push({ body, messages: JSON.parse(body).messages });
    } }, technical, version);
  assert.equal(result.publication.status, "committed");
  const generation = terra.filter((_, i) => result.luna[i].phase === "generation");
  if (version === GENERATION_RETRY_V23) {
    for (const { messages } of generation) {
      const system = messages.filter(message => message.role === "system");
      for (const instruction of [repairOnly, procedureWords]) {
        assert.equal(count(system[1].content, instruction), 1);
        assert.ok(system.filter((_, index) => index !== 1).every(message => !message.content.includes(instruction)));
      }
    }
  }
  return { ...result, events: result.publication.publicEvents as History["events"], terra: generation };
}

test("v23 は主な扱いが単一対象でも追加の扱いの複数候補を保ち、同じ計画を両方略で同じバイトで送る", async () => {
  for (const multiple of [false, true]) {
    const multi: Plan = { action: "confirm", target: "figure_0", act: "ask",
      extraction: JSON.stringify([segment("a", question, ids.slice(0, 1)), segment("b", otherQuestion, ids.slice(1, multiple ? 3 : 2))]),
      speech: JSON.stringify({ parts: [{ item: 1, text: otherAnswer }, { item: 0, text: answer }], observationFeatures: [] }),
      choose: decision({ extra_0: "repair" }) };
    const first = await run(question + otherQuestion, multi, "bypass-enabled");
    const second = await run(question + otherQuestion, multi, "repair-first");
    assert.deepEqual(first.terra.map(post => post.body), second.terra.map(post => post.body));
    assert.equal(first.trace.executed.target.kind, "single");
    const extra = "extras" in first.trace.executed && first.trace.executed.extras?.[0];
    assert.ok(extra);
    assert.equal(extra.target.kind, multiple ? "multiple" : "single");
    assert.equal(first.terra[0].messages.filter(m => m.content === MULTIPLE_CANDIDATES_V23).length, multiple ? 1 : 0);
    assert.equal(first.speech, [otherAnswer, answer].join("\n"));
  }
});

test("v23 と v22 は publicQuestions にある計画外の図形を出所にした稿を同じ境界で再稿にする", async () => {
  for (const version of [GENERATION_RETRY_V22, GENERATION_RETRY_V23] as const) {
    const result = await run(question + otherQuestion, { action: "confirm", target: "figure_0", act: "ask",
      extraction: JSON.stringify([segment("a", question, ids.slice(0, 1)), segment("b", otherQuestion, ids.slice(1, 2))]),
      drafts: [JSON.stringify({ text: otherAnswer, observationFeatures: [{ figureId: ids[1], path: ["analytic", "shapes", 0] }] }),
        JSON.stringify({ text: answer, observationFeatures: [] })],
      choose: decision({ extra_0: "leave" }) }, "bypass-enabled", version);
    assert.ok(result.terra[0].messages[2].content.includes(JSON.stringify(otherQuestion)));
    assert.ok(result.trace.generationGuard.regenerated);
    assert.deepEqual(result.trace.generationGuard.violations, ["visual_feature_mismatch"]);
    assert.equal(result.speech, answer);
    assert.ok(result.terra[1].messages.at(-1)?.content.includes(result.terra[0].messages[2].content));
  }
});

test("v23 の単一・複数の視覚稿は人主導の moveOn を計画の本文の後に公開する", async () => {
  const naming = "この図形を砂時計と呼びませんか？";
  const request = "次の図形に進みましょう。";
  const moveOn = "では、次の図形を見ましょう。";
  for (const multiple of [false, true]) {
    const segments = [segment("name", naming, ids.slice(0, 1), "砂時計"),
      ...(multiple ? [segment("extra", otherQuestion, ids.slice(1, 2))] : [])];
    const draft = multiple
      ? { parts: [{ item: 0, text: answer }, { item: 1, text: otherAnswer }], observationFeatures: [], moveOn }
      : { text: answer, observationFeatures: [], moveOn };
    const choose = decision({ human_move_on_source: "human_request", draft_human_move_on: "honors_request",
      segment_0_act: "name_propose", segment_1_act: "ask", extra_0: "repair" });
    const result = await run(segments.map(row => row.quote).join("") + request, {
      action: "confirm", target: "figure_0", referent: "figure_0", extraction: JSON.stringify(segments),
      speech: JSON.stringify(draft), choose,
    });
    assert.match(result.terra[0].messages[2].content, /observationFeatures・moveOn のキーだけ/);
    assert.ok(result.trace.generatedPublication?.transition);
    assert.equal(result.speech, [...(multiple ? [answer, otherAnswer] : [answer]), moveOn].join("\n"));
  }
});

test("v23 の非視覚の複数扱いは空の出所配列で公開する", async () => {
  const reply = "話を聞かせてくれてありがとうございます。";
  const consult = "その点をもう少し確かめるか、別の進め方にするか、どうしましょうか？";
  const result = await run(otherQuestion, { action: "accept", target: "none", act: "ask",
    extraction: JSON.stringify([segment("unbound", otherQuestion, [])]),
    speech: JSON.stringify({ parts: [{ item: 0, text: reply }, { item: 1, text: consult }], observationFeatures: [] }),
    aiExtraction: "[]",
    choose: decision({ extra_0: "hold_open", extra_alt_0: "consult" }),
  }, "repair-first");
  assert.match(result.terra[0].messages[2].content, /observationFeatures は必ず空配列/);
  assert.equal(result.trace.generatedPublication?.visualFeatures, undefined);
  assert.equal(result.speech, [reply, consult].join("\n"));

  const naming = "この図形を砂時計と呼びませんか？";
  const moveOn = "では、次の図形を見ましょう。";
  const agreement = "はい、「砂時計」と呼びましょう。";
  const combined = await run(naming + otherQuestion + "次の図形に進みましょう。", {
    action: "agree", name: "砂時計", target: "figure_0", referent: "figure_0", aiExtraction: "[]",
    extraction: JSON.stringify([segment("name", naming, ids.slice(0, 1), "砂時計"), segment("unbound", otherQuestion, [])]),
    speech: JSON.stringify({ parts: [{ item: 0, text: agreement }, { item: 1, text: consult }], observationFeatures: [], moveOn }),
    choose: decision({ segment_0_act: "name_propose", segment_1_act: "ask", naming_evidence: "turn_1",
      naming_grounding: "grounded_name_0", extra_0: "hold_open", extra_alt_0: "consult",
      human_move_on_source: "human_request", draft_human_move_on: "honors_request" }),
  }, "repair-first");
  assert.match(combined.terra[0].messages[2].content, /parts・observationFeatures・moveOn のキーだけ/);
  assert.match(combined.terra[0].messages[2].content, /observationFeatures は必ず空配列/);
  assert.equal(combined.speech, [agreement, consult, moveOn].join("\n"));
});

test("v23 の実行経路は終了の主導と台帳の状態で指示を選ぶ", async () => {
  let allAgreed: History | undefined;
  for (const [index, id] of ids.entries()) {
    const name = "呼び名" + (index + 1);
    const proposal = `この図形を「${name}」と呼びませんか？`;
    const seq = (allAgreed?.events.at(-1)?.seq ?? 0) + 1;
    const choose = decision({ naming_evidence: "turn_" + seq });
    const r = await run(proposal, { action: "agree", name, target: "figure_" + index, referent: "figure_" + index,
      extraction: JSON.stringify([segment("name", proposal, [id], name)]), act: "name_propose",
      speech: `はい、「${name}」と呼びましょう。`, aiExtraction: "[]",
      choose: (key, criteria, context) => key === "naming_grounding"
        ? Object.keys(criteria).find(label => label.startsWith("grounded_name_") && JSON.parse(criteria[label]).name === name)
        : choose(key, criteria, context),
    }, "bypass-enabled", GENERATION_RETRY_V23, allAgreed);
    assert.equal(r.state.ledger[id].status, "agreed");
    allAgreed = r;
  }
  assert.ok(allAgreed);
  for (const [human, initiated, history, expected] of [
    ["ここまでにしてください。", "human", undefined, /相手が終わりを希望/],
    ["どうしましょうか？", "ai", undefined, /呼び名が決まっていない図形が残っています/],
    ["どうしましょうか？", "ai", allAgreed, /終わりにしてよいか相談/],
  ] as const) {
    const r = await run(human, { action: "close", target: "none", speech: "ここで終わりにしましょうか？", aiExtraction: "[]",
      choose: decision({ human_move_on_source: initiated === "human" ? "human_request" : "other" }),
    }, "bypass-enabled", GENERATION_RETRY_V23, history);
    assert.deepEqual(r.trace.generatedPublication?.close, { initiator: initiated, unresolved: history === undefined });
    assert.match(r.terra[0].messages[2].content, expected);
  }
});

test("v23 は計画外の移行を再稿にし、その稿に送った計画を再掲する", async () => {
  const initial = "この図形はそのままにして、次を見ましょう。";
  const retry = "いま見ている図形の切り込みのことですね。";
  const r = await run("今の図形の確認を続けたいです。", {
    action: "accept", target: "none", drafts: [initial, retry], aiExtraction: "[]",
    choose: (key, criteria, context) => key === "draft_topic_shift"
      ? context.generationCalls === 1 ? "unsupported_shift" : "within_plan"
      : decision()(key, criteria, context),
  });
  assert.deepEqual(r.trace.draftActs?.map(a => a.topicShift?.choice), ["unsupported_shift", "within_plan"]);
  assert.deepEqual(r.trace.generationGuard.violations, ["unsupported_topic_shift"]);
  assert.equal(r.speech, retry);
  assert.ok(r.terra[1].messages.at(-1)?.content.includes(r.terra[0].messages[2].content));
});
