import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const moduleUrl = new URL("../dialogue-model/runtime/model-identity-contract.ts", import.meta.url);
// The same tests exercise baseline absence (R-a) and the new module.
const loaded = existsSync(moduleUrl) ? await import(moduleUrl.href) as typeof import("../dialogue-model/runtime/model-identity-contract.ts") : undefined;
function api() {
  assert.ok(loaded, "R-a: baseline has no pure model identity entry point");
  return loaded;
}
const ALIAS = "typesafe/jev-1.14", SNAPSHOT = "typesafe/jev-1.14-20261014";
const PIN = "8863dac6f67424d1bbf76a3e6c1dafc4d8eb48ca36628dd7584454e2876af9b0";
const fixture = readFileSync(new URL("./fixtures/model-identity-contract-v2.canonical.json", import.meta.url));
const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const table = (): Record<string, unknown> => JSON.parse(fixture.toString("utf8"));
function expected(status: string, returnedId: string | null, version: string | null, reason: string) {
  return { status, requestedId: ALIAS, returnedId, version, reason };
}
function rejectsConfiguration(run: () => unknown, code: "invalid_model_contract" | "invalid_requested_id") {
  const { ModelContractError } = api();
  assert.throws(run, error => error instanceof ModelContractError && error.name === "ModelContractError" &&
    error.code === code && error.message === code);
}

test("auditor canonical bytes have the independent literal SHA pin and no final newline", () => {
  assert.equal(digest(fixture), PIN);
  assert.equal(fixture.at(-1), 0x7d);
});

test("embedded table bytes, digest and frozen data match the audited fixture", () => {
  const m = api();
  assert.equal(m.MODEL_CONTRACT_V2_CANONICAL_JSON, fixture.toString("utf8"));
  assert.equal(digest(m.MODEL_CONTRACT_V2_CANONICAL_JSON), PIN);
  assert.equal(m.MODEL_CONTRACT_V2_TABLE_SHA256, PIN);
  assert.deepEqual(m.MODEL_CONTRACT_V2, table());
  assert.equal(Object.isFrozen(m.MODEL_CONTRACT_V2), true);
  assert.equal(Object.isFrozen(m.MODEL_CONTRACT_V2.acceptedReturned), true);
});

test("S2-A1: exact alias is accepted without filling in a snapshot version", () => {
  assert.deepEqual(api().checkModelIdentity(ALIAS, ALIAS), expected("accepted", ALIAS, null, "accepted_alias"));
});
test("S2-A2: audited snapshot is accepted and retains its observed version", () => {
  assert.deepEqual(api().checkModelIdentity(ALIAS, SNAPSHOT), expected("accepted", SNAPSHOT, "20261014", "accepted_snapshot"));
});
for (const version of ["20261015", "00000000", "99999999"]) {
  test(`S2-B1: unlisted ASCII identifier ${version} stays unknown; no calendar inference`, () => {
    const returned = `${ALIAS}-${version}`;
    assert.deepEqual(api().checkModelIdentity(ALIAS, returned), expected("unknown_version", returned, version, "unknown_version"));
  });
}
const safeRejected = ["other/jev-1.14", `${ALIAS}-forged`, `${ALIAS}0`, `${ALIAS}-2026-10-14`, `${ALIAS}-20261014x`,
  `${ALIAS}-2026101`, `${ALIAS}-202610144`, "Typesafe/jev-1.14", "typesafe/jevX1Y14-20261015", `${ALIAS}/20261014`, "x".repeat(128)];
for (const [i, returned] of safeRejected.entries()) {
  test(`S2-B2/B3/B5: literal family/shape rejection ${i} keeps only a bounded syntactic ID`, () => {
    assert.deepEqual(api().checkModelIdentity(ALIAS, returned), expected("not_allowed", returned, null, "not_allowed"));
  });
}
const unsafeRejected = [` ${ALIAS}`, `${ALIAS} `, `${ALIAS}\n`, `${ALIAS}\r\n`, `${ALIAS}-20261015\n`, `${ALIAS}-2026101\n`,
  `${ALIAS}-２０２６１０１５`, `${ALIAS}-٢٠٢٦١٠١٥`, `${ALIAS}-2026101４`, `${ALIAS}\u2028`, "x".repeat(129), "secret=PRIVATE_CANARY"];
for (const [i, returned] of unsafeRejected.entries()) {
  test(`S2-B3/B6: noncanonical or unsafe string ${i} is not copied into returnedId`, () => {
    assert.deepEqual(api().checkModelIdentity(ALIAS, returned), expected("not_allowed", null, null, "not_allowed"));
  });
}
const invalidReturns: unknown[] = ["", null, undefined, [], [ALIAS], [[ALIAS]], {}, { toString: null },
  { toString() { throw new Error("PRIVATE_CANARY"); } }, 14, NaN, true, 14n, Symbol("PRIVATE_CANARY"), () => ALIAS];
for (const [i, returned] of invalidReturns.entries()) {
  test(`S2-B4: nonstring/empty value ${i} is invalid without coercion or a raw TypeError`, () => {
    assert.deepEqual(api().checkModelIdentity(ALIAS, returned), expected("invalid", null, null, "invalid_returned_id"));
  });
}

const invalidRequests: unknown[] = [null, undefined, "", SNAPSHOT, "other/jev-1.14", ` ${ALIAS}`, [ALIAS], { toString: null },
  { toString() { throw new Error("PRIVATE_CANARY"); } }, false, 14, Symbol("PRIVATE_CANARY")];
for (const [i, requested] of invalidRequests.entries()) {
  test(`requested configuration ${i} rejects before response classification`, () => {
    rejectsConfiguration(() => api().checkModelIdentity(requested, SNAPSHOT), "invalid_requested_id");
  });
}

test("a deserialized fixed definition accepts independently of object key insertion order", () => {
  const source = table();
  const reordered = { version: source.version, requested: source.requested, acceptedReturned: source.acceptedReturned };
  assert.deepEqual(api().checkModelIdentity(ALIAS, SNAPSHOT, reordered), expected("accepted", SNAPSHOT, "20261014", "accepted_snapshot"));
  assert.deepEqual(api().checkModelIdentity(ALIAS, ALIAS, undefined), expected("accepted", ALIAS, null, "accepted_alias"));
});

const corruptions: Array<(definition: Record<string, unknown>) => unknown> = [
  d => ({ ...d, requested: SNAPSHOT }), d => ({ ...d, version: "model-contract-v3" }),
  d => ({ ...d, acceptedReturned: [ALIAS, "other/model"] }), d => ({ ...d, acceptedReturned: [] }),
  d => ({ ...d, acceptedReturned: [ALIAS, ALIAS] }), d => ({ ...d, acceptedReturned: [SNAPSHOT, ALIAS] }),
  d => ({ ...d, acceptedReturned: [ALIAS, SNAPSHOT, `${ALIAS}-20261015`] }), d => ({ ...d, acceptedReturned: [ALIAS] }),
  d => ({ ...d, acceptedReturned: { 0: ALIAS, 1: SNAPSHOT, length: 2 } }), d => ({ ...d, acceptedReturned: null }),
  d => ({ ...d, extra: true }), d => ({ ...d, tableSha256: digest(JSON.stringify({ ...d, acceptedReturned: ["other/model"] })) }),
  d => { delete d.version; return d; }, d => Object.assign(Object.create(null), d),
  d => Object.assign(Object.create({ requested: ALIAS }), d),
  d => { Object.defineProperty(d, "requested", { get() { throw new Error("PRIVATE_CANARY"); } }); return d; },
  d => { Object.defineProperty(d, Symbol("PRIVATE_CANARY"), { value: 1 }); return d; },
  d => { const a = d.acceptedReturned as string[]; Object.defineProperty(a, "0", { get() { throw new Error("PRIVATE_CANARY"); } }); return d; },
  d => { const a = d.acceptedReturned as string[]; delete a[1]; return d; },
  d => { const a = d.acceptedReturned as string[]; Object.defineProperty(a, "extra", { value: 1 }); return d; },
  d => { const a = d.acceptedReturned as string[]; Object.defineProperty(a, Symbol("PRIVATE_CANARY"), { value: 1 }); return d; },
  d => { const a = d.acceptedReturned as string[]; Object.setPrototypeOf(a, null); return d; },
  d => new Proxy(d, { ownKeys() { throw new Error("PRIVATE_CANARY"); } }),
  d => new Proxy(d, { getPrototypeOf() { throw new Error("PRIVATE_CANARY"); } }),
  () => null, () => [], () => "model-contract-v2", () => ({ toString: null }),
];
for (const [i, corrupt] of corruptions.entries()) {
  test(`fixed definition tampering ${i} cannot expand the table or leak a raw exception`, () => {
    const contract = corrupt(table());
    rejectsConfiguration(() => api().checkModelIdentity(ALIAS, SNAPSHOT, contract), "invalid_model_contract");
  });
}
test("invalid contract takes priority over an invalid requested ID", () => {
  rejectsConfiguration(() => api().checkModelIdentity(null, SNAPSHOT, null), "invalid_model_contract");
});
test("exported data cannot be mutated to add an unlisted model", () => {
  const m = api();
  assert.throws(() => { (m.MODEL_CONTRACT_V2.acceptedReturned as string[])[1] = `${ALIAS}-20261015`; }, TypeError);
  assert.throws(() => { (m.MODEL_CONTRACT_V2 as { requested: string }).requested = "other/model"; }, TypeError);
  assert.deepEqual(m.checkModelIdentity(ALIAS, `${ALIAS}-20261015`), expected("unknown_version", `${ALIAS}-20261015`, "20261015", "unknown_version"));
});
test("results are frozen detached values with exact public keys and deterministic content", () => {
  const m = api(), input = table(), before = JSON.stringify(input);
  const a = m.checkModelIdentity(ALIAS, SNAPSHOT, input), b = m.checkModelIdentity(ALIAS, SNAPSHOT, input);
  assert.deepEqual(Object.keys(a).sort(), ["reason", "requestedId", "returnedId", "status", "version"]);
  assert.deepEqual(a, b); assert.notEqual(a, b); assert.equal(Object.isFrozen(a), true);
  assert.equal(JSON.stringify(input), before);
  assert.throws(() => { (a as { version: string | null }).version = null; }, TypeError);
  assert.equal(b.version, "20261014");
});
