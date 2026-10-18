// Opt-in engineering adapter: Decisions supplies ONLY an action, never referents.
import { validateJudgment, validateOwnLedger, SAFE_JUDGMENT, JudgmentValidationError } from "../judgment/schema.mjs";
import { STRATEGIES } from "../judgment/instructions.mjs";
import { DECISION_ACTIONS, DECISION_MODELS } from "../../../workers/research-ai-proxy/src/decisions.mjs";

const CODES = new Set(["invalid_judgment", "invalid_ledger", "inconsistent_action", "reassignment_requires_repair", "duplicate_name_requires_repair", "agree_requires_shared_identification", "invalid_follow_up", "invalid_reference"]);
const ERRORS = new Set(["invalid_config", "invalid_request", "rate_limited", "payment_required", "upstream_error", "invalid_response", "timeout", "network_error", "evidence_unavailable"]);
const nonnegative = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const validProbability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const validationCode = (error) => error instanceof JudgmentValidationError && CODES.has(error.code) ? error.code : "invalid_judgment";
const errorCode = (error) => ERRORS.has(typeof error === "string" ? error : error?.code) ? (typeof error === "string" ? error : error.code) : "decision_unavailable";

/** Pure synthesis over a validated Luna interpretation and an untrusted action response. */
export function resolveActiveJudgment({ lunaJudgment, decision, ownLedger, strategy }) {
  const ledger = validateOwnLedger(ownLedger);
  if (!STRATEGIES.includes(strategy)) throw new Error("Invalid active judge strategy");
  const purpose = Object.hasOwn(DECISION_MODELS, decision?.purpose) ? decision.purpose : null;
  const knownModels = purpose ? [DECISION_MODELS[purpose]] : Object.values(DECISION_MODELS);
  const model = typeof decision?.model === "string" && knownModels.some((name) => decision.model === name ||
    decision.model.startsWith(name + "-") && /^[0-9]{8}$/.test(decision.model.slice(name.length + 1))) ? decision.model : null;
  const validProbabilities = decision?.probabilities && typeof decision.probabilities === "object" && !Array.isArray(decision.probabilities) &&
    DECISION_ACTIONS.every((action) => validProbability(decision.probabilities[action]));
  const probabilitySum = validProbabilities ? DECISION_ACTIONS.reduce((sum, action) => sum + decision.probabilities[action], 0) : NaN;
  const valid = decision && !(decision instanceof Error) && !decision.error && DECISION_ACTIONS.includes(decision.action) &&
    validProbabilities && probabilitySum >= 0.98 && probabilitySum <= 1.02 &&
    decision.probabilities[decision.action] > 0;
  const record = { lunaAction: DECISION_ACTIONS.includes(lunaJudgment?.action) ? lunaJudgment.action : null,
    decisionAction: DECISION_ACTIONS.includes(decision?.action) ? decision.action : null,
    probabilities: valid ? Object.fromEntries(DECISION_ACTIONS.map((action) => [action, decision.probabilities[action]])) : null,
    finalAction: null, resolution: null, droppedFollowUp: false, droppedReference: false,
    purpose, model, latencyMs: nonnegative(decision?.latencyMs), costUsd: nonnegative(decision?.usage?.costUsd ?? decision?.costUsd), rejectedCandidates: [] };

  function withReference(candidate) {
    try { return { judgment: validateJudgment(candidate, { ownLedger: ledger, agreeEvidence: true }), droppedReference: false }; }
    catch (error) {
      if (!Object.hasOwn(candidate, "reference") || candidate.reference === null) throw error;
      const core = { ...candidate }; delete core.reference;
      return { judgment: { ...validateJudgment(core, { ownLedger: ledger, agreeEvidence: true }), reference: null }, droppedReference: true };
    }
  }
  function finish(result, resolution) {
    record.finalAction = result.judgment.action; record.resolution = resolution;
    record.droppedFollowUp = Boolean(lunaJudgment?.followUp && !result.judgment.followUp);
    record.droppedReference = result.droppedReference;
    return { judgment: result.judgment, record };
  }
  function safeAccept() {
    const candidate = { ...SAFE_JUDGMENT };
    if (Object.hasOwn(lunaJudgment, "reference")) candidate.reference = lunaJudgment.reference;
    return finish(withReference(candidate), "safe_accept");
  }
  if (!valid) {
    record.error = decision instanceof Error || decision?.error ? errorCode(decision instanceof Error ? decision : decision.error) : "invalid_response";
    try { return finish(withReference(lunaJudgment), "fallback"); }
    catch (error) {
      record.rejectedCandidates.push({ action: record.lunaAction, code: validationCode(error) });
      return safeAccept();
    }
  }
  function candidateFor(action) {
    const candidate = { action, targetSlot: lunaJudgment.targetSlot, candidateName: lunaJudgment.candidateName,
      discriminatingFeature: lunaJudgment.discriminatingFeature, note: lunaJudgment.note };
    if (["move_on", "close", "accept"].includes(action)) candidate.candidateName = null;
    if (action === lunaJudgment.action && Object.hasOwn(lunaJudgment, "followUp")) candidate.followUp = lunaJudgment.followUp;
    if (Object.hasOwn(lunaJudgment, "reference")) candidate.reference = lunaJudgment.reference;
    return candidate;
  }
  // Try the choice, then positive-support alternatives, with Worker-order ties; never invent zero-support actions.
  const ranked = [decision.action, ...DECISION_ACTIONS.filter((action) => action !== decision.action && decision.probabilities[action] > 0)
    .sort((a, b) => decision.probabilities[b] - decision.probabilities[a])];
  for (const [index, action] of ranked.entries()) {
    // Decisions may veto/delay agreement but cannot initiate agreement Luna withheld.
    if (action === "agree" && lunaJudgment.action !== "agree") {
      record.rejectedCandidates.push({ action, code: "agree_ineligible" });
      continue;
    }
    try { return finish(withReference(candidateFor(action)), index === 0 ? "decision" : "rerank"); }
    catch (error) { record.rejectedCandidates.push({ action, code: validationCode(error) }); }
  }
  return safeAccept();
}
