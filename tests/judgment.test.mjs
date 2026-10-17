import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";
import { createLunaJudge, createJevJudge, createOwnLedger, validateOwnLedger, validateJudgment, applyJudgment, SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/index.mjs";
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

test("Jev remains an explicit unimplemented adapter", () => {
  assert.throws(() => createJevJudge(), /not implemented/);
});
