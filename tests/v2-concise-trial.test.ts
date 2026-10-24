import { privateBaseOptions } from './support/s5-private-options.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { CONCISE_INSTRUCTIONS_V2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createNamingServer } from "../dialogue-model/runtime/web/server.mjs";

type Message = { role: string; content: unknown };

// Records generation requests; the judge is stubbed so only the utterance path runs.
function harness() {
  const generations: Message[][] = [];
  const client = { async complete(messages: Message[], options: { phase?: string } = {}) {
    if (options.phase === "generation") generations.push(messages);
    return { text: "そう見えるんですね。" };
  } };
  const judge = { async judge() {
    return { action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null };
  } };
  return { client, judge, generations };
}

const hasConcise = (messages: Message[]) => messages.some((m) => m.role === "system" && m.content === CONCISE_INSTRUCTIONS_V2);

async function oneTurn(options: Record<string, unknown>) {
  const h = harness();
  let record: any = null;
  const task: any = await createNamingTaskV2({ client: h.client, judge: h.judge, seed: 21, runDir: "",
    onPersist: async (snapshot: unknown) => { record = snapshot; }, ...options } as any);
  task.message("こんにちは");
  await task.whenIdle();
  return { generations: h.generations, record, task };
}

for (const strategy of ["repair-first", "bypass-enabled"]) {
  test(`concise style reaches the generator and the private record (${strategy})`, async () => {
    const concise = await oneTurn({ strategy, utteranceStyle: "concise" });
    assert.equal(concise.generations.length, 1);
    assert.ok(hasConcise(concise.generations[0]), "concise instruction is sent");
    assert.equal(concise.record.options.utteranceStyle, "concise");
    assert.ok(!JSON.stringify(concise.task.getState()).includes("utteranceStyle"), "participant state does not reveal the style");

    const plain = await oneTurn({ strategy });
    assert.ok(!hasConcise(plain.generations[0]), "default sends no concise instruction");
    assert.equal(plain.record.options.utteranceStyle, "default");
  });
}

test("both strategies receive the identical concise instruction", async () => {
  const [a, b] = await Promise.all(["repair-first", "bypass-enabled"].map((strategy) => oneTurn({ strategy, utteranceStyle: "concise" })));
  const pick = (messages: Message[]) => messages.find((m) => m.content === CONCISE_INSTRUCTIONS_V2);
  assert.deepEqual(pick(a.generations[0]), pick(b.generations[0]));
});

test("a restored trial keeps the style it started with", async () => {
  const first = await oneTurn({ strategy: "repair-first", utteranceStyle: "concise" });
  const h = harness();
  let record: any = null;
  await createNamingTaskV2({ client: h.client, judge: h.judge, seed: 21, strategy: "repair-first", runDir: "",
    restore: first.record, utteranceStyle: "default", onPersist: async (s: unknown) => { record = s; } } as any);
  assert.equal(record.options.utteranceStyle, "concise");
});

test("unknown styles are rejected", async () => {
  await assert.rejects(() => oneTurn({ strategy: "repair-first", utteranceStyle: "short" }));
  assert.throws(() => createNamingServer({ client: harness().client, utteranceStyle: "short" } as any), /utterance style/);
});

test("the local server passes the style to new v2 trials only", async (t) => {
  const seen: Record<string, unknown>[] = [];
  const server: any = createNamingServer({ client: harness().client, ...(await privateBaseOptions(t,{seed:3,strategy:"bypass-enabled"})), utteranceStyle: "concise",
    createTaskV2: async (options: Record<string, unknown>) => { seen.push(options); throw new Error("stop"); } } as any);
  assert.equal(typeof server.listen, "function");
  const { once } = await import("node:events");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    const cookie = (await fetch(base)).headers.get("set-cookie")!.split(";")[0];
    await fetch(base + "/api/start", { method: "POST", headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 2 }) });
    assert.equal(seen[0]?.utteranceStyle, "concise");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
