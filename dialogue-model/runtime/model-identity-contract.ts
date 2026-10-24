// Pure fixed-contract classification only; no producer, verifier, I/O or run state.
// Audited UTF-8 bytes, without a trailing newline (PREAUDIT-MODEL-SPEC-02).
export const MODEL_CONTRACT_V2_CANONICAL_JSON = '{"acceptedReturned":["typesafe/jev-1.14","typesafe/jev-1.14-20261014"],"requested":"typesafe/jev-1.14","version":"model-contract-v2"}';
export const MODEL_CONTRACT_V2_TABLE_SHA256 = "8863dac6f67424d1bbf76a3e6c1dafc4d8eb48ca36628dd7584454e2876af9b0";

export type ModelContractV2 = Readonly<{
  acceptedReturned: readonly string[];
  requested: string;
  version: "model-contract-v2";
}>;
const definition = JSON.parse(MODEL_CONTRACT_V2_CANONICAL_JSON) as ModelContractV2;
Object.freeze(definition.acceptedReturned);
export const MODEL_CONTRACT_V2: ModelContractV2 = Object.freeze(definition);

export type ModelIdentityResult = Readonly<{
  status: "accepted" | "unknown_version" | "not_allowed" | "invalid";
  requestedId: string;
  returnedId: string | null;
  version: string | null;
  reason: "accepted_alias" | "accepted_snapshot" | "unknown_version" | "not_allowed" | "invalid_returned_id";
}>;
export type ModelContractErrorCode = "invalid_model_contract" | "invalid_requested_id";
export class ModelContractError extends Error {
  readonly code: ModelContractErrorCode;
  constructor(code: ModelContractErrorCode) {
    const fixed = code === "invalid_requested_id" ? code : "invalid_model_contract";
    super(fixed); this.name = "ModelContractError"; this.code = fixed;
  }
}

function dataValues(value: unknown, prototype: object, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value), ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key)) ||
      keys.some(key => !Object.hasOwn(descriptors[key], "value"))) return null;
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function fixedContract(value: unknown): boolean {
  try {
    const fields = dataValues(value, Object.prototype, ["acceptedReturned", "requested", "version"]);
    if (!fields || !Array.isArray(fields.acceptedReturned)) return false;
    const entries = dataValues(fields.acceptedReturned, Array.prototype, ["0", "1", "length"]);
    return !!entries && fields.requested === MODEL_CONTRACT_V2.requested && fields.version === MODEL_CONTRACT_V2.version &&
      entries.length === 2 && entries["0"] === MODEL_CONTRACT_V2.acceptedReturned[0] && entries["1"] === MODEL_CONTRACT_V2.acceptedReturned[1];
  } catch {
    // Accessors are rejected without invocation; hostile proxy traps stay a fixed error.
    return false;
  }
}
function safeId(value: string): string | null {
  // A strict full match: `$` alone also matches before a final newline in JS.
  return value.length <= 128 && /^[A-Za-z0-9]/u.test(value) && !/[^A-Za-z0-9._/-]/u.test(value) ? value : null;
}

export function checkModelIdentity(requested: unknown, returned: unknown, contract: unknown = MODEL_CONTRACT_V2): ModelIdentityResult {
  if (!fixedContract(contract)) throw new ModelContractError("invalid_model_contract");
  if (typeof requested !== "string" || requested !== MODEL_CONTRACT_V2.requested) throw new ModelContractError("invalid_requested_id");
  const result = (status: ModelIdentityResult["status"], version: string | null, reason: ModelIdentityResult["reason"]): ModelIdentityResult =>
    Object.freeze({ status, requestedId: requested, returnedId: typeof returned === "string" ? safeId(returned) : null, version, reason });
  if (typeof returned !== "string" || returned === "") return result("invalid", null, "invalid_returned_id");
  if (returned === MODEL_CONTRACT_V2.acceptedReturned[0]) return result("accepted", null, "accepted_alias");
  const prefix = requested + "-";
  if (returned === MODEL_CONTRACT_V2.acceptedReturned[1]) return result("accepted", returned.slice(prefix.length), "accepted_snapshot");
  const suffix = returned.slice(prefix.length);
  if (returned.startsWith(prefix) && suffix.length === 8 && /^[0-9]{8}$/u.test(suffix)) return result("unknown_version", suffix, "unknown_version");
  return result("not_allowed", null, "not_allowed");
}
