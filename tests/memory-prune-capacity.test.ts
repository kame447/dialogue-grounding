import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  CLAIM_PRUNE_V2, REFERENCE_LIMITS, applyReferenceUpdate, createReferenceGraph, previewReferenceUpdate,
} from "../dialogue-model/runtime/memory/reference-graph.mjs";
import type { MemoryPruneVersion } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import type { AiPublicState, LocalClaimFields, LocalSegmentProposal, PublicTurn } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { deriveLocalIssues, priorClaimViews } from "../dialogue-model/runtime/local-grounding/derive.ts";
import { aiHash } from "../dialogue-model/runtime/local-grounding/extract-ai.ts";
import { prependAiPublic } from "../dialogue-model/runtime/local-grounding/verify-ai.ts";
import { verifyLocalUpdate } from "../dialogue-model/runtime/local-grounding/verify.ts";
import { approveReception, createReception, validateReceptionPlan } from "../dialogue-model/runtime/v2/reception.ts";
import { assignmentMemoryPruneVersion, readAssignment, validateBoundBaseRecord } from "../dialogue-model/runtime/v2/base-assignment-data.ts";
import type { BaseSessionOptions } from "../dialogue-model/runtime/v2/base-assignment.ts";
import { createBaseAssignmentSession } from "../dialogue-model/runtime/v2/base-assignment-session.ts";
import { memoryCapacityRejectedClaims, type JevTurnTrace } from "../dialogue-model/runtime/v2/jev-turn.ts";
import { pairedInterventionReplay } from "../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts";
import { promptSourceManifest } from "../dialogue-model/runtime/diagnostics/parity-live/audit.ts";
import { hash } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import { interventionChecks } from "../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { createTrialV2, modelView } from "../dialogue-model/runtime/stimuli/scatter-v2.mjs";
import { config, harness } from "./support/s5-base/support.ts";

const slots = ["s-a", "s-b", "s-c", "s-d", "s-e", "s-f"];
const [left, right] = slots;
type Claim = LocalClaimFields & { kind: "claim"; id: string };
type Graph = ReturnType<typeof createReferenceGraph>;

function claim(sourceTurn: number, key = "claim", values: Partial<Claim> = {}): Claim {
  const id = sourceTurn + ":" + key;
  return {
    kind: "claim", id, issueId: id, targets: [left, right], aspect: "part", act: "assert", proposition: "切れ込み",
    name: null, speaker: "human", sourceTurn, quote: "切れ込みの形", respondsTo: null, source: "partner_statement",
    ...values,
  };
}

function apply(graph: Graph, turn: number, operations: Claim[]) {
  const publicTurns = new Map<string, PublicTurn>();
  for (const { sourceTurn, speaker, quote } of operations) {
    const key = sourceTurn + ":" + speaker;
    publicTurns.set(key, { turn: sourceTurn, speaker, text: (publicTurns.get(key)?.text ?? "") + quote });
  }
  return applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn, operations },
    { publicTurns: [...publicTurns.values()], generationSucceeded: true });
}

function saturated(count: number, memoryPruneVersion?: MemoryPruneVersion) {
  let graph = createReferenceGraph({ slots, ...(memoryPruneVersion ? { memoryPruneVersion } : {}) });
  for (let used = 0; used < count; used += REFERENCE_LIMITS.operations) {
    const turn = graph.lastTurn + 1;
    graph = apply(graph, turn, Array.from({ length: Math.min(count - used, REFERENCE_LIMITS.operations) },
      (_, index) => claim(turn, "part" + index)));
  }
  return graph;
}

function proposal(turn: number, targets = [left]) {
  return claim(turn, "name", { targets, aspect: "name", act: "name_propose", proposition: "小舟", name: "小舟", quote: "小舟と呼びましょう" });
}

test("claim pruning v2 keeps new names and public AI evidence after the legacy limit", () => {
  const legacy = saturated(REFERENCE_LIMITS.records);
  const turn = legacy.lastTurn + 1;
  assert.throws(() => apply(legacy, turn, [proposal(turn)]), { code: "capacity_exceeded" });
  assert.equal(createHash("sha256").update(JSON.stringify(legacy)).digest("hex"), "45a5fb3633bea40375f07d7e8956594ef592f1635ee69e8be9bdc9c667ae3c98");

  let graph = saturated(REFERENCE_LIMITS.records, CLAIM_PRUNE_V2);
  const first = proposal(turn);
  graph = apply(graph, turn, [first]);
  const acceptance = claim(turn + 1, "accept", { targets: [left], aspect: "name", act: "name_accept",
    proposition: "小舟", name: "小舟", quote: "小舟でいいです", speaker: "ai", source: "ai_hypothesis",
    issueId: first.issueId, respondsTo: first.id });
  graph = apply(graph, turn + 1, [acceptance]);
  const olderFeature = claim(turn + 2, "check", { targets: [right] });
  graph = apply(graph, turn + 2, [olderFeature]);
  const ai = claim(turn + 3, "pub", { targets: [right], speaker: "ai", source: "ai_hypothesis",
    issueId: olderFeature.issueId, respondsTo: olderFeature.id, act: "agree" });
  graph = apply(graph, turn + 3, [ai]);

  assert.ok(graph.records.length <= REFERENCE_LIMITS.records);
  assert.ok(!graph.records.some((entry: Claim) => entry.id === "1:part0"));
  for (const item of [first, acceptance, olderFeature, ai]) assert.ok(graph.records.some((entry: Claim) => entry.id === item.id));
  const restored = JSON.parse(JSON.stringify(graph));
  assert.equal(deriveLocalIssues(restored).find(issue => issue.issueId === first.issueId)?.nameState, "agreed");
  const nextTurn = graph.lastTurn + 1;
  assert.deepEqual(apply(restored, nextTurn, [proposal(nextTurn, [right])]), apply(graph, nextTurn, [proposal(nextTurn, [right])]));
});

test("recent negative checks survive naming under pressure with both records in their closure", () => {
  let graph = saturated(REFERENCE_LIMITS.records - 3, CLAIM_PRUNE_V2);
  const focus = claim(graph.lastTurn + 1, "focus", { targets: [left], aspect: "referent" });
  graph = apply(graph, focus.sourceTurn, [focus]);
  const check = claim(graph.lastTurn + 1, "check", { targets: [left], speaker: "ai", source: "ai_hypothesis" });
  graph = apply(graph, check.sourceTurn, [check]);
  const denial = claim(graph.lastTurn + 1, "deny", { targets: [left], act: "deny", respondsTo: check.id, issueId: check.issueId });
  graph = apply(graph, denial.sourceTurn, [denial]);
  assert.equal(graph.records.length, REFERENCE_LIMITS.records);
  const next = proposal(graph.lastTurn + 1, []);
  const { memoryPruneVersion: _version, ...unmarked } = graph;
  const legacy = apply(unmarked, next.sourceTurn, [next]);
  assert.ok(legacy.records.some((entry: Claim) => entry.id === focus.id));
  assert.ok(!legacy.records.some((entry: Claim) => entry.id === denial.id));
  graph = apply(graph, next.sourceTurn, [next]);
  const claims = priorClaimViews(graph, { limit: REFERENCE_LIMITS.records });
  for (const item of [focus, check, denial, next]) assert.ok(claims.some(c => c.id === item.id), item.id);
  assert.ok(claims.some(c => c.act === "deny" && c.targets.includes(left) && c.sourceTurn > focus.sourceTurn));
  assert.ok(!claims.some(c => c.id === "1:part0"));
});

test("pre-human replay must reconstruct the graph before a same-turn name evicts an antecedent", () => {
  const graph = saturated(REFERENCE_LIMITS.records - 1, CLAIM_PRUNE_V2);
  const turn = graph.lastTurn + 2;
  const newName = proposal(turn);
  const ai = claim(turn - 1, "pub", { id: turn + ":pub", targets: [right], speaker: "ai", source: "ai_hypothesis" });
  const operations = { expectedRevision: graph.revision, turn, operations: [ai] };
  const publicTurns: PublicTurn[] = [
    { turn: 1, speaker: "human", text: "切れ込みの形" },
    { turn: turn - 1, speaker: "ai", text: ai.quote },
    { turn, speaker: "human", text: "確かに切れ込みです。" + newName.quote },
  ];
  const disputed: LocalSegmentProposal = {
    segmentId: "agree", quote: "確かに切れ込みです。", targets: [left], proposition: "切れ込み", aspect: "part",
    name: null, linkedIssueId: null, respondsToTurn: 1,
  };
  const segment: LocalSegmentProposal = {
    segmentId: "name", quote: newName.quote, targets: [left], proposition: newName.proposition, aspect: "name",
    name: newName.name, linkedIssueId: null, respondsToTurn: null,
  };
  const verification = (input: Graph) => verifyLocalUpdate({ graph: input, turn, publicTurns, segments: [disputed, segment], verdicts: [
    { segmentId: "agree", act: "agree", respondsToClaimId: "1:part0", rawScore: null },
    { segmentId: "name", act: "name_propose", respondsToClaimId: null, rawScore: null },
  ] });
  const atVerification = previewReferenceUpdate(graph, operations, { publicTurns });
  const verified = verification(atVerification);
  assert.deepEqual(verified.rejected.map(r => r.reason), ["inconsistent_claim_speaker"]);
  assert.equal(verified.operations.length, 1);
  const after = applyReferenceUpdate(graph, { ...operations, operations: [...operations.operations, ...verified.operations] },
    { publicTurns, generationSucceeded: true });
  assert.ok(!after.records.some((c: Claim) => c.id === "1:part0"));
  const reconstructed = previewReferenceUpdate(graph, operations, { publicTurns });
  assert.deepEqual(verification(reconstructed).rejected, verified.rejected);
  assert.deepEqual(verification(after).rejected.map(r => r.reason), ["missing_claim_response"]);
});

test("a saturated mandatory name closure reports the size of a rejected AI-public batch", async () => {
  let graph = createReferenceGraph({ slots, memoryPruneVersion: CLAIM_PRUNE_V2 });
  for (let used = 0; used < REFERENCE_LIMITS.records; used += REFERENCE_LIMITS.operations) {
    const turn = graph.lastTurn + 1;
    graph = apply(graph, turn, Array.from({ length: Math.min(REFERENCE_LIMITS.records - used, REFERENCE_LIMITS.operations) },
      (_, index) => ({ ...proposal(turn), id: turn + ":name" + index, issueId: "1:name0" })));
  }
  const aiSeq = graph.lastTurn + 1;
  const turn = aiSeq + 1;
  const text = "切れ込みが見えます。";
  const state: AiPublicState = { schema: 1, log: [], omitted: 0,
    pending: { aiSeq, textSha256: await aiHash(text),
      status: "ready", reasons: [], candidates: [1, 2].map(ordinal => ({
        targets: [left], aspect: "part", act: "assert", proposition: "切れ込み", name: null, quote: text,
        speaker: "ai", source: "ai_hypothesis", sourceTurn: aiSeq, respondsTo: null, ordinal, candidateKey: "c" + ordinal,
        segmentId: "s" + ordinal, issueId: null,
      })) } };
  const operation = { expectedRevision: graph.revision, turn, operations: [] };
  const [publicTurn] = [{ turn: aiSeq, speaker: "ai" as const, text }];
  const result = await prependAiPublic({ graph, update: operation, state, events: [{ seq: aiSeq, speaker: "ai", text }], publicTurns: [publicTurn] });
  assert.deepEqual(result.update, operation);
  assert.equal(result.application.status, "not_applied");
  assert.deepEqual(result.application.reasons, ["memory_capacity_exceeded"]);
  assert.equal(result.application.capacityRejectedClaims, 2);
  assert.equal(memoryCapacityRejectedClaims([{ aiPublic: { application: result.application } } as JevTurnTrace]), 2);
});

test("private diagnostics report the final mismatch while an unassigned slot can still be submitted", async () => {
  const trial = createTrialV2({ seed: 19 });
  const ids = modelView(trial).anchors.map((anchor: { id: string }) => anchor.id);
  const names = Object.fromEntries(ids.map((id: string, index: number) => [id, index === 0 ? "小舟" : null]));
  let saved: { diagnostics?: unknown; aiSubmission?: unknown } = {};
  const task = await createNamingTaskV2({ strategy: "repair-first", seed: 19, runDir: null,
    memoryPruneVersion: CLAIM_PRUNE_V2, createTrial: () => trial, onPersist: (record: typeof saved) => { saved = record; },
    client: { complete(_messages: unknown, options: { phase: string }) {
      assert.equal(options.phase, "final_submission");
      return { text: JSON.stringify(names) };
    } },
  });
  assert.deepEqual(saved.diagnostics, { memoryCapacityRejectedClaims: 0, ledgerFinalMismatch: null });
  await task.submitAI();
  assert.deepEqual(saved.aiSubmission, names);
  const diagnostics = saved.diagnostics as { memoryCapacityRejectedClaims: number; ledgerFinalMismatch: unknown };
  assert.equal(diagnostics.memoryCapacityRejectedClaims, 0);
  assert.deepEqual(diagnostics.ledgerFinalMismatch, { count: 1, slots: [ids[0]] });
  assert.ok(!Object.hasOwn(task.getState(), "diagnostics"));
});

test("both reception conditions bind the approved pruning version through the record", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const protocolId = "22222222-2222-4222-8222-222222222222";
  const now = "2000-01-01T00:00:00.000Z";
  const protocol = { schemaVersion: "reception_protocol_v1", protocolId, revision: 1,
    allowedOrders: [["repair-first", "bypass-enabled"]], referenceMemory: true, seedPolicy: "shared",
    betweenTrials: "none", receptionNumberFormat: "daily_seq3" };
  const pending = createReception({ receptionId: id, objectId: "a".repeat(64), createdAt: now, number: null });
  const approval = { expectedRevision: 0, order: 0, protocol, approvedAt: now, randomSeed: () => 1 };
  const old = await approveReception(pending, approval);
  const fresh = await approveReception(pending, { ...approval, memoryPruneVersion: CLAIM_PRUNE_V2 });
  assert.ok(old.plan && fresh.plan);
  assert.deepEqual(validateReceptionPlan(old.plan), old.plan);
  assert.ok(!Object.hasOwn(old.plan, "memoryPruneVersion"));
  assert.throws(() => validateReceptionPlan({ ...fresh.plan!, memoryPruneVersion: "unsupported" }));
  for (const plan of [old.plan, fresh.plan]) {
    for (const trial of plan.trials) {
      const assignment = readAssignment({ schemaVersion: "base_assignment_v1", assignmentId: id, strategy: trial.strategy,
        seed: trial.seed, referenceMemory: trial.referenceMemory, createdAt: now, source: { kind: plan.schemaVersion,
          adapter: "worker_binding", receptionId: id, protocolId, protocolRevision: plan.protocolRevision,
          protocolSha256: plan.protocolSha256, trialIndex: trial.index, plan } });
      const version = assignmentMemoryPruneVersion(assignment);
      assert.equal(version, plan === fresh.plan ? CLAIM_PRUNE_V2 : undefined);
      const marker = version ? { memoryPruneVersion: version } : {};
      const record = { recordId: id, version: 2, seed: trial.seed, strategy: trial.strategy, assignment,
        status: "dialogue", options: { referenceMemory: true, ...marker },
        queueState: { pendingHumanEventIds: [], errorCode: null, privateState: { graph: createReferenceGraph(marker) } } };
      assert.doesNotThrow(() => validateBoundBaseRecord(record, assignment));
      const changed = structuredClone(record);
      changed.queueState.privateState.graph = createReferenceGraph(version ? {} : { memoryPruneVersion: CLAIM_PRUNE_V2 });
      assert.throws(() => validateBoundBaseRecord(changed, assignment), { code: "assignment_record_invalid" });
    }
  }
});

test("an explicit local research setting is frozen for both strategies and survives a cold restore", async () => {
  for (const strategy of ["repair-first", "bypass-enabled"] as const) {
    const h = harness({ config: { ...config(), strategy, referenceMemory: true } });
    const fake = h.options as unknown as BaseSessionOptions;
    const factory = fake.makeTask;
    const options: BaseSessionOptions = {
      ...fake,
      makeTask: input =>
        factory({ ...input, onPersist: record => {
          const version = input.memoryPruneVersion;
          const marker = version ? { memoryPruneVersion: version } : {};
          return input.onPersist({ ...record, options: { ...record.options, ...marker },
            queueState: { ...record.queueState, privateState: { graph: createReferenceGraph(marker) } } });
        } }),
    };
    const server = createBaseAssignmentSession({ ...options, memoryPruneVersion: CLAIM_PRUNE_V2 });
    await server.start({ version: 2 });
    const saved = h.state.admissions.initial.record;
    assert.equal(saved.assignment.source.memoryPruneVersion, CLAIM_PRUNE_V2);
    assert.equal(saved.options.memoryPruneVersion, CLAIM_PRUNE_V2);
    assert.equal(saved.queueState.privateState.graph.memoryPruneVersion, CLAIM_PRUNE_V2);
    assert.equal((await createBaseAssignmentSession(options).restore()).kind, "restored");
    assert.equal(h.tasks.at(-1).input.memoryPruneVersion, CLAIM_PRUNE_V2);
  }
});

test("S4 accepts the recorded pruning version and rejects a trial/tape disagreement", async () => {
  const records = JSON.parse(await readFile(new URL("./support/s4-integration/i172/NORMAL-RECORDS.json", import.meta.url), "utf8"));
  const trial = records.trials[0];
  const replay = trial.replay[0];
  const own = {
    ownImage: { mimeType: "image/png" as const, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQZkAAAAASUVORK5CYII=" },
    ownAnchors: replay.result.sides[0].material.own.ownAnchors,
  };
  const model = replay.result.sides[0].material.model;
  trial.memoryPruneVersion = CLAIM_PRUNE_V2;
  for (const state of [replay.tape.state, trial.lastCommittedState, ...trial.turns.map((turn: { state: unknown }) => turn.state)]) {
    state.graph.memoryPruneVersion = CLAIM_PRUNE_V2;
  }
  replay.result = await pairedInterventionReplay(replay.tape, own, model, trial.profile);
  assert.equal(replay.result.status, "same_material_intervention_verified");
  [records.evidence.pairedReplay[0].left, records.evidence.pairedReplay[0].right] = replay.result.sides;
  records.run.promptSources = await promptSourceManifest();
  trial.identity.prompts = hash(records.run.promptSources);
  const status = () => interventionChecks(records).find(check => check.id.endsWith(".replay"))?.status;
  assert.equal(status(), "pass");
  delete trial.memoryPruneVersion;
  assert.equal(status(), "mismatch");
});
