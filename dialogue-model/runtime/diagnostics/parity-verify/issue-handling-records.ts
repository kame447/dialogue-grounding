import { literalSpan } from "../../judgment/public-evidence.mjs";
import { equal, hash, list, row, sha256 } from "./core.ts";
import type { Row } from "./core.ts";

// Independently pinned to the adopted v21 specification, not to the runtime's
// decision or intervention implementation.
export function s4UsesIssueHandling(version: unknown): boolean {
  return version === "jev_generation_retry_v21" || s4UsesV22GenerationRules(version);
}
export function s4UsesV22GenerationRules(version: unknown): boolean {
  return version === "jev_generation_retry_v22" || version === "jev_generation_retry_v23";
}
export const S4_ISSUE_HANDLING_VERSION = "jev_issue_handling_v1";
export const S4_ISSUE_HANDLING_POLICY = "bypass_acceptance_v3";
export const S4_ISSUE_HANDLING_TABLE_SHA256 = "f73ca8d09ee097721d43f8b71764faa5e65dd2596a9badffe55860081973dc2b";

const actions = ["accept", "propose_name", "confirm", "repair", "hold_open", "revisit", "agree",
  "carry_over", "consult", "close", "request_observation"];
const issueActions = ["hold_open", "carry_over", "consult", "revisit"];
const alternatives = ["confirm", "repair", "consult"];
const repairActions = ["confirm", "repair"];
const precedingActions = [...repairActions, "hold_open", "consult", "revisit"];
const commitmentStates = ["not_due", "supported", "conflicting", "insufficient", "unclear"];
const switchFunctions = ["resolve_old_issue", "secure_progress", "unclear"];
const moveSources = ["human_request", "other", "unclear"];
const anyTarget = ["accept", "hold_open", "carry_over", "consult", "close"];
const sourceLabels = ["clarify_reference", "resolve_mismatch", "unknown"];

type Target = { kind: "none" } | { kind: "single"; figureId: string } | { kind: "multiple"; figureIds: string[] };
type BoundIssue = { kind: "resolve_issue"; issueId: string; claimId: string; sourceTurn: number };
type Issue = BoundIssue | { kind: "clarify_reference" | "resolve_mismatch" | "unknown" };
type Destination = { kind: "partner_choice" | "same_figure_naming" | "same_figure_other_issue" }
  | { kind: "other_figure"; figureId: string } | { kind: "old_issue"; issue: Issue; targets: string[] };
type Execution = { action: string; target: Target; name: string | null; feature: null; observe: null;
  issue?: Issue; visualPurpose?: Issue; destination?: Destination; detailFigureIds?: string[]; sharedClaimIds?: string[];
  extras?: Extra[] };
type Extra = Omit<Execution, "extras" | "destination" | "sharedClaimIds"> & { action: "confirm" | "repair" | "hold_open" | "consult" };
type History = { turn: number; issueId: string | null; candidatesAfter: string[] };
type Claim = { id: string; issueId: string; sourceTurn: number; turn?: number; targets: string[]; speaker: string; quote: string;
  aspect?: string; act?: string };
type PublicEvent = { seq: number; speaker: string; text: string; nonReferential?: boolean };
export type IssueHandlingContext = {
  slots: readonly string[];
  turn: number;
  claims: readonly Claim[];
  history: readonly History[];
  prior: (Execution & { turn: number }) | null;
  prospect?: unknown;
  events?: readonly PublicEvent[];
};

const closed = (v: unknown, keys: readonly string[]): v is Row =>
  !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype &&
  Reflect.ownKeys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const age = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const oneOf = (value: unknown, allowed: readonly string[]): value is string => typeof value === "string" && allowed.includes(value);
const id = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 160;
const ids = (value: unknown, slots: readonly string[]): value is string[] =>
  Array.isArray(value) && new Set(value).size === value.length && value.every(slot => oneOf(slot, slots));

export const targetSlotsV21 = (target: Target): string[] => target.kind === "none" ? []
  : target.kind === "single" ? [target.figureId] : target.figureIds;
const intersects = (left: readonly string[], right: readonly string[]) => left.some(figure => right.includes(figure));
const toTarget = (figures: readonly string[]): Target => figures.length === 1
  ? { kind: "single", figureId: figures[0] } : { kind: "multiple", figureIds: [...figures] };
const targetOrNone = (figures: readonly string[]): Target => figures.length ? toTarget(figures) : { kind: "none" };
const validTarget = (value: unknown, slots: readonly string[]): value is Target =>
  closed(value, ["kind"]) && value.kind === "none" ||
  closed(value, ["kind", "figureId"]) && value.kind === "single" && oneOf(value.figureId, slots) ||
  closed(value, ["kind", "figureIds"]) && value.kind === "multiple" && ids(value.figureIds, slots) && value.figureIds.length >= 2;
const validIssue = (value: unknown): value is Issue =>
  closed(value, ["kind"]) && oneOf(value.kind, ["clarify_reference", "resolve_mismatch", "unknown"]) ||
  closed(value, ["kind", "issueId", "claimId", "sourceTurn"]) && value.kind === "resolve_issue" &&
  id(value.issueId) && id(value.claimId) && age(value.sourceTurn);
const validDestination = (value: unknown, slots: readonly string[]): value is Destination =>
  closed(value, ["kind"]) && oneOf(value.kind, ["partner_choice", "same_figure_naming", "same_figure_other_issue"]) ||
  closed(value, ["kind", "figureId"]) && value.kind === "other_figure" && oneOf(value.figureId, slots) ||
  closed(value, ["kind", "issue", "targets"]) && value.kind === "old_issue" && validIssue(value.issue) &&
  ids(value.targets, slots) && value.targets.length > 0;

const decisionFields = ["action", "target", "name", "feature", "observe"];
const extraDecisionFields = ["detailFigureIds", "sharedClaimIds", "visualPurpose", "issue", "destination"];
export function projectIssueHandlingDecision(value: unknown): unknown {
  const decision = row(value);
  return Object.fromEntries([...decisionFields, ...extraDecisionFields.filter(key => Object.hasOwn(decision, key))]
    .map(key => [key, decision[key]]));
}

export function isIssueHandlingExecution(value: unknown, slots: readonly string[]): value is Execution {
  const execution = row(value);
  const keys = [...decisionFields, ...[...extraDecisionFields, "extras"].filter(key => Object.hasOwn(execution, key))];
  if (!closed(value, keys) || !oneOf(execution.action, actions) || execution.action === "request_observation" ||
      !validTarget(execution.target, slots) || execution.feature !== null || execution.observe !== null) return false;
  const action = execution.action, target = execution.target;
  const naming = ["propose_name", "agree"].includes(action), visual = repairActions.includes(action);
  if (naming ? target.kind !== "single" || !id(execution.name) : execution.name !== null) return false;
  if ((visual || action === "revisit") && target.kind === "none") return false;
  if (visual ? !validIssue(execution.visualPurpose) || !equal(execution.detailFigureIds, []) : Object.hasOwn(execution, "visualPurpose")) return false;
  if (issueActions.includes(action) ? !validIssue(execution.issue) : Object.hasOwn(execution, "issue")) return false;
  if (action === "carry_over" ? !validDestination(execution.destination, slots) : Object.hasOwn(execution, "destination")) return false;
  if (Object.hasOwn(execution, "detailFigureIds") && !equal(execution.detailFigureIds,
    naming && target.kind === "single" ? [target.figureId] : [])) return false;
  if (Object.hasOwn(execution, "extras") && (!Array.isArray(execution.extras) || execution.extras.length === 0 ||
      !execution.extras.every(extra => validExtra(extra, slots)))) return false;
  return !Object.hasOwn(execution, "sharedClaimIds") || (action === "accept" || action === "confirm") &&
    Array.isArray(execution.sharedClaimIds) && execution.sharedClaimIds.length >= 2 &&
    new Set(execution.sharedClaimIds).size === execution.sharedClaimIds.length && execution.sharedClaimIds.every(id);
}

function validExtra(value: unknown, slots: readonly string[]): value is Extra {
  const extra = row(value);
  const visual = oneOf(extra.action, repairActions);
  const keys = visual ? ["visualPurpose", "detailFigureIds"] : ["issue"];
  return closed(value, [...decisionFields, ...keys]) && oneOf(extra.action, [...repairActions, "hold_open", "consult"]) &&
    row(extra[visual ? "visualPurpose" : "issue"]).kind === "resolve_issue" && isIssueHandlingExecution(value, slots);
}

function finiteScore(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function offeredChoice(stage: Row, question: string): string[] {
  return Object.keys(row(row(stage.scores)[question]));
}

function labelsWithIndex(labels: readonly string[], fixed: readonly string[], prefix: string): boolean {
  return fixed.every(key => labels.includes(key)) &&
    labels.filter(key => !fixed.includes(key)).every((_, offset, dynamic) =>
      dynamic.includes(prefix + offset));
}

function targetLabel(target: Target, slots: readonly string[]): string {
  if (target.kind === "none") return "none";
  const numbers = targetSlotsV21(target).map(figure => slots.indexOf(figure));
  return target.kind === "single" ? "figure_" + numbers[0] : "figures_" + numbers.join("_");
}

function targetLabels(slots: readonly string[], action: string): string[] {
  const allowed = anyTarget.includes(action) ? ["none"] : [];
  allowed.push(...slots.map((_, index) => "figure_" + index));
  if (action === "propose_name" || action === "agree") return allowed;
  for (let mask = 1; mask < 2 ** slots.length; mask++) {
    const indices = slots.map((_, index) => index).filter(index => (mask & 2 ** index) !== 0);
    if (indices.length > 1) allowed.push("figures_" + indices.join("_"));
  }
  return allowed;
}

const expectedDetail = (action: string): string[] => {
  if (action === "hold_open") return ["handled_issue", "non_bypass_alternative"];
  if (action === "carry_over") return ["handled_issue", "non_bypass_alternative", "carry_destination"];
  if (action === "revisit") return ["handled_issue", "non_bypass_alternative", "switch_function"];
  if (action === "consult") return ["handled_issue"];
  if (repairActions.includes(action)) return ["visual_purpose"];
  if (["propose_name", "agree"].includes(action)) return ["name"];
  if (action === "request_observation") return ["observe_targets", "observe_aspect"];
  return [];
};

function detailKeysFit(stage: Row, action: string, recovery: boolean, naming: boolean): boolean {
  const keys = Object.keys(row(stage.choices)), required = expectedDetail(action);
  const maybe = repairActions.includes(action) || ["hold_open", "carry_over", "revisit"].includes(action);
  if (action === "accept" || naming && maybe) required.push(...keys.filter(key => key === "shared_construal"));
  if (recovery && maybe) required.push(...keys.filter(key => key === "naming_withdrawal"));
  if (action === "agree") required.push(...keys.filter(key => ["naming_grounding", "naming_evidence"].includes(key)));
  return closed(stage.choices, required);
}

function destinationLabelsFit(labels: readonly string[], slots: readonly string[]): boolean {
  const single = new RegExp(`^figure_[0-${slots.length - 1}]$`, "u");
  const old = labels.filter(label => label.startsWith("old_"));
  return labels.includes("partner_choice") && old.length <= 8 &&
    labelsWithIndex(old, [], "old_") && labels.every(label => old.includes(label) || single.test(label) ||
      ["partner_choice", "same_figure_naming", "same_figure_other_issue"].includes(label));
}

function validIssueStage(stage: Row, action: string, slots: readonly string[], recovery: boolean, naming: boolean): boolean {
  const keys = Object.keys(row(stage.choices));
  if (!closed(stage.choices, keys) || !closed(stage.scores, keys) || !keys.every(key => {
    const labels = offeredChoice(stage, key);
    return labels.length > 0 && verifiedChoice(stage, key, labels) !== null;
  })) return false;
  switch (stage.stage) {
    case "extras":
      return validExtraChoices(stage);
    case "action": {
      const actionLabels = offeredChoice(stage, "action");
      return closed(stage.choices, ["action", "human_move_on_source", "commitment_state",
        ...(recovery ? ["publication_continuation"] : [])]) &&
        actionLabels.every(label => actions.includes(label)) &&
        ["confirm", "repair", "hold_open", "revisit", "carry_over", "consult", "close"].every(label => actionLabels.includes(label)) &&
        verifiedChoice(stage, "human_move_on_source", moveSources) !== null &&
        verifiedChoice(stage, "commitment_state", commitmentStates) !== null;
    }
    case "target": {
      const allowed = targetLabels(slots, action), offered = offeredChoice(stage, "target");
      return closed(stage.choices, ["target"]) && offered.every(label => allowed.includes(label)) &&
        (["propose_name", "agree"].includes(action) || offered.length === allowed.length);
    }
    case "detail":
      return detailKeysFit(stage, action, recovery, naming) &&
        (!keys.includes("non_bypass_alternative") || verifiedChoice(stage, "non_bypass_alternative", alternatives) !== null) &&
        (!keys.includes("switch_function") || verifiedChoice(stage, "switch_function", switchFunctions) !== null) &&
        (!keys.includes("handled_issue") || labelsWithIndex(offeredChoice(stage, "handled_issue"), sourceLabels, "issue_")) &&
        (!keys.includes("carry_destination") || destinationLabelsFit(offeredChoice(stage, "carry_destination"), slots));
    default: return false;
  }
}

export function issueHandlingDecisionShape(value: unknown, slots: readonly string[], recovery: boolean,
    naming: boolean, evidenceShape: (value: unknown, stage?: string) => boolean): boolean {
  const decision = row(value), execution = row(projectIssueHandlingDecision(value));
  const added = ["extras", "alternativeSharedClaimIds"].filter(key => Object.hasOwn(decision, key));
  if (!closed(value, [...Object.keys(execution), "decisionKind", "calibrated", "evidence", ...added]) ||
      decision.decisionKind !== "jev_local_test" || decision.calibrated !== false ||
      !evidenceShape(decision.evidence) || !oneOf(decision.action, actions)) return false;
  const stages = list(row(decision.evidence).stages).map(row);
  const detailNeeded = expectedDetail(decision.action).length > 0 || Object.hasOwn(decision, "sharedClaimIds");
  const extraStage = stages.at(-1)?.stage === "extras";
  const names = ["action", "target", ...(detailNeeded ? ["detail"] : []), ...(extraStage ? ["extras"] : [])];
  if (stages.length !== names.length || !stages.every((stage, index) => evidenceShape(stage, names[index]) &&
      validIssueStage(stage, decision.action as string, slots, recovery, naming))) return false;
  if (row(stages[0].choices).action !== decision.action || !validTarget(decision.target, slots) ||
      row(stages[1].choices).target !== targetLabel(decision.target, slots)) return false;
  if (decision.action === "request_observation") {
    const observe = row(decision.observe);
    return decision.name === null && decision.feature === null && decision.target.kind !== "none" &&
      closed(observe, ["figureIds", "aspect", "question", "partnerConstrual"]) &&
      ids(observe.figureIds, targetSlotsV21(decision.target)) && observe.figureIds.length > 0 &&
      oneOf(observe.aspect, ["orientation", "part", "contour", "construal", "referent"]) &&
      typeof observe.question === "string" && !!observe.question.trim() && observe.question.length <= 1000 &&
      (observe.partnerConstrual === null || typeof observe.partnerConstrual === "string") && !extraStage && !added.length;
  }
  return isIssueHandlingExecution(execution, slots) && decisionExtrasFit(decision, extraStage ? stages.at(-1)! : null, slots);
}

export function issueHandlingFailureStage(stage: unknown, action: unknown, slots: readonly string[],
    recovery: boolean, naming: boolean): boolean {
  const evidence = row(stage);
  return oneOf(action, actions) && validIssueStage(evidence, action, slots, recovery, naming);
}

function verifiedChoice(stage: Row, key: string, labels: readonly string[]): string | null {
  const choice = row(stage.choices)[key], scores = row(stage.scores)[key];
  return oneOf(choice, labels) && closed(scores, labels) && Object.values(scores).every(finiteScore) ? choice : null;
}

function validExtraChoices(stage: Row): boolean {
  const keys = Object.keys(row(stage.choices));
  const issues = keys.filter(key => /^extra_[0-9]+$/u.test(key));
  if (!issues.length || !issues.every((_, index) => issues.includes("extra_" + index))) return false;
  const required: string[] = [];
  for (let index = 0; index < issues.length; index++) {
    const field = "extra_" + index, alt = "extra_alt_" + index;
    const labels = offeredChoice(stage, field);
    const hold = labels.includes("hold_open"), direct = labels.includes("confirm");
    if (!hold && !direct || !verifiedChoice(stage, field, ["leave", ...(direct ? repairActions : []), ...(hold ? ["hold_open"] : [])])) return false;
    required.push(field);
    if (hold) {
      if (!verifiedChoice(stage, alt, alternatives)) return false;
      required.push(alt);
    }
  }
  return closed(stage.choices, required);
}

function decisionExtrasFit(decision: Row, stage: Row | null, slots: readonly string[]): boolean {
  const choices = row(stage?.choices);
  const selected = Object.keys(choices).filter(key => /^extra_\d+$/u.test(key) && choices[key] !== "leave")
    .map(key => Number(key.slice(6))).sort((a, b) => a - b);
  if (!selected.length) return !Object.hasOwn(decision, "extras");
  return Array.isArray(decision.extras) && decision.extras.length === selected.length && decision.extras.every((extra, n) =>
    closed(extra, ["index", "original"]) && extra.index === selected[n] && validExtra(extra.original, slots) &&
    row(extra.original).action === choices["extra_" + selected[n]]);
}

type HandlingSource = { target: Target; issue: Issue; derivation: "selected" | "repair_prospect_issue" | "previous_action" };
type Anchor = { kind: "human_turn" | "repair_history" | "previous_action"; turn: number }
  | { kind: "issue_claim"; claimId: string; sourceTurn: number };

function liveSource(issue: BoundIssue, target: Target, ctx: IssueHandlingContext): boolean {
  const previous = ctx.prior;
  const inherited = previous?.issue ?? previous?.visualPurpose;
  const sharesPrevious = previous && previous.turn < ctx.turn && equal(inherited, issue) &&
    intersects(targetSlotsV21(target), targetSlotsV21(previous.target));
  return ctx.claims.some(claim => claim.id === issue.claimId && claim.issueId === issue.issueId && claim.sourceTurn === issue.sourceTurn &&
    (intersects(claim.targets, targetSlotsV21(target)) ||
      claim.targets.length === 0 && claim.speaker === "human" &&
        (claim.sourceTurn === ctx.turn || sharesPrevious && claim.sourceTurn === previous.turn)));
}

function currentIssue(ctx: IssueHandlingContext): HandlingSource | null {
  const prospect = row(ctx.prospect), issue = row(prospect.issue);
  const history = prospect.status === "ok" && prospect.prospect !== "no_open_issue" && issue.choice === "issue"
    ? ctx.history.find(entry => entry.turn < ctx.turn && entry.turn === issue.turn && entry.issueId === issue.issueId && entry.candidatesAfter.length) : undefined;
  if (history) {
    const evidence = ctx.claims.filter(claim => claim.issueId === history.issueId && claim.act !== "withdraw" &&
        claim.aspect !== "progress" && intersects(claim.targets, history.candidatesAfter))
      .sort(bySourceTurn).at(-1);
    return { target: toTarget(history.candidatesAfter), derivation: "repair_prospect_issue",
      issue: evidence ? issueRef(evidence) : { kind: "unknown" } };
  }
  const prev = ctx.prior;
  if (!prev || prev.target.kind === "none" || !precedingActions.includes(prev.action)) return null;
  const previousIssue = (repairActions.includes(prev.action) ? prev.visualPurpose : prev.issue) ?? { kind: "unknown" };
  return { target: prev.target, derivation: "previous_action",
    issue: previousIssue.kind !== "resolve_issue" || liveSource(previousIssue, prev.target, ctx) ? previousIssue : { kind: "unknown" } };
}

function sourceAnchor(source: HandlingSource, ctx: IssueHandlingContext): Anchor | null {
  if (source.issue.kind === "resolve_issue") {
    return { kind: "issue_claim", claimId: source.issue.claimId, sourceTurn: source.issue.sourceTurn };
  }
  const targets = targetSlotsV21(source.target);
  const history = ctx.history.filter(entry => entry.turn < ctx.turn && intersects(entry.candidatesAfter, targets))
    .sort((a, b) => a.turn - b.turn).at(-1);
  if (history) return { kind: "repair_history", turn: history.turn };
  const prev = ctx.prior;
  if (!prev || !precedingActions.includes(prev.action)) return null;
  const previousTargets = targetSlotsV21(prev.target);
  return !targets.length || !previousTargets.length || intersects(targets, previousTargets) ? { kind: "previous_action", turn: prev.turn } : null;
}

export function issueHandlingRelation(decision: unknown, intervention: unknown, executed: unknown,
    label: unknown, ctx: IssueHandlingContext): boolean {
  if (!oneOf(label, ["bypass-enabled", "repair-first"])) return false;
  const original = projectIssueHandlingDecision(decision);
  if (!isIssueHandlingExecution(original, ctx.slots)) return false;
  const stages = list(row(row(decision).evidence).stages).map(row);
  const first = stages[0], detail = stages[2];
  if (first?.stage !== "action" || row(first.choices).action !== original.action) return false;
  const initiatorChoice = verifiedChoice(first, "human_move_on_source", moveSources);
  const commitmentState = verifiedChoice(first, "commitment_state", commitmentStates);
  const switched = original.action === "revisit";
  const switchFunction = switched && detail ? verifiedChoice(detail, "switch_function", switchFunctions) : null;
  const canUseAlternative = switched || original.action === "hold_open" || original.action === "carry_over";
  const alternative = canUseAlternative && detail ? verifiedChoice(detail, "non_bypass_alternative", alternatives) : null;
  if (!initiatorChoice || !commitmentState || switched && !switchFunction || canUseAlternative && !alternative) return false;

  let planned = original;
  let classification = canUseAlternative ? original.action : "other";
  let source: HandlingSource | null = canUseAlternative ? { target: original.target, issue: original.issue!, derivation: "selected" } : null;
  let anchor: Anchor | null = null;
  const flags: string[] = [];
  const via = switchFunction === "secure_progress" ? currentIssue(ctx) : null;
  const sameIssue = via?.issue.kind === "resolve_issue" && original.issue?.kind === "resolve_issue" &&
    via.issue.issueId === original.issue.issueId;
  if (via && !sameIssue) {
    source = via;
    const targets = targetSlotsV21(original.target);
    const destination: Destination = intersects(targetSlotsV21(source.target), targets)
      ? { kind: "same_figure_other_issue" } : { kind: "old_issue", issue: original.issue!, targets };
    planned = { action: "carry_over", target: source.target, name: null, feature: null, observe: null, issue: source.issue, destination };
    classification = "carry_over";
  } else if (switchFunction === "secure_progress") flags.push("secure_progress_without_current_problem");
  else if (switchFunction === "unclear") flags.push("switch_function_unclear");

  const eligible = classification === "hold_open" || classification === "carry_over";
  if (eligible && classification === "hold_open") anchor = { kind: "human_turn", turn: ctx.turn };
  else if (eligible && source && !anchor) anchor = sourceAnchor(source, ctx);
  const initiator = eligible ? initiatorChoice === "human_request" ? "human" : "ai" : null;
  const fromRevisit = switched && classification === "carry_over";
  const rejected = eligible && initiator === "ai" && anchor !== null && label === "repair-first";
  const reason = initiator === "human" ? "human_led" : eligible && anchor === null ? "unanchored" :
    rejected ? "vetoed_issue_handling" : label === "repair-first" ? "not_in_veto_set" : "no_intervention";
  const alternativeShares = row(decision).alternativeSharedClaimIds;
  let expectedAlternative: Execution | null = null;
  if (rejected) {
    if (!source || !alternative) return false;
    const consult = alternative === "consult";
    expectedAlternative = { action: alternative, target: !consult && source.target.kind === "none" ? toTarget(ctx.slots) : source.target,
      name: null, feature: null, observe: null, ...(consult ? { issue: source.issue } :
        { visualPurpose: source.issue, detailFigureIds: [], ...(alternative === "confirm" && Array.isArray(alternativeShares) &&
          alternativeShares.length ? { sharedClaimIds: alternativeShares } : {}) }) };
  }
  const extrasStage = stages.find(stage => stage.stage === "extras");
  const decisionRow = row(decision);
  if (extrasStage && !validExtraChoices(extrasStage) || !decisionExtrasFit(decisionRow, extrasStage ?? null, ctx.slots)) return false;
  const extraRecords = extraInterventions(decisionRow, extrasStage, ctx, label, rejected && classification === "carry_over");
  const extraExecutions = extraRecords.flatMap(entry => entry.executed === null ? [] : [entry.executed]);
  const expectedExecution = { ...(expectedAlternative ?? planned), ...(extraExecutions.length ? { extras: extraExecutions } : {}) };
  if (!isIssueHandlingExecution(executed, ctx.slots) || !equal(executed, expectedExecution)) return false;
  const expected = { schemaVersion: "jev_intervention_v2", policy: S4_ISSUE_HANDLING_POLICY + (label === "repair-first" ? ":veto" : ":accept"),
    disposition: rejected ? "rejected" : "adopted", reasonCode: reason, original, planned,
    handling: { schemaVersion: S4_ISSUE_HANDLING_VERSION, class: classification, via: fromRevisit ? "revisit" : null,
      source, destination: planned.destination ?? null, initiator, anchor, switchFunction, flags, commitmentState, alternative },
    alternative: expectedAlternative, failure: null, ...(extraRecords.length ? { extras: extraRecords } : {}),
    ...(initiator === "human" ? { humanMoveOn: { source: "human", publicTurn: ctx.turn,
      openRepairTurns: ctx.history.filter(entry => entry.turn < ctx.turn).map(entry => entry.turn) } } : {}) };
  return equal(intervention, expected);
}

function extraInterventions(decision: Row, stage: Row | undefined, ctx: IssueHandlingContext, label: string, drop: boolean) {
  return list(decision.extras).map(value => {
    const { index, original } = value as { index: number; original: Extra };
    const hold = original.action === "hold_open";
    const alternative = hold ? row(stage?.choices)["extra_alt_" + index] : null;
    const handling = { class: hold ? "hold_open" : "other", initiator: hold ? "ai" : null,
      anchor: hold ? { kind: "human_turn", turn: ctx.turn } : null, alternative };
    if (drop) return { index, original, handling, disposition: "dropped", reasonCode: "primary_move_rejected", executed: null };
    if (!hold || label === "bypass-enabled") return { index, original, handling, disposition: "adopted",
      reasonCode: label === "bypass-enabled" ? "no_intervention" : "not_in_veto_set", executed: original };
    const consult = alternative === "consult";
    const target = original.target.kind === "none" && !consult ? toTarget(ctx.slots) : original.target;
    const executed = { action: alternative, target, name: null, feature: null, observe: null,
      ...(consult ? { issue: original.issue } : { visualPurpose: original.issue, detailFigureIds: [] }) };
    return { index, original, handling, disposition: "rejected", reasonCode: "vetoed_issue_handling", executed };
  });
}

const issueRef = (claim: Claim): BoundIssue => ({ kind: "resolve_issue", issueId: claim.issueId, claimId: claim.id,
  sourceTurn: claim.sourceTurn });
const bySourceTurn = (a: Claim, b: Claim) => a.sourceTurn - b.sourceTurn || (a.turn ?? a.sourceTurn) - (b.turn ?? b.sourceTurn);
function groupClaims(claims: readonly Claim[]): Map<string, Claim[]> {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const group = groups.get(claim.issueId);
    if (group) group.push(claim);
    else groups.set(claim.issueId, [claim]);
  }
  return groups;
}

function latestUnresolvedSource(group: readonly Claim[]): Claim | undefined {
  const active = [...group].sort(bySourceTurn);
  const substantive = active.filter(claim => !["acknowledge", "defer", "revisit", "withdraw"].includes(claim.act ?? ""));
  const latest = substantive.at(-1);
  const support = substantive.some(claim => claim.act === "agree" || claim.act === "name_accept");
  const denial = substantive.some(claim => claim.act === "deny" || claim.act === "name_reject");
  const latestFocus = active.filter(claim => claim.act === "defer" || claim.act === "revisit").at(-1);
  return support && !denial && latestFocus?.act !== "defer" && latest?.act !== "ask" ? undefined : latest;
}

function wireClaims(value: unknown): Claim[] {
  return list(value).map(row).filter(claim => id(claim.id) && id(claim.issueId) && age(claim.sourceTurn) &&
    Array.isArray(claim.targets) && claim.targets.every(id) && claim.aspect !== "progress" && claim.act !== "withdraw") as Claim[];
}

function issueChoices(claims: Claim[], target: Target, turn: unknown): Record<string, BoundIssue> {
  const figures = targetSlotsV21(target), groups = groupClaims(claims.filter(claim => intersects(figures, claim.targets) ||
    claim.targets.length === 0 && claim.speaker === "human" && claim.sourceTurn === turn &&
      !["acknowledge", "defer", "revisit"].includes(claim.act ?? "")));
  return Object.fromEntries([...groups.values()].map(latestUnresolvedSource).filter((claim): claim is Claim => !!claim)
    .map((claim, index) => ["issue_" + index, issueRef(claim)]));
}

function destinations(input: Row, target: Target, slots: readonly string[], claims: Claim[]): Record<string, Destination> {
  const figures = targetSlotsV21(target), byId = (figure: string) => row(row(input.figures)["f" + slots.indexOf(figure)]);
  const offered: Record<string, Destination> = { partner_choice: { kind: "partner_choice" } };
  slots.forEach((figure, index) => {
    if (!figures.includes(figure) && byId(figure).status !== "agreed")
      offered["figure_" + index] = { kind: "other_figure", figureId: figure };
  });
  if (target.kind === "single" && byId(target.figureId).status !== "agreed") offered.same_figure_naming = { kind: "same_figure_naming" };
  if (figures.length) offered.same_figure_other_issue = { kind: "same_figure_other_issue" };
  const pastIssues = new Set<string>();
  const groups = groupClaims(claims);
  let index = 0;
  for (const handling of [...list(input.handlings)].reverse()) {
    if (!Array.isArray(handling) || !["hold_open", "carry_over"].includes(handling[1]) || !id(handling[3])) continue;
    const issueId = handling[3];
    if (pastIssues.has(issueId)) continue;
    pastIssues.add(issueId);
    const claim = latestUnresolvedSource(groups.get(issueId) ?? []);
    if (!claim || !ids(claim.targets, slots) || intersects(figures, claim.targets) ||
        !claim.targets.some(figure => byId(figure).status !== "agreed")) continue;
    offered["old_" + index++] = { kind: "old_issue", issue: issueRef(claim), targets: claim.targets };
    if (index === 8) break;
  }
  return offered;
}

function extraCandidates(primary: Execution, claims: readonly Claim[], turn: number) {
  const target = targetSlotsV21(primary.target), primaryIssue = primary.issue ?? primary.visualPurpose;
  const primaryId = primaryIssue?.kind === "resolve_issue" ? primaryIssue.issueId : null;
  const unresolved = primaryId === null && [...repairActions, "hold_open", "consult"].includes(primary.action);
  const dest = primary.destination;
  if (primary.action === "close" || unresolved && !target.length ||
      dest && (dest.kind === "partner_choice" || dest.kind === "same_figure_naming" ||
        dest.kind === "same_figure_other_issue" && primaryId === null)) return [];
  const moving = primary.action === "revisit" ? target : dest?.kind === "old_issue" ? dest.targets :
    dest?.kind === "other_figure" ? [dest.figureId] : dest?.kind === "same_figure_other_issue" ? target : null;
  const destId = dest?.kind === "old_issue" && dest.issue.kind === "resolve_issue" ? dest.issue.issueId : null;
  const naming = ["agree", "propose_name"].includes(primary.action);
  const eligible = [...groupClaims(claims).values()].map(latestUnresolvedSource);
  return eligible.flatMap(claim => {
    if (!claim || claim.issueId === primaryId && claim.issueId !== destId) return [];
    if (moving) return intersects(moving, claim.targets) ? [{ claim, labels: ["leave", ...repairActions] }] : [];
    if (claim.speaker !== "human" || claim.sourceTurn !== turn || unresolved && !claim.targets.length ||
        (naming || unresolved) && intersects(target, claim.targets)) return [];
    return [{ claim, labels: ["leave", ...(claim.targets.length ? repairActions : []), "hold_open"] }];
  });
}

function extraQuestionMatches(question: unknown, labels: readonly string[], source: Row): boolean {
  if (!closed(question, ["type", "instructions", "criteria"]) || question.type !== "choice" ||
      !closed(question.criteria, labels) || !Object.values(question.criteria).every(value => typeof value === "string" && !!value.trim()) ||
      typeof question.instructions !== "string") return false;
  const prefix = "公開の出所: ";
  const lines = question.instructions.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1) return false;
  try { return equal(JSON.parse(lines[0].slice(prefix.length)), source); } catch { return false; }
}

export function issueHandlingExtraRequestsMatch(decision: Row, input: Row, ctx: IssueHandlingContext,
    questions?: Row, stage?: Row): boolean {
  const primary = projectIssueHandlingDecision(decision);
  if (!isIssueHandlingExecution(primary, ctx.slots)) return decision.action === "request_observation" && !stage;
  // Take the retained ids from the input window, then recover the quote and
  // installation turn from the independently reconstructed public claims.
  const wire = wireClaims(input.priorClaims), saved = new Map(ctx.claims.map(claim => [claim.id, claim]));
  const relevant = wire.map(claim => saved.get(claim.id));
  if (relevant.some((claim, index) => !claim || !["id", "issueId", "sourceTurn", "targets", "speaker", "act", "aspect"].every(key =>
    equal(row(claim)[key], row(wire[index])[key])))) return false;
  const candidates = extraCandidates(primary, relevant as Claim[], ctx.turn);
  if (!stage || !questions) return candidates.length === 0;
  const selected = Object.fromEntries(["action", "target", "visualPurpose", "issue", "destination"]
    .filter(key => Object.hasOwn(primary, key)).map(key => [key, row(primary)[key]]));
  if (!candidates.length || !equal(input.selected, selected) || !validExtraChoices(stage) ||
      !decisionExtrasFit(decision, stage, ctx.slots)) return false;
  const expectedQuestions: string[] = [];
  const originals: unknown[] = [];
  for (const [index, { claim, labels }] of candidates.entries()) {
    const key = "extra_" + index, alt = "extra_alt_" + index;
    const source = { quote: claim.quote, speaker: claim.speaker, sourceTurn: claim.sourceTurn,
      targets: claim.targets.map(figure => "f" + ctx.slots.indexOf(figure)) };
    if (!ids(claim.targets, ctx.slots) || !ctx.events?.some(event => event.seq === claim.sourceTurn &&
        event.speaker === claim.speaker && !event.nonReferential && literalSpan(event.text, claim.quote)) ||
        !extraQuestionMatches(questions[key], labels, source)) return false;
    expectedQuestions.push(key);
    if (labels.includes("hold_open")) {
      if (!extraQuestionMatches(questions[alt], alternatives, source)) return false;
      expectedQuestions.push(alt);
    }
    const action = verifiedChoice(stage, key, labels);
    if (!action) return false;
    if (action === "leave") continue;
    const goal = issueRef(claim);
    originals.push({ index, original: { action, target: targetOrNone(claim.targets), name: null, feature: null, observe: null,
      ...(action === "hold_open" ? { issue: goal } : { visualPurpose: goal, detailFigureIds: [] }) } });
  }
  return closed(questions, expectedQuestions) && equal(decision.extras ?? [], originals);
}

// The dynamic criteria must themselves encode the independently reconstructed
// choices. Checking only the selected label would let the recorder alter a
// destination or silently withhold a choice from one strategy.
function catalogMatches(criteria: Row, fixed: readonly string[], expected: Record<string, BoundIssue | Destination>): boolean {
  if (!closed(criteria, [...fixed, ...Object.keys(expected)])) return false;
  return Object.entries(expected).every(([label, choice]) => {
    const text = criteria[label];
    if (typeof text !== "string") return false;
    try { return equal(JSON.parse(text), choice); } catch { return false; }
  });
}

export function issueHandlingRequestMatches(input: Row, questions: Row, stage: Row, decision: Row,
    slots: readonly string[], recovery: boolean, naming: boolean, ctx?: IssueHandlingContext): boolean {
  if (input.issueHandlingVersion !== S4_ISSUE_HANDLING_VERSION || Object.hasOwn(input, "humanLedMoveOn") ||
      ["strategy", "condition", "intervention", "interventionPolicy", "vetoHandlings"].some(key => Object.hasOwn(input, key)) ||
      !closed(questions, Object.keys(row(stage.choices))) ||
      !oneOf(decision.action, actions) || !validIssueStage(stage, decision.action, slots, recovery, naming)) return false;
  if (stage.stage === "extras") return !!ctx && issueHandlingExtraRequestsMatch(decision, input, ctx, questions, stage);
  if (stage.stage !== "detail" || !issueActions.includes(decision.action)) return true;
  if (!validTarget(decision.target, slots) || !equal(input.selected, { action: decision.action, target: decision.target })) return false;
  const claims = wireClaims(input.priorClaims);
  const issues = issueChoices(claims, decision.target, input.turn);
  const choices = row(stage.choices), selectedIssue = choices.handled_issue;
  if (typeof selectedIssue !== "string" || !catalogMatches(row(row(questions.handled_issue).criteria), sourceLabels, issues) ||
      !equal(decision.issue, Object.hasOwn(issues, selectedIssue) ? issues[selectedIssue] : { kind: selectedIssue })) return false;
  if (decision.action !== "carry_over") return true;
  const offered = destinations(input, decision.target, slots, claims);
  const criteria = row(row(questions.carry_destination).criteria);
  const destination = choices.carry_destination;
  return typeof destination === "string" && Object.hasOwn(offered, destination) &&
    catalogMatches(criteria, [], offered) &&
    equal(decision.destination, offered[destination]);
}

export function publishedIssueHandlings(judgments: unknown, slots: readonly string[]): unknown[][] {
  return list(judgments).flatMap(value => {
    const j = row(value), publication = row(j.generatedPublication);
    const execution = row(row(publication.recovery).executed ?? row(j.jevTurn).executed);
    if (publication.continuation || !age(j.turnIndex) || !isIssueHandlingExecution(execution, slots)) return [];
    const ordinal = (figures: readonly string[]) => figures.map(figure => "f" + slots.indexOf(figure));
    const kind = (issue: Issue) => issue.kind === "resolve_issue" ? issue.issueId : issue.kind;
    const dest = execution.destination;
    const destination = !dest ? null : dest.kind === "other_figure" ? ["other_figure", ordinal([dest.figureId])[0]] :
      dest.kind === "old_issue" ? ["old_issue", kind(dest.issue), ordinal(dest.targets)] : dest.kind;
    const primary = issueActions.includes(execution.action) && execution.issue ?
      [[j.turnIndex, execution.action, ordinal(targetSlotsV21(execution.target)), kind(execution.issue), destination]] : [];
    const extras = (execution.extras ?? []).flatMap(extra => extra.issue ?
      [[j.turnIndex, extra.action, ordinal(targetSlotsV21(extra.target)), kind(extra.issue), null]] : []);
    return [...primary, ...extras];
  }).sort((a, b) => (a[0] as number) - (b[0] as number)).slice(-16);
}

export function publishedPreviousExtras(judgments: unknown, slots: readonly string[]): unknown[][] | undefined {
  const last = row(list(judgments).at(-1)), publication = row(last.generatedPublication);
  const execution = row(publication.recovery).executed ?? row(last.jevTurn).executed;
  if (publication.continuation || !isIssueHandlingExecution(execution, slots) || !execution.extras) return undefined;
  return execution.extras.map(extra => {
    const issue = extra.issue ?? extra.visualPurpose;
    return [extra.action, targetSlotsV21(extra.target).map(figure => "f" + slots.indexOf(figure)),
      issue?.kind === "resolve_issue" ? issue.issueId : issue?.kind];
  });
}

export function issueHandlingFeatureScope(execution: Execution, slots: readonly string[], continuation: boolean): string[] | null {
  if (continuation) return null;
  const visual = [execution, ...(execution.extras ?? [])].filter(item =>
    [...repairActions, "hold_open", "carry_over", "revisit"].includes(item.action));
  if (!visual.length) return null;
  return [...new Set(visual.flatMap(item => {
    const target = targetSlotsV21(item.target);
    if (item.action === "hold_open" && !target.length) return [...slots];
    if (item.action !== "carry_over") return target;
    const dest = item.destination;
    const moved = dest?.kind === "other_figure" ? [dest.figureId] : dest?.kind === "old_issue" ? dest.targets : [];
    return target.length || moved.length ? [...target, ...moved] : [...slots];
  }))];
}

export function issueHandlingPartsMatch(publication: Row, execution: Execution, speech: string,
    draft?: readonly { item: number; text: string }[]): boolean {
  if (!execution.extras?.length) return !Object.hasOwn(publication, "parts");
  const parts = publication.parts;
  if (!Array.isArray(parts) || parts.length !== execution.extras.length + 1 || draft && draft.length !== parts.length ||
      speech.length > 12000) return false;
  const seen = new Set<unknown>();
  let start = 0;
  for (const [index, part] of parts.entries()) {
    if (!closed(part, ["item", "start", "end", "textSha256"]) || !Number.isSafeInteger(part.item) ||
        (part.item as number) < 0 || (part.item as number) >= parts.length || seen.has(part.item) ||
        part.start !== start || !age(part.end) || part.end <= start || part.end > speech.length) return false;
    const text = speech.slice(start, part.end);
    if (!text.trim() || part.textSha256 !== sha256(text) ||
        draft && (!equal(draft[index], { item: part.item, text }))) return false;
    seen.add(part.item);
    start = part.end;
    if (index + 1 < parts.length && speech[start++] !== "\n") return false;
  }
  return publication.transition ? speech[start] === "\n" && row(publication.transition).start === start + 1 : start === speech.length;
}

export function issueHandlingSourcesMatch(publication: Row, executions: readonly unknown[], slots: readonly string[],
    turn: number, events?: readonly PublicEvent[], claims?: readonly Claim[], prior: IssueHandlingContext["prior"] = null): boolean {
  const required: { issue: BoundIssue; target: Target }[] = [];
  for (const v of executions) {
    if (!isIssueHandlingExecution(v, slots)) return false;
    for (const item of [v, ...(v.extras ?? [])]) {
      const issue = item.issue ?? item.visualPurpose;
      if (issue?.kind === "resolve_issue") required.push({ issue, target: item.target });
    }
    const dest = v.destination;
    if (dest?.kind === "old_issue" && dest.issue.kind === "resolve_issue")
      required.push({ issue: dest.issue, target: toTarget(dest.targets) });
  }
  const claimIds = new Set(required.map(({ issue }) => issue.claimId));
  const proofs = publication.visualPurposeSources ?? [];
  if (Object.hasOwn(publication, "visualPurposeSources") !== (claimIds.size > 0) ||
      !Array.isArray(proofs) || proofs.length !== claimIds.size) return false;
  for (const proof of proofs) {
    if (!closed(proof, ["id", "issueId", "sourceTurn", "targets", "speaker", "quote"]) || !id(proof.id) ||
        !claimIds.delete(proof.id) || !id(proof.issueId) || !age(proof.sourceTurn) ||
        proof.sourceTurn > turn || !ids(proof.targets, slots) || !id(proof.quote) ||
        !oneOf(proof.speaker, ["human", "ai"])) return false;
    const retained = claims?.find(claim => claim.id === proof.id);
    if (retained && ["id", "issueId", "sourceTurn", "targets", "speaker", "quote"].some(key =>
      !equal(row(retained)[key], proof[key]))) return false;
    const event = events?.find(event => event.seq === proof.sourceTurn && event.speaker === proof.speaker && !event.nonReferential);
    if (events && (!event || !literalSpan(event.text, proof.quote))) return false;
  }
  return required.every(({ issue, target }) => liveSource(issue, target, { slots, turn, claims: proofs, history: [], prior }));
}

const basisActions = ["hold_open", "carry_over", "revisit"];
const basisClaimKeys = ["id", "issueId", "sourceTurn", "turn", "targets", "speaker", "act", "aspect", "quote"];
export function issueHandlingBasisMatches(publication: Row, decisions: readonly unknown[], ctx: IssueHandlingContext): boolean {
  const needsBasis = decisions.some(value => oneOf(row(value).action, basisActions));
  if (!needsBasis) return !Object.hasOwn(publication, "handlingBasis");
  const basis = publication.handlingBasis;
  if (!closed(basis, ["repairHistory", "priorClaims"]) || !Array.isArray(basis.priorClaims)) return false;
  const expectedHistory = ctx.history.map(({ turn, issueId, candidatesAfter }) => ({ turn, issueId, candidatesAfter }));
  if (!equal(basis.repairHistory, expectedHistory)) return false;
  const prospect = row(ctx.prospect), selected = row(prospect.issue);
  const prior = ctx.prior?.issue ?? ctx.prior?.visualPurpose;
  const relevant = ctx.claims.filter(claim => prospect.status === "ok" && selected.choice === "issue" &&
    claim.issueId === selected.issueId || prior?.kind === "resolve_issue" && claim.id === prior.claimId);
  if (!equal(basis.priorClaims, relevant.map(claim => Object.fromEntries(basisClaimKeys.map(key => [key, row(claim)[key]]))))) return false;
  return basis.priorClaims.every(claim => closed(claim, basisClaimKeys) && id(claim.id) && id(claim.issueId) && id(claim.quote) &&
    age(claim.sourceTurn) && age(claim.turn) && claim.sourceTurn <= claim.turn && claim.turn <= ctx.turn &&
    ids(claim.targets, ctx.slots) && oneOf(claim.speaker, ["human", "ai"]) && id(claim.act) && id(claim.aspect) &&
    (!ctx.events || ctx.events.some(event => !event.nonReferential && event.seq === claim.sourceTurn &&
      event.speaker === claim.speaker && literalSpan(event.text, claim.quote as string))));
}

export function issueHandlingCloseMatches(publication: Row, action: string, decision: unknown, ledger: Row): boolean {
  if (action !== "close") return !Object.hasOwn(publication, "close");
  const first = row(list(row(row(decision).evidence).stages)[0]);
  const initiator = verifiedChoice(first, "human_move_on_source", moveSources);
  return initiator !== null && equal(publication.close, {
    unresolved: Object.values(ledger).some(entry => row(entry).status !== "agreed"),
    initiator: initiator === "human_request" ? "human" : "ai",
  });
}

export function issueHandlingLedger(before: Row, execution: Execution, withdrawal: unknown): Row | null {
  const w = row(withdrawal);
  if (Object.values(before).some(entry => !["unassigned", "tentative", "agreed"].includes(String(row(entry).status)))) return null;
  if (execution.target.kind !== "single") return withdrawal === null ? before : null;
  const id = execution.target.figureId, prior = row(before[id]), name = execution.name;
  if (!Object.hasOwn(before, id)) return null;
  if (withdrawal !== null) return execution.action === "repair" && w.figureId === id && equal(w.prior, prior) ?
    { ...before, [id]: { status: "unassigned", name: null } } : null;
  if (!["propose_name", "agree"].includes(execution.action)) return before;
  if (!name) return null;
  const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s/gu, "")
    .replace(/[\u30a1-\u30f6]/gu, char => String.fromCharCode(char.charCodeAt(0) - 0x60));
  const same = (other: unknown) => typeof other === "string" && normalize(other) === normalize(name);
  if (Object.entries(before).some(([figure, entry]) => figure !== id && same(row(entry).name)) ||
      prior.name !== null && prior.status === "agreed" && !same(prior.name)) return null;
  return { ...before, [id]: { status: execution.action === "agree" || prior.status === "agreed" ? "agreed" : "tentative", name } };
}

export function issueHandlingPublicationPath(publication: Row, execution: Execution,
    slots: readonly string[], state: Row, turn: number, speech: string): boolean {
  const pre = issueHandlingFeatureScope(execution, slots, Boolean(publication.continuation)) !== null;
  const pending = row(row(state.aiPublic).pending), job = row(state.deferredAiExtraction);
  if (Object.hasOwn(publication, "visualFeatures") !== pre || pending.aiSeq === turn + 1 && Object.keys(job).length) return false;
  const source = pending.aiSeq === turn + 1 ? pending : job;
  if (source.aiSeq !== turn + 1 || source.textSha256 !== sha256(speech)) return false;
  if (source === pending) return !Object.keys(job).length;
  return job.schemaVersion === (pre ? "deferred_ai_classification_v1" : "deferred_ai_extraction_v1") &&
    (pre ? classificationJobExtraction(job.extraction, speech) : !Object.hasOwn(job, "extraction")) &&
    job.eventId === "event-" + (turn + 1) &&
    job.humanEventId === "event-" + turn && job.graphRevision === row(state.graph).revision &&
    job.memoSha256 === sha256(JSON.stringify(state.observationMemo));
}

function classificationJobExtraction(value: unknown, speech: string): boolean {
  return closed(value, ["segments", "rejected", "sha256"]) && Array.isArray(value.segments) && Array.isArray(value.rejected) &&
    value.segments.every(segment => typeof row(segment).quote === "string" && literalSpan(speech, row(segment).quote as string)) &&
    value.sha256 === hash({ segments: value.segments, rejected: value.rejected });
}

export function extractionEvidenceForJob(rawSegments: unknown, speech: string, slots: readonly string[], turn: number,
    publicTurns: readonly Row[]): Row | null {
  if (!Array.isArray(rawSegments) || rawSegments.length > 32) return null;
  const segments: Row[] = [], rejected: Row[] = [];
  const seen = new Set<string>();
  for (const segment of rawSegments) {
    if (!closed(segment, ["segmentId", "quote", "targets", "aspect", "proposition", "name", "linkedIssueId", "respondsToTurn"]) ||
        !id(segment.segmentId) || segment.segmentId.length > 64 || seen.has(segment.segmentId) ||
        !id(segment.quote) || !id(segment.proposition) || !ids(segment.targets, slots) ||
        !oneOf(segment.aspect, ["referent", "part", "contour", "orientation", "position", "construal", "name", "question", "progress"]) ||
        !(segment.name === null || segment.aspect === "name" && id(segment.name) && segment.name.length <= 80) ||
        !(segment.linkedIssueId === null || id(segment.linkedIssueId) && segment.linkedIssueId.length <= 128) ||
        !(segment.respondsToTurn === null || age(segment.respondsToTurn) && segment.respondsToTurn <= turn &&
          publicTurns.some(event => event.turn === segment.respondsToTurn))) return null;
    seen.add(segment.segmentId);
    const quote = literalSpan(speech, segment.quote)?.text;
    if (segment.aspect === "name" || !quote || quote.length > 160)
      rejected.push({ segmentId: segment.segmentId, reason: segment.aspect === "name" ? "name_by_literal_path" : "nonpublic_quote" });
    else segments.push({ ...segment, quote });
  }
  return { segments, rejected, sha256: hash({ segments, rejected }) };
}

/** The replay producer records the request boundary before it consumes the
 * background extraction. Bind the queued job to the same public event and
 * inputs as the separately recorded pre-turn tape. */
export function issueHandlingReplayBoundary(boundary: unknown, requests: readonly Row[], visual: boolean, expected: {
  turn: number; requestSeq: number; speech: string; memo: unknown; publicTurns: unknown; profileSha256: string; graphRevision?: number;
  extraction?: Row; supportExpected?: boolean;
}): boolean {
  if (!closed(boundary, ["requestsBeforePublication", "job", "graphRevision"])) return false;
  const { requestsBeforePublication: before, graphRevision } = boundary;
  if (!age(before) || before > requests.length || !Number.isSafeInteger(graphRevision) || (graphRevision as number) < 0 ||
      expected.graphRevision !== undefined && graphRevision !== expected.graphRevision) return false;
  const lastGeneration = requests.map(request => request.phase).lastIndexOf("generation");
  if (lastGeneration < 0 || lastGeneration >= before) return false;
  const finalPre = requests.slice(lastGeneration + 1, before), post = requests.slice(before);
  const beforeExtraction = finalPre.filter(request => request.phase === "ai_extraction");
  if (requests.slice(0, before).some(request => ["ai_function", "ai_support"].includes(String(request.phase)))) return false;
  const classification: string[] = ["ai_function", "ai_support"];
  if (visual) {
    if (beforeExtraction.length !== 1 || beforeExtraction[0].provider !== "luna" ||
        !classificationJobExtraction(expected.extraction, expected.speech)) return false;
    if (!list(expected.extraction?.segments).length) classification.length = 0;
    else if (!expected.supportExpected) classification.length = 1;
    if (post.length !== classification.length) return false;
  } else {
    if (beforeExtraction.length || post.length < 1 || post.length > 3) return false;
    classification.unshift("ai_extraction");
  }
  if (!post.every((request, index) => request.phase === classification[index] && request.role === "post_generation" &&
        request.provider === (request.phase === "ai_extraction" ? "luna" : "jev"))) return false;
  return equal(boundary.job, { schemaVersion: visual ? "deferred_ai_classification_v1" : "deferred_ai_extraction_v1",
    state: "queued", error: null, ...(visual ? { extraction: expected.extraction } : {}),
    eventId: "event-" + (expected.turn + 1), humanEventId: "event-" + expected.turn, aiSeq: expected.turn + 1,
    requestSeq: expected.requestSeq, graphRevision, profileSha256: expected.profileSha256,
    memoSha256: sha256(JSON.stringify(expected.memo)), textSha256: sha256(expected.speech),
    publicTurnsSha256: sha256(JSON.stringify(expected.publicTurns)) });
}
