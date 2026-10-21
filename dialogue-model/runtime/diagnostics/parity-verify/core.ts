import { createHash } from "node:crypto";

export type Row = Record<string, unknown>;
export type Status = "pass" | "mismatch" | "not_comparable" | "not_reached";
export type Check = { id: string; status: Status; reason: string; detail?: Row };
export type Storage = { name: string; mode: number; external: boolean; regular: boolean };
export type Records = { run?: Row; summary?: Row; warmup?: Row; failure?: Row; trials: Row[];
  billing?: Row[]; packets?: Array<{ name: string; value: Row }>; storage?: Storage[]; evidence?: Row };
export const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const rows = (value: unknown): Row[] => list(value).map(row);
export const present = (value: unknown): boolean => value !== undefined && value !== null;
export const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const shaLike = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

/** Independent, strict JSON canonicalization. No parity-live imports or helpers. */
export function canonical(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": case "string": return JSON.stringify(value);
    case "number": if (Number.isFinite(value)) return JSON.stringify(value); break;
    case "object": {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) break;
        return `[${value.map(canonical).join(",")}]`;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) break;
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(",")}}`;
    }
  }
  throw new TypeError("non_json_value");
}
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const hash = (value: unknown): string => sha256(canonical(value));
export const equal = (a: unknown, b: unknown): boolean => a !== undefined && b !== undefined && canonical(a) === canonical(b);
export const META_KEYS = Object.freeze(["label", "runId", "timestamp", "timestamps", "startedAt", "finishedAt", "createdAt"]);
export const omit = (value: Row, keys: readonly string[]): Row => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
export const profileHash = (profile: Row): string => hash(omit(profile, ["label"]));
export const check = (id: string, status: Status, reason: string, detail?: Row): Check => ({ id, status, reason, ...(detail ? { detail } : {}) });
export const assertion = (id: string, ok: boolean, reason: string, detail?: Row): Check => check(id, ok ? "pass" : "mismatch", reason, detail);
export const missing = (id: string, reason = "evidence_missing"): Check => check(id, "not_reached", reason);
export function combine(id: string, checks: Check[], reason: string): Check {
  const status: Status = checks.some(c => c.status === "mismatch") ? "mismatch" : !checks.length || checks.some(c => c.status === "not_reached")
    ? "not_reached" : checks.some(c => c.status === "not_comparable") ? "not_comparable" : "pass";
  return check(id, status, reason, { components: checks.map(c => c.id) });
}
export function allCalls(records: Records): Row[] {
  return [...rows(records.failure?.calls), ...rows(records.warmup?.calls), ...records.trials.flatMap(t => rows(t.calls))];
}
export function allHttp(records: Records): Row[] {
  return [...rows(row(records.failure?.http).records), ...rows(records.warmup?.http), ...records.trials.flatMap(t => rows(t.http))];
}
/** runOrder describes started trials even when their own file could not be saved. */
export function missingTrialOrders(records: Records): number[] {
  return list(records.summary?.runOrder).map((_, i) => i).filter(i => !records.trials.some(t => t.order === i));
}
export function callsComplete(records: Records): boolean {
  return missingTrialOrders(records).length === 0 && !!(records.warmup || Array.isArray(records.failure?.calls));
}
export function httpComplete(records: Records): boolean {
  return callsComplete(records) && (!records.failure || records.failure.scope === "after_warmup" || row(records.failure.http).measured === true);
}
export const httpMissingReason = (records: Records): string => records.failure && !Object.hasOwn(records.failure, "schemaVersion")
  ? "legacy_unrecorded" : "output_missing";
