// Synthetic fixtures only; researcher-side aggregate tabulation.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyHumanTurn, TURN_TYPES } from "../dialogue-model/runtime/diagnostics/strategy-difference/turn-type.ts";
import { createTabulation, detect, familyKey, humanTextsPerJudgment, main } from "../dialogue-model/runtime/diagnostics/strategy-difference/tabulate.ts";
import { createOwnLedger } from "../dialogue-model/runtime/judgment/schema.mjs";

const CANARY = "SYNTHETIC_TEXT_CANARY";
const ids = ["s-0001", "s-0002", "s-0003", "s-0004", "s-0005", "s-0006"];
const ledger = (patch: Record<string, { status: string; name: string | null }> = {}) => ({ ...createOwnLedger(ids), ...patch });
const act = (action: string, targetSlot: string | null = null) => ({ action, targetSlot, candidateName: null, discriminatingFeature: null, note: null });

test("turn types follow a fixed priority over public text", () => {
  assert.equal(classifyHumanTurn(["さっきの舟に戻りましょう"]), "revisit_request");
  assert.equal(classifyHumanTurn(["うーん、迷う。これは後にしよう"]), "defer_request");
  assert.equal(classifyHumanTurn(["どっちだろう"]), "uncertainty");
  assert.equal(classifyHumanTurn(["はい、それで。次は帽子"]), "topic_shift");
  assert.equal(classifyHumanTurn(["それ、家って呼びませんか？"]), "naming_proposal");
  assert.equal(classifyHumanTurn(["そうです"]), "answer");
  assert.equal(classifyHumanTurn(["よろしくお願いします！"]), "greeting");
  assert.equal(classifyHumanTurn(["よろしくお願いします。細長い形があります"]), "description");
  assert.equal(classifyHumanTurn([]), "none");
  assert.ok(TURN_TYPES.includes("description"));
});

test("human texts per judgment come from public events (v2) or user history (v1)", () => {
  const v2 = { events: [{ seq: 1, speaker: "ai", text: "a" }, { seq: 2, speaker: "human", text: "h1" }, { seq: 3, speaker: "human", text: "h2" },
    { seq: 4, speaker: "ai", text: "b" }, { seq: 5, speaker: "human", text: "h3" }], judgments: [{ turnIndex: 3 }, { turnIndex: 5 }] };
  assert.deepEqual(humanTextsPerJudgment(v2), [["h1", "h2"], ["h3"]]);
  const v1 = { publicHistory: [{ role: "user", content: "u1" }, { role: "assistant", content: "a" }, { role: "user", content: "u2" }], judgments: [{ turnIndex: 1 }, { turnIndex: 2 }] };
  assert.deepEqual(humanTextsPerJudgment(v1), [["u1"], ["u2"]]);
});

test("tabulation counts Luna-own and final actions, turn types and functional bypassing, without texts", () => {
  const record = { strategy: "bypass-enabled", events: [
    { seq: 1, speaker: "human", text: CANARY + " 鳥みたい" }, { seq: 2, speaker: "ai", text: CANARY },
    { seq: 3, speaker: "human", text: CANARY + " 次は帽子" }, { seq: 4, speaker: "ai", text: CANARY },
    { seq: 5, speaker: "human", text: CANARY + " 鳥に戻りましょう" }],
  judgments: [
    { turnIndex: 1, judgment: act("confirm", "s-0001"), ownLedgerBefore: ledger(), activeJudge: { lunaAction: "propose_name" } },
    { turnIndex: 3, judgment: act("propose_name", "s-0002"), ownLedgerBefore: ledger({ "s-0001": { status: "deferred", name: "鳥" } }) },
    { turnIndex: 5, judgment: act("confirm", "s-0001"), ownLedgerBefore: ledger({ "s-0001": { status: "deferred", name: "鳥" } }) },
  ] };
  const tab = createTabulation();
  tab.add(record, "/x/run.json", "fam");
  tab.add([{ action: "defer" }], "/x/pilot-bypass-enabled.json", "fam");
  tab.add({ strategy: "repair-first", label: "p", turns: [{ acts: [{ action: "confirm" }] }] }, "/x/p.json", "fam");
  tab.add([{ caseId: "synthetic-028:bypass-enabled", purpose: "decision_jev", action: "defer", probabilities: { defer: 0.5, move_on: 0.2, revisit: 0 } }], "/x/rows.jsonl", "fam");
  tab.add([{ id: "synthetic-028:repair-first:def", judgment: act("accept"), diagnostics: {} }], "/x/replay.jsonl", "fam");
  tab.add({ ...record }, "/x/run-mock.json", "fam");
  tab.add({ nothing: true }, "/x/other.json", "fam");
  const s = tab.summary();
  const b = s.dialogue["bypass-enabled"];
  assert.equal(b.turns, 3);
  assert.deepEqual(b.luna, { propose_name: 2, confirm: 1 });
  assert.deepEqual(b.final, { confirm: 2, propose_name: 1 });
  assert.deepEqual(Object.keys(b.byTurnType).sort(), ["description", "revisit_request", "topic_shift"]);
  assert.deepEqual(b.functional, { switchAwayUnresolved: 2, switchAfterHumanShift: 1, returnToDeferred: 1, returnLabelledRevisit: 0 });
  assert.deepEqual(s.pilot, { "repair-first": { confirm: 1 }, "bypass-enabled": { defer: 1 } });
  assert.equal(s.decisions["decision_jev bypass-enabled"].byStratum.defer_request.defer, 1);
  assert.equal(s.decisions["decision_jev bypass-enabled"].deferLikeMass, 0.7);
  assert.deepEqual(s.replay["synthetic repair-first def"].actions, { accept: 1 });
  assert.deepEqual(s.skipped, { mock: 1, unrecognized: 1 });
  assert.ok(!JSON.stringify(s).includes(CANARY), "aggregates must not carry texts");
  assert.equal(detect({ strategy: "other", judgments: [] }, "a.json"), null);
});

test("cli scans directories, writes only outside the repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "sd-"));
  mkdirSync(join(root, "fam"));
  writeFileSync(join(root, "fam", "run.json"), JSON.stringify({ strategy: "repair-first", events: [{ seq: 1, speaker: "human", text: CANARY }],
    judgments: [{ turnIndex: 1, judgment: act("defer", "s-0001"), ownLedgerBefore: ledger() }] }));
  writeFileSync(join(root, "fam", "broken.json"), "{");
  const logs: string[] = [];
  const s = await main(["--scan", root, "--out", root], (line: string) => logs.push(line));
  assert.deepEqual(s.dialogue["repair-first"].families, { [familyKey("fam")]: { defer: 1 } });
  assert.match(familyKey("fam"), /^family-[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(s).includes('"fam"') && !logs.join("").includes('"fam"'), "directory names must not leak");
  assert.equal(s.skipped.unrecognized, 1);
  assert.ok(!logs.join("").includes(CANARY));
  await assert.rejects(main(["--scan", root, "--out", "dialogue-model"]), /repository_output_forbidden/);
  await assert.rejects(main(["--bogus", "x"]), /invalid_arguments/);
});
