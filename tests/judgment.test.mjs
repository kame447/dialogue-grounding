import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";
import { createLunaJudge, createJevJudge, createOwnLedger, validateOwnLedger, validateJudgment, applyJudgment, SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/index.mjs";
import { JUDGE_POLICIES } from "../dialogue-model/runtime/judgment/instructions.mjs";
const image = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
const judgment = (extra = {}) => ({ ...SAFE_JUDGMENT, ...extra });
const input = (extra = {}) => ({ image, strategy: "repair-first", publicHistory: [{ role: "user", content: "公開発話" }], ownLedger: createOwnLedger(), ...extra });
async function mock(t, replies) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ model: "same-model", choices: [{ message: { content: replies[requests.length - 1] } }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  return { requests, client: createChatClient({ provider: "cloudflare", purpose: "dialogue_turn", apiKey: "local-test",
    baseUrl: "http://127.0.0.1:" + server.address().port + "/v1" }) };
}

test("typed Judgment rejects unknown fields/actions, invalid slots and incomplete acts", () => {
  for (const value of [null, {}, { ...SAFE_JUDGMENT, action: "score" }, { ...SAFE_JUDGMENT, targetSlot: "F1" },
    { ...SAFE_JUDGMENT, key: "forbidden" }, { ...SAFE_JUDGMENT, note: 2 },
    judgment({ action: "propose_name", candidateName: "名前" }), judgment({ action: "confirm" }),
    judgment({ action: "agree", targetSlot: "上段左" })]) assert.throws(() => validateJudgment(value));
  assert.deepEqual(validateJudgment(SAFE_JUDGMENT), SAFE_JUDGMENT);
  const invalidLedger = createOwnLedger(); invalidLedger["上段左"].status = "agreed";
  assert.throws(() => validateOwnLedger(invalidLedger), /invalid_ledger/);
});

test("remembered slot renaming requires repair and can explicitly release a wrong correspondence", () => {
  for (const status of ["tentative", "agreed", "deferred"]) {
    const ledger = createOwnLedger(); ledger["下段右"] = { status, name: "最初の名称" };
    for (const action of ["accept", "propose_name", "agree", "defer", "revisit", "confirm"]) {
      assert.throws(() => validateJudgment(judgment({ action, targetSlot: "下段右", candidateName: "別の名称", discriminatingFeature: "細長さ" }), { ownLedger: ledger }), /reassignment_requires_repair/);
    }
    const repaired = applyJudgment(ledger, judgment({ action: "repair", targetSlot: "下段右", candidateName: "別の名称" }));
    assert.deepEqual(repaired["下段右"], { status: "tentative", name: "別の名称" });
    assert.equal(ledger["下段右"].name, "最初の名称");
    assert.deepEqual(applyJudgment(ledger, judgment({ action: "repair", targetSlot: "下段右" }))["下段右"], { status: "unassigned", name: null });
  }
});

test("ledger transitions come only from typed acts, retain deferred names and support agreement/revisit", () => {
  let ledger = applyJudgment(createOwnLedger(), judgment({ action: "propose_name", targetSlot: "上段中", candidateName: "呼び名" }));
  assert.equal(ledger["上段中"].status, "tentative");
  ledger = applyJudgment(ledger, judgment({ action: "defer", targetSlot: "上段中" }));
  assert.deepEqual(ledger["上段中"], { status: "deferred", name: "呼び名" });
  ledger = applyJudgment(ledger, judgment({ action: "revisit", targetSlot: "上段中" }));
  assert.equal(ledger["上段中"].status, "tentative");
  ledger = applyJudgment(ledger, judgment({ action: "agree", targetSlot: "上段中" }));
  assert.deepEqual(ledger["上段中"], { status: "agreed", name: "呼び名" });
  assert.deepEqual(applyJudgment(ledger, SAFE_JUDGMENT), ledger);
});

test("confirm keeps its named candidate tentative until an explicit agree", () => {
  const confirm = judgment({ action: "confirm", targetSlot: "上段右", candidateName: "候補名", discriminatingFeature: "候補間で異なるくぼみ" });
  let ledger = applyJudgment(createOwnLedger(), confirm);
  assert.deepEqual(ledger["上段右"], { status: "tentative", name: "候補名" });
  ledger = applyJudgment(ledger, judgment({ action: "agree", targetSlot: "上段右", candidateName: "候補名" }));
  assert.deepEqual(ledger["上段右"], { status: "agreed", name: "候補名" });
  assert.deepEqual(applyJudgment(ledger, confirm)["上段右"], { status: "tentative", name: "候補名" });
  assert.deepEqual(applyJudgment(ledger, judgment({ ...confirm, candidateName: null }))["上段右"], ledger["上段右"]);
});

test("a name cannot enter two slots, even by repair, until the original correspondence is explicitly released", () => {
  for (const status of ["tentative", "agreed", "deferred"]) {
    const ledger = createOwnLedger(); ledger["上段左"] = { status, name: "共有名" };
    for (const action of ["accept", "propose_name", "confirm", "agree", "repair", "defer", "revisit"]) {
      const duplicate = judgment({ action, targetSlot: "下段右", candidateName: " 共有名 ", discriminatingFeature: "候補間の違い" });
      assert.throws(() => validateJudgment(duplicate, { ownLedger: ledger }), /duplicate_name_requires_repair/);
      assert.throws(() => applyJudgment(ledger, duplicate), /duplicate_name_requires_repair/);
      assert.equal(ledger["下段右"].name, null);
    }
    const released = applyJudgment(ledger, judgment({ action: "repair", targetSlot: "上段左" }));
    const reassigned = applyJudgment(released, judgment({ action: "propose_name", targetSlot: "下段右", candidateName: "共有名" }));
    assert.deepEqual(reassigned["上段左"], { status: "unassigned", name: null });
    assert.deepEqual(reassigned["下段右"], { status: "tentative", name: "共有名" });
    assert.equal(ledger["上段左"].name, "共有名");
    assert.deepEqual(applyJudgment(ledger, judgment({ action: "agree", targetSlot: "上段左" }))["上段左"], { status: "agreed", name: "共有名" });
  }
});

test("judge uses own image/public history/whitelisted own notes and differs only by strategy policy", async (t) => {
  const { client, requests } = await mock(t, [JSON.stringify(SAFE_JUDGMENT), JSON.stringify(SAFE_JUDGMENT)]);
  const judge = createLunaJudge(client);
  const ownImageWithForbiddenMetadata = { ...image, key: "PRIVATE-KEY", humanImage: "HUMAN-PNG", figureId: "PRIVATE-FIGURE-ID" };
  const publicHistory = [{ role: "user", content: "公開発話", future: "FUTURE-TURN" }];
  await judge.judge(input({ image: ownImageWithForbiddenMetadata, publicHistory }));
  await judge.judge(input({ strategy: "bypass-enabled", image: ownImageWithForbiddenMetadata, publicHistory }));
  assert.notEqual(requests[0].messages[1].content, requests[1].messages[1].content);
  const withoutPolicy = (body) => ({ ...body, messages: body.messages.filter((_, i) => i !== 1) });
  assert.deepEqual(withoutPolicy(requests[0]), withoutPolicy(requests[1]));
  assert.equal(requests[0].purpose, "dialogue_turn"); assert.ok(!Object.hasOwn(requests[0], "model"));
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE-KEY|HUMAN-PNG|PRIVATE-FIGURE-ID|FUTURE-TURN/);
  assert.match(requests[0].messages[0].content, /相手の画面では配置も向きも異な/);
  for (const policy of Object.values(JUDGE_POLICIES)) assert.equal(policy.split("\n").length, 4);
  const common = requests[0].messages[2].content;
  assert.match(common, /必ずagree/u);
  assert.match(common, /直前のtargetSlotを維持/u);
  assert.match(common, /別の枠と解釈し直す場合はrepair/u);
  assert.match(common, /自分の候補が複数あるとき、それらを互いに区別する/u);
  assert.match(common, /相手の説明の単なる言い換え/u);
});

test("judge receives candidate names from own prior acts but strips unrelated history metadata", async (t) => {
  const { client, requests } = await mock(t, [JSON.stringify(SAFE_JUDGMENT)]);
  const judge = createLunaJudge(client);
  await judge.judge(input({ ownJudgmentHistory: [{ action: "confirm", targetSlot: "下段左", candidateName: "候補名",
    note: "PRIVATE-NOTE", figureId: "PRIVATE-FIGURE-ID", future: "FUTURE-TURN", key: "PRIVATE-KEY" }] }));
  const message = requests[0].messages.find((m) => typeof m.content === "string" && m.content.includes('"ownJudgmentHistory"'));
  const notes = JSON.parse(message.content.slice(message.content.indexOf("\n") + 1));
  assert.deepEqual(notes.ownJudgmentHistory, [{ action: "confirm", targetSlot: "下段左", candidateName: "候補名" }]);
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE-NOTE|PRIVATE-FIGURE-ID|FUTURE-TURN|PRIVATE-KEY/);
  for (const candidateName of [2, "", " ", "a".repeat(201)]) {
    await assert.rejects(judge.judge(input({ ownJudgmentHistory: [{ action: "confirm", targetSlot: "下段左", candidateName }] })), /Invalid own judgment history/);
  }
  assert.equal(requests.length, 1);
});

test("invalid JSON retries once then falls back safely, logging no raw model output", async (t) => {
  const { client, requests } = await mock(t, ["RAW-PRIVATE-INVALID", '{"action":"invalid"}']);
  const judge = createLunaJudge(client);
  assert.deepEqual(await judge.judge(input()), SAFE_JUDGMENT);
  assert.equal(requests.length, 2); assert.doesNotMatch(JSON.stringify(requests), /RAW-PRIVATE-INVALID/);
  assert.deepEqual(judge.getDiagnostics(), [{ attempts: 2, fallback: true, failures: ["invalid_json", "invalid_judgment"] }]);
  const diagnostics = judge.getDiagnostics(); diagnostics[0].fallback = false;
  assert.equal(judge.getDiagnostics()[0].fallback, true);
});

test("judge detects a non-repair rename before generation and accepts one corrected repair", async (t) => {
  const proposed = judgment({ action: "propose_name", targetSlot: "下段右", candidateName: "変更名" });
  const repaired = { ...proposed, action: "repair" };
  const { client, requests } = await mock(t, [JSON.stringify(proposed), JSON.stringify(repaired)]);
  const ledger = createOwnLedger(); ledger["下段右"] = { status: "agreed", name: "元の名" };
  const judge = createLunaJudge(client);
  assert.deepEqual(await judge.judge(input({ ownLedger: ledger })), repaired);
  assert.equal(requests.length, 2); assert.match(requests[1].messages.at(-1).content, /reassignment_requires_repair/);
  assert.equal(ledger["下段右"].name, "元の名");
  assert.deepEqual(judge.getDiagnostics()[0], { attempts: 2, fallback: false, failures: ["reassignment_requires_repair"] });
});

test("duplicate-name judgment retries once and permits only an explicit release before reassignment", async (t) => {
  const duplicate = judgment({ action: "confirm", targetSlot: "下段右", candidateName: "既存名", discriminatingFeature: "候補を区別する特徴" });
  const release = judgment({ action: "repair", targetSlot: "上段中" });
  const { client, requests } = await mock(t, [JSON.stringify(duplicate), JSON.stringify(release)]);
  const ledger = createOwnLedger(); ledger["上段中"] = { status: "agreed", name: "既存名" };
  const judge = createLunaJudge(client);
  assert.deepEqual(await judge.judge(input({ ownLedger: ledger })), release);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /duplicate_name_requires_repair/);
  assert.deepEqual(judge.getDiagnostics(), [{ attempts: 2, fallback: false, failures: ["duplicate_name_requires_repair"] }]);
  assert.equal(ledger["上段中"].name, "既存名");
});

test("repeated duplicate-name judgments fall back without changing the ledger", async (t) => {
  const duplicate = judgment({ action: "agree", targetSlot: "下段右", candidateName: "既存名" });
  const { client, requests } = await mock(t, [JSON.stringify(duplicate), JSON.stringify(duplicate)]);
  const ledger = createOwnLedger(); ledger["上段中"] = { status: "deferred", name: "既存名" };
  const judge = createLunaJudge(client), before = structuredClone(ledger);
  const value = await judge.judge(input({ ownLedger: ledger }));
  assert.deepEqual(value, SAFE_JUDGMENT);
  assert.deepEqual(applyJudgment(ledger, value), before);
  assert.equal(requests.length, 2);
  assert.deepEqual(judge.getDiagnostics(), [{ attempts: 2, fallback: true, failures: ["duplicate_name_requires_repair", "duplicate_name_requires_repair"] }]);
});

test("Jev remains an explicit unimplemented adapter", () => {
  assert.throws(() => createJevJudge(), /not implemented/);
});
