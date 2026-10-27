// Synthetic ids, images and canned judge replies only; no live-model claim.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLunaJudge } from "../dialogue-model/runtime/judgment/luna.mjs";
import { JUDGE_POLICIES } from "../dialogue-model/runtime/judgment/instructions.mjs";
import { createOwnLedger, SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";
import { createReferenceGraph } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import {
  CANDIDATE_CONFLICT_INSTRUCTIONS, CONFLICT_RETRY_HINTS, CandidateConflictError, splitConflict,
  validateCandidateConflict,
} from "../dialogue-model/runtime/v2/candidate-conflict.ts";

type Message = { role: string; content: unknown };
type Strategy = "repair-first" | "bypass-enabled";
const ids = ["s-0001", "s-0002", "s-0003", "s-0004", "s-0005", "s-0006"];
const anchors = ids.map((id, i) => ({ id, bbox: { x: i, y: 0, w: 1, h: 1 }, centroid: { x: i, y: 0 } }));
const image = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
const confirm = { action: "confirm", targetSlot: "s-0001", candidateName: "鳥", discriminatingFeature: "細い尖りが一つだけある", note: null };
const twoCandidates = { candidates: [{ id: "s-0001", feature: "細い尖りが一つだけある" }, { id: "s-0002", feature: "尖りが三つある" }], featureFits: ["s-0001"] };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function scripted(replies: string[]) {
  const requests: Message[][] = [];
  return { requests, client: { async complete(messages: Message[]) {
    requests.push(structuredClone(messages));
    return { text: replies[Math.min(requests.length - 1, replies.length - 1)] };
  } } };
}

async function runJudge({ version = 2, strategy = "repair-first" as Strategy, memory = false, candidateConflict, replies }:
  { version?: number; strategy?: Strategy; memory?: boolean; candidateConflict?: boolean; replies: string[] }) {
  const { requests, client } = scripted(replies);
  const judge = candidateConflict === undefined ? createLunaJudge(client) : createLunaJudge(client, { candidateConflict });
  const ledger = version === 2 ? createOwnLedger(ids) : createOwnLedger();
  const output = await judge.judge({ version, strategy, image, publicHistory: [{ role: "user", content: "鳥みたい" }], ownLedger: ledger,
    ...(version === 2 ? { ownAnchors: anchors } : {}),
    ...(memory ? { referenceContext: { graph: createReferenceGraph(version === 2 ? { slots: ids } : undefined), turn: 1,
      publicTurns: [{ turn: 1, speaker: "human", text: "鳥みたい" }] } } : {}) });
  return { output, requests, diagnostics: judge.getDiagnostics() };
}

// Pinned against origin/main 6377de9 (two invalid replies: first request + retry); v2 re-pinned for the
// shared joint-reference element (HUMANLIKE-REFERENCE-2026-10-19). v1 unchanged.
// Update only when the DEFAULT prompt is intentionally changed elsewhere.
const DEFAULT_DIGESTS: Record<string, string> = {
  "v1:repair-first:false": "3242732e6fbcaa6e8bf3cec1a4c933a45a2414a460133681c79223fd610f1f21",
  "v1:repair-first:true": "163310d0bf8c4f6188bf9dd4749b37eb387c82dd4c02f846764c1fdf7052dc21",
  "v1:bypass-enabled:false": "fc441bbe543472aa57303455cb557b24cc069afd457b77dcfb719e602f835024",
  "v1:bypass-enabled:true": "bbeb4824b2f286e72b2aad4ebc2bfd1a9201032efc66f9679733ad2c49e0091f",
  "v2:repair-first:false": "d158b5bcd7ed4cdccb2c7507e7dc22556b68c04c3682ea9f6c1983c0e65a6cbb",
  "v2:repair-first:true": "112c255bb893e21ae78d142154189ea81d3c398a1c2ae401510b9fc7be460bbc",
  "v2:bypass-enabled:false": "ede53252bdd15ca4f17ac638f8aa15811d675b5996116ce44382257310dbcf79",
  "v2:bypass-enabled:true": "944402f2923b1ed35bdd81fe0b765fbd2957588e1e56dcbda047f69ab397e024",
};

test("default v1 and v2 judge requests, including the retry, stay byte-identical", async () => {
  for (const key of Object.keys(DEFAULT_DIGESTS)) {
    const [v, strategy, memory] = key.split(":");
    for (const candidateConflict of [undefined, false]) {
      const { requests } = await runJudge({ version: Number(v.slice(1)), strategy: strategy as Strategy, memory: memory === "true",
        candidateConflict, replies: ["not json", "also bad"] });
      assert.equal(requests.length, 2);
      assert.equal(digest(requests), DEFAULT_DIGESTS[key], key);
      assert.ok(!JSON.stringify(requests).includes("conflict"), key);
    }
  }
});

test("opt-in inserts one strategy-independent system message after the judge rules", async () => {
  const bodies: Record<string, Message[]> = {};
  for (const strategy of ["repair-first", "bypass-enabled"] as Strategy[]) {
    const off = await runJudge({ strategy, replies: [JSON.stringify(SAFE_JUDGMENT)] });
    const on = await runJudge({ strategy, candidateConflict: true, replies: [JSON.stringify({ ...SAFE_JUDGMENT, conflict: { candidates: [], featureFits: null } })] });
    const [first] = on.requests;
    assert.deepEqual(first[3], { role: "system", content: CANDIDATE_CONFLICT_INSTRUCTIONS });
    assert.deepEqual([...first.slice(0, 3), ...first.slice(4)], off.requests[0]);
    assert.equal(first[1].content, JUDGE_POLICIES[strategy]);
    bodies[strategy] = first.filter((_, i) => i !== 1);
  }
  assert.deepEqual(bodies["repair-first"], bodies["bypass-enabled"], "only JUDGE_POLICIES may differ by strategy");
  assert.ok(!/repair-first|bypass-enabled|保留を優先|確認を優先/.test(CANDIDATE_CONFLICT_INSTRUCTIONS));
});

test("opt-in rejects v1 and non-boolean options", async () => {
  await assert.rejects(runJudge({ version: 1, candidateConflict: true, replies: ["{}"] }), /requires version 2/);
  assert.throws(() => createLunaJudge(scripted([]).client, { candidateConflict: "yes" as unknown as boolean }), /Invalid candidate conflict option/);
});

test("a discriminating conflict is kept in diagnostics only, never in the returned judgment", async () => {
  const { output, requests, diagnostics } = await runJudge({ candidateConflict: true, replies: [JSON.stringify({ ...confirm, conflict: twoCandidates })] });
  assert.equal(requests.length, 1);
  assert.deepEqual(output, confirm);
  assert.ok(!Object.hasOwn(output, "conflict"));
  assert.deepEqual(diagnostics.at(-1), { attempts: 1, fallback: false, failures: [], conflict: twoCandidates, conflictError: null, nonDiscriminating: false });
});

test("a feature common to all candidates gets one corrective retry and never discards the valid act", async () => {
  const common = { ...twoCandidates, featureFits: ["s-0001", "s-0002"] };
  const fixed = { ...twoCandidates, featureFits: ["s-0002"] };
  const retried = await runJudge({ candidateConflict: true, replies: [JSON.stringify({ ...confirm, conflict: common }), JSON.stringify({ ...confirm, conflict: fixed })] });
  assert.equal(retried.requests.length, 2);
  assert.match(String(retried.requests[1].at(-1)?.content), /non_discriminating_feature/);
  assert.ok(String(retried.requests[1].at(-1)?.content).includes(CONFLICT_RETRY_HINTS.non_discriminating_feature));
  assert.deepEqual(retried.output, confirm);
  assert.deepEqual(retried.diagnostics.at(-1), { attempts: 2, fallback: false, failures: ["non_discriminating_feature"], conflict: fixed, conflictError: null, nonDiscriminating: false });

  // Still non-discriminating after the retry: keep the act, flag it privately.
  const kept = await runJudge({ candidateConflict: true, memory: true, replies: [JSON.stringify({ ...confirm, reference: null, conflict: common })] });
  assert.equal(kept.requests.length, 2);
  assert.deepEqual(kept.output, { ...confirm, reference: null });
  assert.deepEqual(kept.diagnostics.at(-1), { attempts: 2, fallback: false, failures: ["non_discriminating_feature"], memoryFallback: false,
    conflict: null, conflictError: "non_discriminating_feature", nonDiscriminating: true });

  // Retry with an invalid core: the first valid act survives.
  const firstKept = await runJudge({ candidateConflict: true, replies: [JSON.stringify({ ...confirm, conflict: common }), "not json"] });
  assert.deepEqual(firstKept.output, confirm);
  assert.deepEqual(firstKept.diagnostics.at(-1), { attempts: 2, fallback: false, failures: ["non_discriminating_feature", "invalid_json"],
    conflict: null, conflictError: "non_discriminating_feature", nonDiscriminating: true });
});

test("missing or malformed conflict blocks are recorded without a retry or a safe fallback", async () => {
  const missing = await runJudge({ candidateConflict: true, replies: [JSON.stringify(confirm)] });
  assert.equal(missing.requests.length, 1);
  assert.deepEqual(missing.output, confirm);
  assert.deepEqual(missing.diagnostics.at(-1), { attempts: 1, fallback: false, failures: [], conflict: null, conflictError: "invalid_conflict", nonDiscriminating: false });
  const outside = await runJudge({ candidateConflict: true, replies: [JSON.stringify({ ...confirm, targetSlot: "s-0003", conflict: twoCandidates })] });
  assert.deepEqual(outside.output, { ...confirm, targetSlot: "s-0003" });
  assert.equal(outside.diagnostics.at(-1)?.conflictError, "conflict_target_not_candidate");
  // Only an invalid core act still ends in the existing safe judgment.
  const invalidCore = await runJudge({ candidateConflict: true, replies: ["not json"] });
  assert.deepEqual(invalidCore.output, SAFE_JUDGMENT);
  assert.deepEqual(invalidCore.diagnostics.at(-1), { attempts: 2, fallback: true, failures: ["invalid_json", "invalid_json"], conflict: null, conflictError: null, nonDiscriminating: false });
});

test("validator: shapes, target membership and the split rule", () => {
  const ownIds = ids;
  const v = (conflict: unknown, judgment: { targetSlot: string | null; discriminatingFeature: string | null } = confirm) => validateCandidateConflict(conflict, { ownIds, judgment });
  const code = (fn: () => unknown) => { try { fn(); return null; } catch (error) { assert.ok(error instanceof CandidateConflictError); return error.code; } };
  assert.deepEqual(v({ candidates: [], featureFits: null }), { candidates: [], featureFits: null });
  assert.equal(code(() => v({ candidates: [], featureFits: [] })), "conflict_fits_required");
  assert.equal(code(() => v({ candidates: [twoCandidates.candidates[0]], featureFits: null })), "invalid_conflict");
  assert.equal(code(() => v({ candidates: [...twoCandidates.candidates, { id: "s-0003", feature: "a" }, { id: "s-0004", feature: "b" }], featureFits: ["s-0001"] })), "invalid_conflict");
  assert.equal(code(() => v({ candidates: [twoCandidates.candidates[0], twoCandidates.candidates[0]], featureFits: ["s-0001"] })), "invalid_conflict");
  assert.equal(code(() => v({ candidates: [{ id: "F1", feature: "a" }, { id: "s-0002", feature: "b" }], featureFits: ["s-0002"] })), "invalid_conflict");
  assert.equal(code(() => v({ ...twoCandidates, extra: 1 })), "invalid_conflict");
  assert.equal(code(() => v(twoCandidates, { ...confirm, targetSlot: "s-0003" })), "conflict_target_not_candidate");
  assert.equal(code(() => v({ ...twoCandidates, featureFits: null })), "conflict_fits_required");
  assert.equal(code(() => v({ ...twoCandidates, featureFits: [] })), "non_discriminating_feature");
  assert.equal(code(() => v({ ...twoCandidates, featureFits: ["s-0001", "s-0002"] })), "non_discriminating_feature");
  assert.equal(code(() => v({ ...twoCandidates, featureFits: ["s-0003"] })), "invalid_conflict");
  // Conflict recorded without a feature (e.g. defer / accept) needs no fits.
  assert.deepEqual(v({ ...twoCandidates, featureFits: null }, { targetSlot: null, discriminatingFeature: null }), { ...twoCandidates, featureFits: null });
  assert.equal(code(() => v(twoCandidates, { targetSlot: "s-0001", discriminatingFeature: null })), "conflict_fits_required");
  // Three candidates: a feature fitting two of them still splits the set.
  const three = { candidates: [...twoCandidates.candidates, { id: "s-0003", feature: "四角がある" }], featureFits: ["s-0001", "s-0003"] };
  assert.deepEqual(v(three), three);
  assert.deepEqual(splitConflict({ a: 1 }), { core: { a: 1 }, conflict: undefined, present: false });
  const raw = { a: 1, conflict: 2 };
  assert.deepEqual(splitConflict(raw), { core: { a: 1 }, conflict: 2, present: true });
  assert.deepEqual(raw, { a: 1, conflict: 2 });
});

test("v2 dialogue with an injected opt-in judge never shows candidate features to the generator", async () => {
  const secretFeature = "SYNTHETIC_PRIVATE_CANDIDATE_FEATURE";
  const conflict = { candidates: [{ id: "s-0001", feature: secretFeature }, { id: "s-0002", feature: secretFeature + "2" }], featureFits: null };
  const requests: Message[][] = [];
  const client = { async complete(messages: Message[], options: { phase?: string } = {}) {
    requests.push(structuredClone(messages));
    return { text: options.phase === "judgment" ? JSON.stringify({ ...SAFE_JUDGMENT, targetSlot: null, conflict }) : "そうですね。" };
  } };
  const judge = createLunaJudge(client, { candidateConflict: true });
  const dialogue = createDialogueV2({ client, strategy: "bypass-enabled", image, anchors, judge });
  const turn = await dialogue.runAiTurn({ events: [{ id: "e-1", seq: 1, speaker: "human", text: "鳥みたい" }], signal: null,
    privateState: dialogue.initialPrivateState(), lastEventId: "e-1" });
  assert.equal(turn.text, "そうですね。");
  assert.equal(requests.length, 2);
  assert.ok(!JSON.stringify(requests[1]).includes(secretFeature), "generator input must not include candidate notes");
  assert.deepEqual(turn.privateState.judgments[0].validation.conflict, conflict);
  assert.ok(!Object.hasOwn(turn.privateState.judgments[0].judgment, "conflict"));
});
