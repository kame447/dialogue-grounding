import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveActiveJudgment } from "../dialogue-model/runtime/v2/active-judge.mjs";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { startNamingServer, main as serverMain } from "../dialogue-model/runtime/web/server.mjs";
import { createOwnLedger, SAFE_JUDGMENT, applyJudgment, validateJudgment } from "../dialogue-model/runtime/judgment/schema.mjs";
import { DECISION_ACTIONS, DECISION_MODELS } from "../workers/research-ai-proxy/src/decisions.mjs";

const ids = Array.from({ length: 6 }, (_, index) => `s-000${index + 1}`);
const anchors = ids.map((id, index) => ({ id, bbox: { x: index, y: 0, w: 1, h: 1 }, centroid: { x: index, y: 0 } }));
const ledger = () => createOwnLedger(ids);
const luna = (changes = {}) => ({ ...SAFE_JUDGMENT, action: "propose_name", targetSlot: ids[0], candidateName: "鳥", discriminatingFeature: "細長い部分が一つある", ...changes });
const probabilityMap = (values) => Object.fromEntries(DECISION_ACTIONS.map((action) => [action, values[action] ?? 0]));
const decision = (action, values = { [action]: 1 }, extras = {}) => ({ purpose: "decision_jev", model: DECISION_MODELS.decision_jev,
  action, probabilities: probabilityMap(values), latencyMs: 12, usage: { costUsd: 0.000001 }, ...extras });
const resolve = (lunaJudgment, selected, ownLedger = ledger(), strategy = "repair-first") => resolveActiveJudgment({ lunaJudgment, decision: selected, ownLedger, strategy });
const reference = () => ({ slots: [ids[0]], epistemic: "grounded", intent: "feature_assertion", feature: { slot: ids[0], feature: "細長い", polarity: "confirmed" }, nameAcceptance: null, deferSlot: null, revisitSlot: null });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function dialogue(options = {}) {
  return createDialogueV2({ client: { async complete() { return { text: "公開応答" }; } }, judge: { async judge() { return luna(); } },
    strategy: "repair-first", image: { mimeType: "image/png", base64: "c3ludGhldGlj" }, anchors, ...options });
}
const events = [{ id: "event-1", seq: 1, turn: 1, speaker: "human", text: "細長い形があります", at: "2026-01-01T00:00:00.000Z" }];
const run = (session, changes = {}) => session.runAiTurn({ events, lastEventId: "event-1", privateState: session.initialPrivateState(), signal: new AbortController().signal, ...changes });

test("valid decision is synthesized from Luna interpretation, never from extra untrusted referents", () => {
  const selected = decision("defer", undefined, { targetSlot: ids[5], candidateName: "PRIVATE-TOKEN", reference: "PRIVATE-KEY", followUp: "PRIVATE-TOKEN" });
  selected.probabilities["PRIVATE-KEY"] = "PRIVATE-TOKEN";
  const result = resolve(luna(), selected);
  assert.equal(result.record.resolution, "decision"); assert.equal(result.judgment.action, "defer");
  assert.equal(result.judgment.targetSlot, ids[0]); assert.equal(result.judgment.candidateName, "鳥");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-/);
  assert.deepEqual(Object.keys(result.record.probabilities), DECISION_ACTIONS);
  assert.equal(result.record.latencyMs, 12); assert.equal(result.record.costUsd, 0.000001);
});

test("invalid action requirements rerank highest positive support with deterministic Worker-order ties", () => {
  const interpretation = luna({ discriminatingFeature: null });
  const result = resolve(interpretation, decision("confirm", { confirm: 0.6, propose_name: 0.2, defer: 0.2 }));
  assert.equal(result.judgment.action, "propose_name"); assert.equal(result.record.resolution, "rerank");
  assert.deepEqual(result.record.rejectedCandidates, [{ action: "confirm", code: "inconsistent_action" }]);
});

test("agree on unassigned or deferred slots never bypasses v2 schema guards", () => {
  for (const status of ["unassigned", "deferred"]) {
    const own = ledger(); own[ids[0]] = { status, name: status === "deferred" ? "鳥" : null };
    const result = resolve(luna(), decision("agree", { agree: 0.8, propose_name: 0.2 }), own);
    assert.equal(result.judgment.action, "propose_name");
    assert.equal(result.record.rejectedCandidates[0].code, "agree_ineligible");
    assert.notEqual(applyJudgment(own, result.judgment)[ids[0]].status, "agreed");
    // Even a malformed interpreter cannot waive agreeEvidence itself.
    const guarded = resolve(luna({ action: "agree" }), decision("agree", { agree: 0.8, accept: 0.2 }), own);
    assert.equal(guarded.judgment.action, "accept");
    assert.equal(guarded.record.rejectedCandidates[0].code, "agree_requires_shared_identification");
  }
});

test("active model may delay agreement but cannot upgrade Luna confirm on tentative ambiguity", () => {
  const own = ledger(); own[ids[0]] = { status: "tentative", name: "鳥" };
  const result = resolve(luna({ action: "confirm" }), decision("agree", { agree: 0.9, confirm: 0.1 }), own);
  assert.equal(result.judgment.action, "confirm"); assert.equal(result.record.resolution, "rerank");
  assert.notEqual(applyJudgment(own, result.judgment)[ids[0]].status, "agreed");
  const veto = resolve(luna({ action: "agree" }), decision("confirm"), own);
  assert.equal(veto.judgment.action, "confirm"); assert.equal(veto.record.resolution, "decision");
  assert.equal(resolve(luna({ action: "agree" }), decision("agree"), own).judgment.action, "agree");
});

test("no valid positive-support alternative yields safe_accept with no invented target/name", () => {
  const interpretation = { ...SAFE_JUDGMENT };
  const result = resolve(interpretation, decision("propose_name"));
  assert.equal(result.record.resolution, "safe_accept"); assert.deepEqual(result.judgment, SAFE_JUDGMENT);
  assert.deepEqual(result.record.rejectedCandidates, [{ action: "propose_name", code: "inconsistent_action" }]);
});

test("error and malformed probabilities fall back unchanged, preserving valid followUp", () => {
  const interpretation = luna({ followUp: { action: "confirm", targetSlot: ids[1], candidateName: null, discriminatingFeature: "突起が三つある" } });
  const bad = [new Error("PRIVATE-KEY"), { error: Object.assign(new Error("PRIVATE-TOKEN"), { code: "payment_required" }) }, null,
    decision("close", {}), decision("close", { close: 1, accept: 0.5 }), decision("close", { accept: 1 }),
    decision("close", { close: NaN }), { action: "close", probabilities: { close: 1 } }];
  for (const value of bad) {
    const result = resolve(interpretation, value);
    assert.equal(result.record.resolution, "fallback"); assert.deepEqual(result.judgment, interpretation);
    assert.equal(result.record.droppedFollowUp, false);
    assert.doesNotMatch(JSON.stringify(result.record), /PRIVATE-/);
  }
  assert.equal(resolve(interpretation, bad[1]).record.error, "payment_required");
});

test("rounded Jev probability mass0.99 is accepted while mass0 or1.5 is malformed", () => {
  const result = resolve(luna(), decision("defer", { defer: 0.89, accept: 0.1 }));
  assert.equal(result.record.resolution, "decision"); assert.equal(result.judgment.action, "defer");
  for (const mass of [0.98, 1.02]) {
    const boundary = resolve(luna(), decision("defer", { defer: 0.9, accept: mass - 0.9 }));
    assert.equal(boundary.record.resolution, "decision");
  }
});

test("action-specific normalization keeps only feasible schema fields", () => {
  for (const action of ["accept", "move_on", "close"]) {
    const result = resolve(luna(), decision(action));
    assert.equal(result.judgment.candidateName, null); assert.equal(result.judgment.targetSlot, ids[0]);
    assert.equal(result.judgment.discriminatingFeature, luna().discriminatingFeature);
  }
  for (const action of ["propose_name", "confirm", "defer", "revisit", "repair"]) {
    const result = resolve(luna(), decision(action));
    assert.equal(result.judgment.action, action); assert.equal(result.judgment.targetSlot, ids[0]);
    validateJudgment(result.judgment, { ownLedger: ledger(), agreeEvidence: true });
  }
  for (const action of ["propose_name", "defer", "revisit", "repair"]) {
    const result = resolve({ ...SAFE_JUDGMENT }, decision(action));
    assert.equal(result.record.resolution, "safe_accept");
  }
});

test("followUp retained only for unchanged action; reference independently validated and detached", () => {
  const interpretation = luna({ followUp: { action: "confirm", targetSlot: ids[1], candidateName: null, discriminatingFeature: "突起が三つある" }, reference: reference() });
  const kept = resolve(interpretation, decision("propose_name"));
  assert.deepEqual(kept.judgment.followUp, interpretation.followUp); assert.equal(kept.record.droppedFollowUp, false);
  const changed = resolve(interpretation, decision("defer"));
  assert.equal(changed.judgment.followUp, undefined); assert.equal(changed.record.droppedFollowUp, true);
  assert.deepEqual(changed.judgment.reference, interpretation.reference); assert.equal(changed.record.droppedReference, false);
  changed.judgment.reference.slots.length = 0; assert.equal(interpretation.reference.slots.length, 1);
  const dropped = resolve(luna({ reference: { slots: ["foreign"], secret: "PRIVATE-KEY" } }), decision("defer"));
  assert.equal(dropped.judgment.reference, null); assert.equal(dropped.record.droppedReference, true);
  assert.doesNotMatch(JSON.stringify(dropped), /PRIVATE-KEY/);
});

test("active decision is action-only, uses exact shadow evidence and final judgment drives ledger/memory/generation", async () => {
  const calls = [], requests = [];
  const session = dialogue({ referenceMemory: true, judge: { async judge() { return luna({ reference: reference() }); } },
    client: { async complete(messages, options) { calls.push({ messages, options }); return { text: "少し後にしましょう。" }; } },
    activeDecision: { purpose: "decision_jev", client: { async chooseAction(request) { requests.push(request); return decision("defer"); } } } });
  const result = await run(session);
  const state = JSON.parse(requests[0].state);
  assert.deepEqual(Object.keys(requests[0]), ["purpose", "state"]); assert.equal(requests[0].purpose, "decision_jev");
  assert.deepEqual(state.publicUtterances, [{ speaker: "相手", text: events[0].text }]);
  assert.doesNotMatch(requests[0].state, /image|reference|"action"|followUp/);
  assert.equal(result.privateState.ledger[ids[0]].status, "deferred");
  assert.ok(result.privateState.graph.records.some((entry) => entry.kind === "feature" && entry.feature === "細長い"));
  assert.equal(result.privateState.judgments[0].judgment.action, "defer");
  assert.equal(result.privateState.judgments[0].activeJudge.finalAction, "defer");
  assert.equal(calls.length, 1); assert.match(JSON.stringify(calls[0].messages), /\\"action\\":\\"defer\\"/);
});

test("abort during either successful or rejecting decision wait makes zero generation calls", async () => {
  for (const rejects of [false, true]) {
    const started = deferred(), wait = deferred(), controller = new AbortController(); let generated = 0;
    const session = dialogue({ client: { async complete() { generated++; return { text: "must not generate" }; } },
      activeDecision: { purpose: "decision_jev", client: { async chooseAction() { started.resolve(); await wait.promise;
        if (rejects) throw new Error("PRIVATE-abort"); return decision("defer"); } } } });
    const pending = run(session, { signal: controller.signal });
    await started.promise; controller.abort(); wait.resolve();
    await assert.rejects(pending, (error) => error.name === "AbortError"); assert.equal(generated, 0);
  }
});

test("default off and explicit null are byte-identical; active/shadow together and invalid purposes fail", async () => {
  const executions = [];
  for (const options of [{}, { activeDecision: null }]) {
    const calls = [];
    const session = dialogue({ ...options, client: { async complete(messages, config) { calls.push({ messages, config }); return { text: "公開応答" }; } } });
    executions.push({ result: await run(session), calls, attempts: session.getAttempts() });
  }
  assert.deepEqual(executions[0], executions[1]); assert.doesNotMatch(JSON.stringify(executions[0]), /activeJudge|activeDecision/);
  assert.throws(() => dialogue({ activeDecision: { purpose: "unknown", client: {} } }), /Invalid active/);
  assert.throws(() => dialogue({ activeDecision: { purpose: "decision_jev", client: { chooseAction() {} } }, decisionShadowClient: { chooseAction() {} } }), /mutually exclusive/);
});

const ownIdsFrom = (messages) => {
  const text = messages.filter((message) => typeof message.content === "string").map((message) => message.content).join("\n");
  const match = text.match(/内部参照ID（非公開[^\n]*\n(\[.*\])/);
  return match ? JSON.parse(match[1]).map((anchor) => anchor.id) : [];
};
function modelClient() {
  const calls = [];
  return { calls, async complete(messages, { phase } = {}) {
    calls.push({ messages, phase });
    if (phase === "judgment") return { text: JSON.stringify(luna({ targetSlot: ownIdsFrom(messages)[0] })) };
    if (phase === "final_submission") return { text: JSON.stringify(Object.fromEntries(ownIdsFrom(messages).map((id, index) => [id, "合成名" + index]))) };
    return { text: "少し後にしましょう。" };
  } };
}
async function app(t, options = {}) {
  let task;
  const client = modelClient();
  const server = await startNamingServer({ port: 0, client, runDir: "", ...options,
    async createTaskV2(args) { task = await createNamingTaskV2(args); return task; } });
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const cookie = (await fetch(base)).headers.get("set-cookie").split(";")[0];
  const request = (path, body) => fetch(base + path, { headers: { cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { request, client, task: () => task };
}

test("mock active v2 HTTP session reaches submissions/scoring without exposing mode, records or credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "active-v2-record-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const web = await app(t, { runDir: directory, activeDecision: { purpose: "decision_jev", client: { apiKey: "PRIVATE-KEY", async chooseAction(request) { requests.push(request); return decision("defer", undefined, { token: "PRIVATE-TOKEN" }); } } } });
  const started = await web.request("/api/start", { version: 2, strategy: "repair-first", seed: 81, activeDecision: "participant-cannot-override" });
  assert.equal(started.status, 200);
  assert.equal((await web.request("/api/message", { text: "鳥みたいな形があります" })).status, 202);
  await web.task().whenIdle();
  let state = await (await web.request("/api/state")).json();
  assert.equal(requests.length, 1); assert.equal(state.trial.result, undefined);
  assert.doesNotMatch(JSON.stringify(state), /activeDecision|activeJudge|decision_jev|PRIVATE-|rejectedCandidates/);
  const names = Object.fromEntries(state.trial.scene.shapes.map((shape, index) => [shape.id, "合成名" + index]));
  const submitted = await web.request("/api/names", { names, confirm: true }); assert.equal(submitted.status, 200);
  state = await submitted.json(); assert.equal(state.trial.status, "completed");
  // The result stays withheld until the questionnaire is submitted.
  assert.equal(state.trial.result, undefined); assert.equal(state.trial.resultLocked, true);
  assert.equal((await web.request(`/api/records/${state.trial.sessionId}/questionnaire`, { answers: { mental_effort: 4, task_difficulty: 4, smoothness: 4, bothersome: 4 }, submit: true })).status, 200);
  state = await (await web.request("/api/state")).json(); assert.equal(state.trial.resultLocked, false); assert.equal(state.trial.result.total, 6);
  const [filename] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  const record = JSON.parse(await readFile(join(directory, filename), "utf8"));
  assert.equal(record.options.activeDecision, "decision_jev"); assert.equal(record.judgments[0].activeJudge.finalAction, "defer");
  assert.ok(record.scoring); assert.doesNotMatch(JSON.stringify(record), /PRIVATE-KEY|PRIVATE-TOKEN|apiKey/);
  for (const request of requests) for (const humanId of Object.keys(names)) assert.ok(!request.state.includes(humanId));
});

test("participants cannot turn active mode on through API fields when researcher configuration is absent", async (t) => {
  const web = await app(t);
  assert.equal((await web.request("/api/start", { version: 2, strategy: "repair-first", seed: 82, activeDecision: { purpose: "decision_jev" }, "active-decision-judge": "decision_jev" })).status, 200);
  await web.request("/api/message", { text: "これは鳥かな" }); await web.task().whenIdle();
  assert.equal(web.task().researcherView().attempts[0].activeJudge, undefined);
  assert.doesNotMatch(JSON.stringify(await (await web.request("/api/state")).json()), /activeDecision|activeJudge|decision_jev/);
});

test("CLI builds a decision client only for the researcher flag and never logs credentials", async () => {
  const env = { RESEARCH_AI_PROVIDER: "cloudflare", RESEARCH_AI_BASE_URL: "https://research.example/v1", RESEARCH_PROXY_TOKEN: "PRIVATE-TOKEN-with-at-least-thirty-two-chars", RESEARCH_RUN_DIR: "" };
  const outputs = [], original = console.log; let created = 0, configured;
  const deps = { createClient: () => modelClient(), createDecisionClient: () => { created++; return { chooseAction() {} }; },
    async startServer(options) { configured = options; return { address: () => ({ port: 1234 }) }; } };
  console.log = (...args) => outputs.push(args.join(" "));
  try {
    await serverMain(["--port", "0"], env, deps); assert.equal(created, 0); assert.equal(configured.activeDecision, null);
    await serverMain(["--port", "0", "--active-decision-judge", "decision_jev"], env, deps);
    assert.equal(created, 1); assert.equal(configured.activeDecision.purpose, "decision_jev");
    await assert.rejects(serverMain(["--active-decision-judge", "foreign"], env, deps), /Invalid active/);
  } finally { console.log = original; }
  assert.doesNotMatch(outputs.join("\n"), /PRIVATE-TOKEN|apiKey|RESEARCH_PROXY_TOKEN/);
});

test("v1 task factory never receives the active option", async (t) => {
  let received;
  const server = await startNamingServer({ port: 0, client: {}, runDir: "",
    activeDecision: { purpose: "decision_jev", client: { chooseAction() {} } },
    async createTask(options) { received = options; return { getState: () => ({ status: "dialogue", busy: false }) }; } });
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const cookie = (await fetch(base + "/v1/")).headers.get("set-cookie").split(";")[0];
  const response = await fetch(base + "/api/start", { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, strategy: "repair-first", seed: 1 }) });
  assert.equal(response.status, 200); assert.equal(Object.hasOwn(received, "activeDecision"), false);
});
