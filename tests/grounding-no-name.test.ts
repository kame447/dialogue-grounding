// grounding-criteria/v2: five-level name axis (no_name) and the recorded criteria version.
// Synthetic fixtures and mock judges only; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { handleRequest as handleWorkerRequest } from "../workers/research-ai-proxy/src/index.mjs";
import { GROUNDING_CRITERIA_VERSION, GROUNDING_LEVELS, GROUNDING_MODELS, NAME_AGREEMENT_CRITERIA, buildGroundingPayload,
  sanitizeGroundingVerdict } from "../workers/research-ai-proxy/src/grounding.ts";
import { createGroundingJudgeClient, createMockGroundingJudge, GroundingConnectionError, parseGroundingVerdict,
  type GroundingJudge } from "../dialogue-model/runtime/grounding/client.ts";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { summarizeRecord } from "../workers/tangram-experiment/src/admin/summary.ts";
import { renderDetail } from "../workers/tangram-experiment/src/admin/render.ts";
import { summarizeLatency } from "../workers/tangram-experiment/src/admin/latency.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Upstream = (url: string, init: RequestInit) => Promise<Response>;
const handleRequest = (request: Request, workerEnv: Record<string, unknown>, upstreamFetch?: Upstream): Promise<Response> =>
  handleWorkerRequest(request, workerEnv as never, upstreamFetch as never);
const TOKEN = "no-name-proxy-token-at-least-thirty-two-characters";
const KEY = "sk-or-no-name-canary-openrouter-key";
const env = { RESEARCH_PROXY_TOKEN: TOKEN, RESEARCH_GROUNDING_ENABLED: "true", OPENROUTER_DECISIONS_API_KEY: KEY,
  UPSTREAM_PROVIDER: "openai", DIALOGUE_MODEL: "gpt-6-luna", UPSTREAM_API_KEY: "no-name-chat-key" };
const NAME5 = ["agreed", "unclear", "not_agreed", "no_name", "unknown"];
const scores = (levels: readonly string[], chosen: string) => Object.fromEntries(levels.map((level) => [level, level === chosen ? 0.8 : 0.05]));
const upstream = (name: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({
  model: "typesafe/jev-1.14-20261014", provider: "TypeSafe", id: "gen-synthetic-no-name",
  answers: {
    identification: { type: "choice", choice: "insufficient", probabilities: scores(GROUNDING_LEVELS.identification, "insufficient"), confidence: 0.7 },
    name_agreement: { type: "choice", ...name },
  },
  usage: { input_tokens: 900, output_tokens: 2, cost: 0.00004 }, ...patch,
});
const request = (payload: unknown = { purpose: "grounding_jev", state: "合成: 相手「三角が二つあるやつから」" }) =>
  new Request("https://no-name.test/v1/grounding-evidence", { method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(payload) });

test("v2 name axis: five ordered levels, each criterion with a short phrasing, and the 見立て / no_name boundary", () => {
  assert.equal(GROUNDING_CRITERIA_VERSION, "grounding-criteria/v2");
  assert.deepEqual(GROUNDING_LEVELS.name_agreement, NAME5);
  assert.deepEqual(Object.keys(NAME_AGREEMENT_CRITERIA), NAME5);
  for (const text of Object.values(NAME_AGREEMENT_CRITERIA)) assert.match(text, /^[^。]{2,40}（[^）]+）。/);
  // Researcher rule: an impression (見立て) alone is no_name; only an explicit proposal is unclear;
  // a tentative label depends on context; a blank reply is never agreement.
  assert.match(NAME_AGREEMENT_CRITERIA.no_name, /見立て・印象の共有は対象を特定するためのもので名前の提案ではない/);
  assert.match(NAME_AGREEMENT_CRITERIA.no_name, /鳥みたい/);
  assert.match(NAME_AGREEMENT_CRITERIA.no_name, /別の図形について出た名前はこの判定を妨げない/);
  assert.match(NAME_AGREEMENT_CRITERIA.no_name, /aiSideClaims・aiMemory にしかない候補名は数えない/);
  assert.match(NAME_AGREEMENT_CRITERIA.unclear, /明示的に提案した/);
  assert.match(NAME_AGREEMENT_CRITERIA.unclear, /と呼びませんか/);
  assert.match(NAME_AGREEMENT_CRITERIA.unclear, /文脈上この図形の名前として出された仮称/);
  assert.doesNotMatch(NAME_AGREEMENT_CRITERIA.unclear, /Xみたい|見立てを述べた/);
  // Agreement with an impression counts only as a reply to a proposal; an impression-only exchange is no_name.
  assert.match(NAME_AGREEMENT_CRITERIA.unclear, /提案に対して、[^。]*見立てへの同意だけが返った/);
  assert.match(NAME_AGREEMENT_CRITERIA.unclear, /提案がなく見立ての共有だけなら unclear ではなく no_name/);
  assert.match(NAME_AGREEMENT_CRITERIA.agreed, /返答がない・空欄・相槌だけは合意ではない/);
  assert.match(NAME_AGREEMENT_CRITERIA.not_agreed, /名前の提案が一度もない場合は選ばない/);
  assert.match(NAME_AGREEMENT_CRITERIA.unknown, /unknown ではなく no_name/);
  const payload = buildGroundingPayload({ purpose: "grounding_jev", state: "合成" });
  assert.ok(payload);
  assert.deepEqual(Object.keys(payload.questions.name_agreement.criteria), NAME5);
  assert.match(payload.questions.name_agreement.instructions, /見立てや印象の共有（「〇〇みたい」）は対象の特定のためのもので、名前の提案ではありません/);
  assert.match(payload.questions.name_agreement.instructions, /no_name）、提案はあるが共同採用が未確定であること（unclear）/);
  assert.match(payload.questions.name_agreement.instructions, /公開対話の発話だけから判断/);
  // The identification axis is unchanged.
  assert.deepEqual(GROUNDING_LEVELS.identification, ["supported", "insufficient", "contradicted", "unknown"]);
});

test("the Worker accepts no_name with five scores and stamps the server-owned criteria version", async () => {
  const response = await handleRequest(request(), env, async () => Response.json(upstream({ choice: "no_name", probabilities: scores(NAME5, "no_name"), confidence: 0.8 },
    { criteriaVersion: "grounding-criteria/v999" })));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.nameAgreement.level, "no_name");
  assert.deepEqual(Object.keys(data.nameAgreement.scores), NAME5);
  assert.equal(data.criteriaVersion, "grounding-criteria/v2");
});

test("v1-shaped or malformed name answers fail closed (502), and the client cannot pick a version", async () => {
  const v1 = Object.fromEntries(["agreed", "unclear", "not_agreed", "unknown"].map((level) => [level, 0.25]));
  for (const name of [
    { choice: "not_agreed", probabilities: v1 },
    { choice: "no_name", probabilities: v1 },
    { choice: "no_name_yet", probabilities: { ...scores(NAME5, "no_name"), no_name_yet: 0.9 } },
    { choice: "未提案", probabilities: scores(NAME5, "no_name") },
    { choice: "no_name", probabilities: { ...scores(NAME5, "no_name"), no_name: -0.1 } },
  ]) {
    const response = await handleRequest(request(), env, async () => Response.json(upstream(name)));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "invalid_upstream_response" });
    assert.equal(sanitizeGroundingVerdict(upstream(name), GROUNDING_MODELS.grounding_jev, "grounding_jev"), null);
  }
  let calls = 0;
  for (const payload of [{ purpose: "grounding_jev", state: "合成", criteriaVersion: "grounding-criteria/v1" },
    { purpose: "grounding_jev", state: "合成", levels: { name_agreement: ["agreed"] } }]) {
    const response = await handleRequest(request(payload), env, async () => { calls++; return Response.json({}); });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test("the client rejects a v1 proxy response or a different criteria version instead of mixing versions", async () => {
  const config = { provider: "cloudflare", baseUrl: "https://no-name.test/v1", apiKey: TOKEN };
  const v2 = { purpose: "grounding_jev", model: "typesafe/jev-1.14", provider: null, id: null, usage: null,
    identification: { level: "insufficient", scores: scores(GROUNDING_LEVELS.identification, "insufficient"), confidence: null },
    nameAgreement: { level: "no_name", scores: scores(NAME5, "no_name"), confidence: null }, criteriaVersion: "grounding-criteria/v2" };
  const v1Proxy = { ...v2, nameAgreement: { level: "not_agreed", scores: Object.fromEntries(["agreed", "unclear", "not_agreed", "unknown"].map((l) => [l, 0.25])), confidence: null } };
  delete (v1Proxy as Record<string, unknown>).criteriaVersion;
  assert.equal(parseGroundingVerdict(v2, "grounding_jev", 1).nameAgreement.level, "no_name");
  for (const body of [v1Proxy, { ...v2, criteriaVersion: undefined }, { ...v2, criteriaVersion: "grounding-criteria/v1" }]) {
    const client = createGroundingJudgeClient(config, async () => Response.json(body));
    await assert.rejects(client.judge({ purpose: "grounding_jev", state: "合成" }),
      (error: unknown) => error instanceof GroundingConnectionError && error.code === "invalid_response");
  }
  const end = await createGroundingJudgeClient(config, async (url, init) => handleRequest(new Request(url, init), env,
    async () => Response.json(upstream({ choice: "unclear", probabilities: scores(NAME5, "unclear") })))).judge({ purpose: "grounding_jev", state: "合成" });
  assert.equal(end.criteriaVersion, "grounding-criteria/v2");
  assert.equal(end.nameAgreement.level, "unclear");
});

const model = () => ({ async complete(_m: unknown, { phase }: { phase?: string } = {}) {
  if (phase === "generation") return { text: "三角が二つの図形ですね。" };
  throw new Error("unexpected phase " + phase);
} });
const luna = { async judge(input: Any) {
  return { action: "confirm", targetSlot: Object.keys(input.ownLedger)[0], candidateName: null, discriminatingFeature: "尖りが二つ", note: null };
} };

test("shadow records carry no_name and the criteria version through persist, restore and the admin view", async () => {
  const records: Any[] = [];
  const judge: GroundingJudge = createMockGroundingJudge(() => ({ identification: "insufficient", nameAgreement: "no_name" }));
  const task: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy: "repair-first", seed: 71, runDir: null,
    onPersist: async (record: Any) => { records.push(structuredClone(record)); }, groundingShadow: { judge } } as Any);
  task.message("三角が二つあるやつから話しましょう");
  await task.whenIdle();
  for (let index = 0; index < 200 && task.researcherView().groundingShadow.length < 1; index++) await pause(1);
  await task.persistNow();
  const [record] = task.researcherView().groundingShadow;
  assert.equal(record.nameAgreement.level, "no_name");
  assert.equal(record.criteriaVersion, "grounding-criteria/v2");
  assert.doesNotMatch(JSON.stringify(task.getState()), /no_name|criteria|grounding/);

  // An older (v1) record without a version is kept as is on restore and shown as v1 in the admin view.
  const saved = structuredClone(records.at(-1));
  const legacy = { ...saved.groundingShadow[0], nameAgreement: { level: "not_agreed", scores: { agreed: 0, unclear: 0, not_agreed: 1, unknown: 0 }, confidence: null } };
  delete legacy.criteriaVersion;
  saved.groundingShadow = [legacy, ...saved.groundingShadow];
  const restored: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy: "repair-first", seed: 71, runDir: null,
    restore: saved, groundingShadow: { judge } } as Any);
  assert.deepEqual(restored.researcherView().groundingShadow.map((r: Any) => r.criteriaVersion ?? "none"), ["none", "grounding-criteria/v2"]);
  const summary = summarizeRecord(saved, "a".repeat(64), summarizeLatency(saved));
  const html = renderDetail(saved, summary, summarizeLatency(saved), 30);
  assert.match(html, /判定基準の版/);
  assert.match(html, /v1（版記録なし）/);
  assert.match(html, /grounding-criteria\/v2/);
  assert.match(html, /no_name/);
  assert.doesNotMatch(html, /正答確率|probability correct/);
});

test("the shadow stays default OFF and the dialogue is identical with a no_name judge, for both strategies", async () => {
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    const run = async (shadow: Any) => {
      const records: Any[] = [];
      const task: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy, seed: 72, runDir: null,
        onPersist: async (record: Any) => { records.push(structuredClone(record)); }, ...(shadow ? { groundingShadow: shadow } : {}) } as Any);
      task.message("三角が二つあるやつから");
      await task.whenIdle();
      return { task, last: records.at(-1) };
    };
    const off = await run(null);
    const on = await run({ judge: createMockGroundingJudge(() => ({ identification: "unknown", nameAgreement: "no_name" })) });
    assert.equal(Object.hasOwn(off.last, "groundingShadow"), false);
    assert.equal(Object.hasOwn(off.last.options, "groundingShadow"), false);
    assert.deepEqual(on.task.getState().events.map((e: Any) => e.text), off.task.getState().events.map((e: Any) => e.text));
    assert.deepEqual(on.task.researcherView().privateState.ledger, off.task.researcherView().privateState.ledger);
    assert.deepEqual(on.task.researcherView().privateState.judgments.map((j: Any) => j.judgment),
      off.task.researcherView().privateState.judgments.map((j: Any) => j.judgment));
  }
});
