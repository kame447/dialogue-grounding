import { SLOTS } from "../stimuli/board.mjs";

/**
 * Private, model-agnostic working memory. Never add this graph/summary to public
 * participant state. It has no answer key, human-board coordinates, or scorer.
 *
 * createReferenceGraph({ ownObservations: [{ slot, feature }], slots? }) takes ONLY
 * descriptions grounded in the AI's own image, not generated dialogue text.
 * Optional slots are six unique nonempty strings (at most 160 chars each),
 * scoped to this graph; no board correspondence is inferred from their values.
 * Explicit slots are persisted in the graph. Omitting slots preserves the exact
 * legacy v1 graph/view/summary shapes and uses SLOTS, including JSON restores.
 * validateReferenceUpdate(graph, update, { publicTurns }) stages a transition;
 * applyReferenceUpdate(graph, update, { publicTurns, generationSucceeded: true })
 * returns the new graph. Assign that return value together with public history
 * only after generation succeeds. Neither function mutates its inputs. Validation
 * is structural/provenance validation, NOT a semantic judge or proof of consent.
 *
 * update = { expectedRevision, turn, operations }. turn is an increasing public
 * exchange index; publicTurns = [{ turn, speaker: 'human'|'ai', text }]. The
 * caller supplies already-public turns, never a pending generated response.
 * Earlier public turns can be cited when a later judgment identifies a useful
 * referent; sourceTurn records their original turn, not the insertion turn.
 * Operation IDs are '<update.turn>:<local-id>'. References may point to retained
 * records or earlier operations in the same transaction. All operations are
 * explicit judge decisions; no utterance is parsed into an operation here.
 *
 * Types (all keys required, no extras):
 * mention: id, sourceTurn, speaker, quote, slots[], confidence [0,1],
 *   epistemic: unresolved|hypothesis|grounded, intent: refer|name_proposal|
 *   name_acceptance|feature_assertion|feature_acceptance|denial|correction|
 *   acknowledgment, antecedent: mention ID|null.
 * feature: id, slot, feature, polarity: confirmed|denied, mentionId.
 * name: id, slot, name, agreement: none|implicit|explicit, mentionIds[],
 *   replaces: previous name ID|null. Only explicit supported acceptance agrees.
 * question: id, slots[], text, status: open|deferred|resolved, mentionIds[],
 *   replaces: previous question ID|null.
 * focus: id, slot, mode: defer|revisit, mentionId.
 * retract: id, targetId, mentionId, reason (correction/denial provenance).
 *
 * 'grounded' human mentions remain interpretations of a public human reference
 * onto OWN slots; they never establish a known human-board correspondence.
 * Features are immutable attributed reports, separate from own observations.
 * Retractions invalidate dependent evidence; they never move it to another slot.
 * Replacements retain ID provenance, but older replaced records may be pruned.
 * Bounds below are engineering budgets, not research thresholds. Current names,
 * focus, unresolved questions, recent features and their provenance are pinned.
 * Other history is pruned deterministically. Overflow rejects the whole update.
 * Snapshots/JSON summaries are private copies, not participant-facing output.
 */
export const REFERENCE_LIMITS = Object.freeze({
  records: 160, graphChars: 64000, operations: 16, publicTurns: 32,
  observationsPerSlot: 8, unresolvedQuestions: 12, featuresPerSlot: 4,
  recentMentions: 24, recentRepairs: 12,
});
const INTENTS = ["refer", "name_proposal", "name_acceptance", "feature_assertion", "feature_acceptance", "denial", "correction", "acknowledgment"];
const FIELDS = {
  mention: ["sourceTurn", "speaker", "quote", "slots", "confidence", "epistemic", "intent", "antecedent"],
  feature: ["slot", "feature", "polarity", "mentionId"],
  name: ["slot", "name", "agreement", "mentionIds", "replaces"],
  question: ["slots", "text", "status", "mentionIds", "replaces"],
  focus: ["slot", "mode", "mentionId"],
  retract: ["targetId", "mentionId", "reason"],
};
const fail = (code) => { throw new ReferenceGraphError(code); };
export class ReferenceGraphError extends Error {
  constructor(code) { super("Reference memory rejected: " + code); this.name = "ReferenceGraphError"; this.code = code; }
}
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const index = (value) => Number.isSafeInteger(value) && value >= 0;
const ref = (value) => typeof value === "string" && /^[1-9]\d*:[a-zA-Z0-9_-]{1,32}$/.test(value);
const refs = (value) => Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(ref) && new Set(value).size === value.length;
const slots = (value, empty = false, ownSlots = SLOTS) => Array.isArray(value) && (empty || value.length > 0) && value.length <= 6 &&
  value.every((slot) => ownSlots.includes(slot)) && new Set(value).size === value.length;
const graphSlots = (graph) => Object.hasOwn(graph, "slots") ? graph.slots : SLOTS;
function validateSlots(value) {
  if (!Array.isArray(value) || value.length !== 6 || ![...value].every((slot) => text(slot, 160)) ||
      new Set(value).size !== 6) fail("invalid_slots");
  return value;
}
const clone = (value) => structuredClone(value);
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function dependencies(record) {
  if (record.kind === "mention") return record.antecedent ? [record.antecedent] : [];
  if (["name", "question"].includes(record.kind)) return record.mentionIds;
  return [record.mentionId]; // retract target is an audit pointer, not support.
}
function checkRecord(record, ownSlots = SLOTS) {
  const keys = Object.hasOwn(FIELDS, record?.kind) && FIELDS[record.kind];
  if (!keys || !exact(record, ["kind", "id", "turn", ...keys]) || !index(record.turn) || record.turn === 0 ||
      !ref(record.id) || !record.id.startsWith(record.turn + ":")) fail("invalid_record");
  if ((Object.hasOwn(record, "slot") && !ownSlots.includes(record.slot)) ||
      (ownSlots !== SLOTS && Array.isArray(record.slots) && [...record.slots].some((slot) => !ownSlots.includes(slot)))) fail("invalid_slot");
  if (record.kind === "mention") {
    if (!index(record.sourceTurn) || record.sourceTurn === 0 || record.sourceTurn > record.turn ||
        !["human", "ai"].includes(record.speaker) || !text(record.quote, 160) || !slots(record.slots, true, ownSlots) ||
        typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1 ||
        !["unresolved", "hypothesis", "grounded"].includes(record.epistemic) || !INTENTS.includes(record.intent) ||
        !(record.antecedent === null || ref(record.antecedent)) ||
        (record.epistemic === "unresolved" && (record.slots.length !== 0 || record.confidence !== 0)) ||
        (record.epistemic === "hypothesis" && record.slots.length === 0) ||
        (record.epistemic === "grounded" && record.slots.length !== 1)) fail("invalid_mention");
  } else if (record.kind === "feature") {
    if (!text(record.feature, 160) || !["confirmed", "denied"].includes(record.polarity) || !ref(record.mentionId)) fail("invalid_feature");
  } else if (record.kind === "name") {
    if (!text(record.name, 80) || !["none", "implicit", "explicit"].includes(record.agreement) || !refs(record.mentionIds) ||
        !(record.replaces === null || ref(record.replaces))) fail("invalid_name");
  } else if (record.kind === "question") {
    if (!slots(record.slots, false, ownSlots) || !text(record.text, 200) || !["open", "deferred", "resolved"].includes(record.status) ||
        !refs(record.mentionIds) || !(record.replaces === null || ref(record.replaces))) fail("invalid_question");
  } else if (record.kind === "focus") {
    if (!["defer", "revisit"].includes(record.mode) || !ref(record.mentionId)) fail("invalid_focus");
  } else if (!ref(record.targetId) || !ref(record.mentionId) || !text(record.reason, 160)) fail("invalid_retraction");
}
function observations(value, ownSlots = SLOTS) {
  if (!Array.isArray(value) || value.length > 6 * REFERENCE_LIMITS.observationsPerSlot) fail("invalid_observations");
  const seen = new Set();
  for (const item of value) {
    if (!exact(item, ["slot", "feature"]) || !text(item.feature, 160)) fail("invalid_observations");
    if (!ownSlots.includes(item.slot)) fail(ownSlots === SLOTS ? "invalid_observations" : "invalid_slot");
    const key = JSON.stringify([item.slot, item.feature]);
    if (seen.has(key)) fail("invalid_observations");
    seen.add(key);
  }
  if (ownSlots.some((slot) => value.filter((item) => item.slot === slot).length > REFERENCE_LIMITS.observationsPerSlot)) fail("invalid_observations");
  return clone(value);
}
function checkGraph(graph) {
  const keys = ["schemaVersion", "revision", "lastTurn", "ownObservations", "records"];
  if ((!exact(graph, keys) && !exact(graph, [...keys, "slots"])) || graph.schemaVersion !== 1 ||
      !index(graph.revision) || !index(graph.lastTurn) || graph.revision > graph.lastTurn ||
      !Array.isArray(graph.records) || graph.records.length > REFERENCE_LIMITS.records) fail("invalid_graph");
  const ownSlots = graphSlots(graph);
  if (Object.hasOwn(graph, "slots")) validateSlots(ownSlots);
  observations(graph.ownObservations, ownSlots);
  const seen = new Map();
  let last = 0;
  for (const record of graph.records) {
    checkRecord(record, ownSlots);
    if (seen.has(record.id) || record.turn < last || record.turn > graph.lastTurn) fail("invalid_graph");
    for (const id of dependencies(record)) {
      if (seen.get(id)?.kind !== "mention") fail("missing_provenance");
    }
    if (record.kind === "mention" && record.antecedent && seen.get(record.antecedent).sourceTurn > record.sourceTurn) fail("future_antecedent");
    validateSupport(record, [...seen.values()], true);
    seen.set(record.id, record); last = record.turn;
  }
  if (JSON.stringify(graph).length > REFERENCE_LIMITS.graphChars) fail("capacity_exceeded");
  return graph;
}
function inactiveIds(records) {
  const dead = new Set(records.filter((r) => r.kind === "retract").map((r) => r.targetId));
  // Support references always point backwards, so a forward pass suffices.
  for (const record of records) {
    if (record.kind !== "retract" && dependencies(record).some((id) => dead.has(id))) dead.add(record.id);
  }
  return dead;
}
function currentQuestions(records) {
  const replaced = new Set(records.filter((r) => r.kind === "question").map((r) => r.replaces));
  return records.filter((r) => r.kind === "question" && !replaced.has(r.id));
}
function latest(records, kind, slot) { return records.findLast((r) => r.kind === kind && r.slot === slot); }

export function createReferenceGraph(options = {}) {
  if (![[], ["ownObservations"], ["slots"], ["ownObservations", "slots"]].some((keys) => exact(options, keys))) fail("invalid_observations");
  const { ownObservations = [] } = options;
  const ownSlots = options.slots === undefined ? SLOTS : clone(validateSlots(options.slots));
  return freeze({ schemaVersion: 1, revision: 0, lastTurn: 0, ownObservations: observations(ownObservations, ownSlots), records: [],
    ...(options.slots === undefined ? {} : { slots: ownSlots }),
  });
}

function validateSupport(record, records, historical = false) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const dead = inactiveIds(records);
  const mention = (id) => {
    const item = byId.get(id);
    if (item?.kind !== "mention" || dead.has(id)) fail("missing_provenance");
    return item;
  };
  const targets = (m, slot) => m.slots.includes(slot);
  const single = (m, slot) => m.epistemic === "grounded" && m.slots.length === 1 && targets(m, slot);
  if (record.kind === "mention") {
    if (record.antecedent) {
      const previous = mention(record.antecedent);
      if (previous.sourceTurn > record.sourceTurn || record.slots.some((slot) => !previous.slots.includes(slot))) fail("inconsistent_antecedent");
    }
    // Exact isolated deictics/acknowledgments cannot ground a target themselves.
    // This is a conservative guard, not a language understanding mechanism.
    const bare = /^(それ|これ|あれ|はい|うん|そう|そうです|了解|yes|ok)[。！!？?\s]*$/iu.test(record.quote.trim());
    if (record.epistemic === "grounded" && bare &&
        (!record.antecedent || !single(mention(record.antecedent), record.slots[0]))) fail("ungrounded_deictic");
  } else if (record.kind === "feature") {
    const source = mention(record.mentionId);
    if (!targets(source, record.slot) || !["feature_assertion", "feature_acceptance", "denial", "correction"].includes(source.intent)) fail("unsupported_feature");
    const antecedent = source.antecedent && mention(source.antecedent);
    if (!source.quote.includes(record.feature) && !(["feature_acceptance", "denial"].includes(source.intent) && antecedent?.intent === "feature_assertion" &&
        single(source, record.slot) && single(antecedent, record.slot) && antecedent.quote.includes(record.feature))) fail("unsupported_feature");
    if (source.intent === "denial" && record.polarity !== "denied") fail("unsupported_feature");
    if (source.intent === "feature_acceptance" && record.polarity !== "confirmed") fail("unsupported_feature");
  } else if (record.kind === "name") {
    const support = record.mentionIds.map(mention);
    if (!support.every((m) => targets(m, record.slot))) fail("wrong_slot");
    const names = (m) => ["name_proposal", "name_acceptance", "correction"].includes(m.intent) && m.quote.includes(record.name);
    const antecedentNames = (m) => m.antecedent && names(mention(m.antecedent)) && single(mention(m.antecedent), record.slot);
    if (!support.some((m) => names(m) || (m.intent === "name_acceptance" && antecedentNames(m)))) fail("unsupported_name");
    if (record.agreement === "explicit" && !support.some((m) => m.speaker === "human" && m.intent === "name_acceptance" &&
        single(m, record.slot) && (names(m) || antecedentNames(m)))) fail("unsupported_agreement");
    const previous = latest(records, "name", record.slot);
    if (!historical && (previous?.id ?? null) !== record.replaces) fail("replacement_required");
  } else if (record.kind === "question") {
    const support = record.mentionIds.map(mention);
    if (!record.slots.every((slot) => support.some((m) => targets(m, slot)))) fail("wrong_slot");
    if (record.replaces !== null && !historical) {
      const previous = byId.get(record.replaces);
      if (previous?.kind !== "question" || !currentQuestions(records).includes(previous) ||
          JSON.stringify(previous.slots) !== JSON.stringify(record.slots)) fail("invalid_replacement");
    }
  } else if (record.kind === "focus") {
    if (!targets(mention(record.mentionId), record.slot)) fail("wrong_slot");
    const previous = latest(records, "focus", record.slot);
    const name = latest(records, "name", record.slot);
    if (!historical && record.mode === "revisit" && (previous?.mode !== "defer" || dead.has(previous.id) ||
        (name && records.indexOf(name) > records.indexOf(previous)))) fail("not_deferred");
  } else {
    const source = mention(record.mentionId), target = byId.get(record.targetId);
    if (record.targetId === record.mentionId || (!historical && (!target || dead.has(target.id))) || target?.kind === "retract" ||
        !["correction", "denial"].includes(source.intent)) fail("invalid_retraction");
  }
}

function prune(graph) {
  const records = graph.records;
  const byId = new Map(records.map((r) => [r.id, r]));
  const dead = inactiveIds(records);
  const unresolved = currentQuestions(records).filter((r) => r.status !== "resolved" && !dead.has(r.id));
  if (unresolved.length > REFERENCE_LIMITS.unresolvedQuestions) fail("capacity_exceeded");
  const mandatory = new Set(unresolved.map((r) => r.id));
  for (const slot of graphSlots(graph)) {
    for (const kind of ["name", "focus"]) {
      const record = latest(records, kind, slot);
      if (record) mandatory.add(record.id);
    }
    records.filter((r) => r.kind === "feature" && r.slot === slot).slice(-REFERENCE_LIMITS.featuresPerSlot).forEach((r) => mandatory.add(r.id));
  }
  function closure(roots) {
    const keep = new Set(roots), pending = [...roots];
    while (pending.length) {
      const id = pending.pop(), record = byId.get(id);
      // Keeping an older question must also keep its successor; otherwise
      // dropping a resolved successor could reopen the old question.
      const successors = records.filter((r) => (r.kind === "retract" && r.targetId === id) ||
        (record.kind === "question" && r.kind === "question" && r.replaces === id));
      for (const dep of [...dependencies(record), ...successors.map((r) => r.id)]) {
        if (!keep.has(dep)) { keep.add(dep); pending.push(dep); }
      }
    }
    return records.filter((r) => keep.has(r.id));
  }
  const fits = (kept) => kept.length <= REFERENCE_LIMITS.records && JSON.stringify({ ...graph, records: kept }).length <= REFERENCE_LIMITS.graphChars;
  let kept = closure(mandatory);
  if (!fits(kept)) fail("capacity_exceeded");
  const repairs = records.filter((r) => r.kind === "retract" || r.replaces).slice(-REFERENCE_LIMITS.recentRepairs);
  const optional = records.filter((r) => r.kind === "mention").slice(-REFERENCE_LIMITS.recentMentions)
    .concat(repairs.flatMap((r) => [byId.get(r.targetId ?? r.replaces), r].filter(Boolean))).reverse();
  for (const record of optional) {
    const proposed = closure(new Set([...mandatory, record.id]));
    if (fits(proposed)) { mandatory.add(record.id); kept = proposed; }
  }
  return { ...graph, records: kept };
}

function stage(graph, update, publicTurns) {
  checkGraph(graph);
  if (!exact(update, ["expectedRevision", "turn", "operations"]) || update.expectedRevision !== graph.revision) fail("stale_revision");
  if (!index(update.turn) || update.turn <= graph.lastTurn || !Number.isSafeInteger(graph.revision + 1) ||
      !Array.isArray(update.operations) || update.operations.length > REFERENCE_LIMITS.operations) fail("invalid_update");
  if (!Array.isArray(publicTurns) || publicTurns.length > REFERENCE_LIMITS.publicTurns) fail("invalid_public_turns");
  const turnMap = new Map();
  for (const item of publicTurns) {
    const ordinary = exact(item, ["turn", "speaker", "text"]);
    const scripted = exact(item, ["turn", "speaker", "text", "nonReferential"]) && item.nonReferential === true && item.speaker === "ai";
    if ((!ordinary && !scripted) || !index(item.turn) || item.turn === 0 || item.turn > update.turn ||
        !["human", "ai"].includes(item.speaker) || !text(item.text, 12000) || turnMap.has(item.turn + ":" + item.speaker)) fail("invalid_public_turns");
    // Keep the sequence entry for duplicate detection, without admitting any
    // scripted text as a mention, antecedent or downstream name source.
    turnMap.set(item.turn + ":" + item.speaker, scripted ? null : item.text);
  }
  const next = clone(graph);
  for (const op of update.operations) {
    if (!Object.hasOwn(FIELDS, op?.kind) || !exact(op, ["kind", "id", ...FIELDS[op.kind]])) fail("invalid_record");
    const record = { ...op, turn: update.turn };
    checkRecord(record, graphSlots(graph));
    if (next.records.some((r) => r.id === record.id)) fail("duplicate_id");
    if (record.kind === "mention" && !turnMap.get(record.sourceTurn + ":" + record.speaker)?.includes(record.quote)) fail("nonpublic_evidence");
    validateSupport(record, next.records);
    next.records.push(clone(record));
  }
  next.revision++; next.lastTurn = update.turn;
  return freeze(checkGraph(prune(next)));
}

/** Returns a frozen validated UPDATE, not a commit token. Apply revalidates it. */
export function validateReferenceUpdate(graph, update, { publicTurns = [] } = {}) {
  stage(graph, update, publicTurns);
  return freeze(clone(update));
}
export function applyReferenceUpdate(graph, update, { publicTurns = [], generationSucceeded = false } = {}) {
  if (generationSucceeded !== true) fail("generation_not_succeeded");
  return stage(graph, update, publicTurns);
}

/** Detached private view. No graph field is added to any runtime public state. */
export function snapshotReferenceGraph(graph) {
  checkGraph(graph);
  const dead = inactiveIds(graph.records);
  const active = (record) => record && !dead.has(record.id);
  const byId = new Map(graph.records.map((r) => [r.id, r]));
  const sourceTurns = (record) => {
    const turns = new Set(), pending = [...dependencies(record)], seen = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const source = byId.get(id); turns.add(source.sourceTurn); pending.push(...dependencies(source));
    }
    return [...turns].sort((a, b) => a - b);
  };
  const ownSlots = Object.fromEntries(graphSlots(graph).map((slot) => {
    const name = latest(graph.records, "name", slot), focus = latest(graph.records, "focus", slot);
    const candidate = active(name) ? { id: name.id, name: name.name, agreement: name.agreement,
      status: name.agreement === "explicit" ? "agreed" : "tentative", sourceTurns: sourceTurns(name) } : null;
    let status = candidate?.status ?? "unassigned";
    if (active(focus) && (!name || graph.records.indexOf(focus) > graph.records.indexOf(name))) status = focus.mode === "defer" ? "deferred" : candidate ? "tentative" : "unassigned";
    if (candidate) candidate.status = status;
    return [slot, { status, candidate,
      ownObservations: graph.ownObservations.filter((r) => r.slot === slot).map((r) => ({ feature: r.feature, source: "own_image" })),
      features: graph.records.filter((r) => r.kind === "feature" && r.slot === slot && active(r)).map((r) => ({
        id: r.id, feature: r.feature, polarity: r.polarity, speaker: byId.get(r.mentionId).speaker,
        epistemic: "public_report", sourceTurn: byId.get(r.mentionId).sourceTurn, mentionId: r.mentionId,
        targetEpistemic: byId.get(r.mentionId).epistemic, confidence: byId.get(r.mentionId).confidence,
        candidateOwnSlots: byId.get(r.mentionId).slots,
      })),
    }];
  }));
  return clone({ schemaVersion: 1, revision: graph.revision, lastTurn: graph.lastTurn, ownSlots,
    mentions: graph.records.filter((r) => r.kind === "mention" && active(r)).map((r) => ({ ...r,
      scope: r.speaker === "human" ? "human_reference_interpretation" : "own_reference" })),
    questions: currentQuestions(graph.records).filter(active).map((r) => ({ ...r, sourceTurns: sourceTurns(r) })),
    repairs: graph.records.filter((r) => r.kind === "retract" || r.replaces),
  });
}

/** Bounded private JSON for judge input. Never truncates a name or invalid JSON. */
export function summarizeForJudge(graph, { maxChars = 6000 } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > REFERENCE_LIMITS.graphChars) fail("invalid_summary_budget");
  const view = snapshotReferenceGraph(graph);
  const summary = {
    scope: "private_own_slots_not_ground_truth", revision: view.revision,
    ownSlots: Object.fromEntries(graphSlots(graph).map((slot) => [slot, { status: view.ownSlots[slot].status, candidate: view.ownSlots[slot].candidate }])),
    unresolvedQuestions: view.questions.filter((r) => r.status !== "resolved").map((r) => ({
      slots: r.slots, text: r.text, status: r.status, sourceTurns: r.sourceTurns,
    })),
    recentHumanReferences: view.mentions.filter((r) => r.speaker === "human").slice(-8).map((r) => ({
      quote: r.quote, candidateOwnSlots: r.slots, confidence: r.confidence, epistemic: r.epistemic, sourceTurn: r.sourceTurn,
    })),
    omitted: { humanReferences: Math.max(0, view.mentions.filter((r) => r.speaker === "human").length - 8), questions: 0 },
  };
  while (JSON.stringify(summary).length > maxChars && (summary.recentHumanReferences.length || summary.unresolvedQuestions.length)) {
    if (summary.recentHumanReferences.length) { summary.recentHumanReferences.shift(); summary.omitted.humanReferences++; }
    else { summary.unresolvedQuestions.shift(); summary.omitted.questions++; }
  }
  const result = JSON.stringify(summary);
  if (result.length > maxChars) fail("summary_budget_too_small");
  return result;
}
