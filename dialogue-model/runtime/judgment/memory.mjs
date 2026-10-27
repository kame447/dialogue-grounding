import { SLOTS } from "../stimuli/board.mjs";
import { validateReferenceUpdate, REFERENCE_LIMITS, ReferenceGraphError } from "../memory/reference-graph.mjs";
import { groundReference, publicTurnsFromHistory } from "./public-evidence.mjs";

export const REFERENCE_INTENTS = Object.freeze(["refer", "name_proposal", "name_acceptance", "feature_assertion", "feature_acceptance", "denial", "correction", "acknowledgment"]);
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const fail = () => { throw new ReferenceGraphError("invalid_reference"); };

/** Only semantic choices come from the judge. Provenance/IDs are never accepted. */
export function validateReferenceInterpretation(value, slots = SLOTS) {
  const slot = (v) => slots.includes(v);
  if (value === null) return null;
  if (!exact(value, ["slots", "epistemic", "intent", "feature", "nameAcceptance", "deferSlot", "revisitSlot"]) ||
      !Array.isArray(value.slots) || value.slots.length > 6 || !value.slots.every(slot) || new Set(value.slots).size !== value.slots.length ||
      !["unresolved", "hypothesis", "grounded"].includes(value.epistemic) || !REFERENCE_INTENTS.includes(value.intent) ||
      (value.epistemic === "unresolved" && value.slots.length !== 0) ||
      (value.epistemic === "hypothesis" && value.slots.length === 0) ||
      (value.epistemic === "grounded" && value.slots.length !== 1) ||
      !(value.deferSlot === null || slot(value.deferSlot)) || !(value.revisitSlot === null || slot(value.revisitSlot))) fail();
  if (value.feature !== null && (!exact(value.feature, ["slot", "feature", "polarity"]) || !slot(value.feature.slot) ||
      !text(value.feature.feature, 160) || !["confirmed", "denied"].includes(value.feature.polarity))) fail();
  if (value.nameAcceptance !== null && (!exact(value.nameAcceptance, ["slot", "name"]) || !slot(value.nameAcceptance.slot) || !text(value.nameAcceptance.name, 80))) fail();
  return structuredClone(value);
}

// Identical across strategies and absent when the reference-memory option is OFF.
export const MEMORY_INSTRUCTIONS = [
  "AI自身の参照メモは正解表ではなく、自分の画像と公開発話に基づく作業メモです。ledgerとの矛盾は自分で吟味してください。",
  "今回の人間発話の解釈を任意キーreferenceに指定してください。解釈しない場合はnullです。解釈する場合は次の7キーをすべて持つ1個のオブジェクトだけを返してください。",
  "slots: 自分の候補位置の配列。epistemic: unresolved（slots=[]）、hypothesis（1候補以上）、grounded（1候補のみ）。intent: " + REFERENCE_INTENTS.join(" | ") + "。相手の位置や正解対応ではありません。",
  "feature: null、または{slot,feature,polarity}。featureは今回の人間発話に現れる特徴160字以内、polarityはconfirmedかdenied。nameAcceptance: null、または{slot,name}（名前80字以内）。nameAcceptanceは話題の名前の欄です。相手や自分が名前を提案した公開発話でもslotとnameを入れ、intent=name_proposalにしてください。合意かどうかはintentで表します。今回の人間発話または直前の公開AI発話で述べられた名前だけを指定し、特徴への肯定を名前の受入れと混同しないでください。名前の提案にはname_proposal、名前の提案への受け入れにはname_acceptanceを付け、形の特徴への同意（feature_acceptance）や見立ての共有と区別してください。名前を取り消す・否定する発話でも、intentをdenialまたはcorrectionにし、話題の名前をnameAcceptanceに入れてください。",
  "deferSlotとrevisitSlot: それぞれ自分の位置1つまたはnull。解釈に不要なfeature/nameAcceptance/deferSlot/revisitSlotはnull。例えば{slots:[],epistemic:\"unresolved\",intent:\"refer\",feature:null,nameAcceptance:null,deferSlot:null,revisitSlot:null}です。",
  "発話の引用・ID・操作配列・発話番号・confidence・antecedentは生成しないでください。環境が今回の人間発話から出典を付けます。過去の発話や未生成のAI発話の内容を今回の発話として記録しないでください。「はい」「それ」だけでは対象や名称合意を確定しないでください。",
].join("\n");

/** Build and validate each optional operation without discarding a valid mention. */
export function prepareMemory(graph, turn, interpretation = null, publicTurns) {
  const reference = validateReferenceInterpretation(interpretation ?? null, graph.slots ?? SLOTS);
  const operations = [], rejected = [];
  const update = () => validateReferenceUpdate(graph, { expectedRevision: graph.revision, turn, operations }, { publicTurns });
  update();
  if (!reference) return { update: update(), rejected: null };
  const evidence = groundReference({ publicTurns, turn, interpretation: reference });
  // Grounding returns public-source material; the adapter alone assigns op IDs.
  const mentionId = `${turn}:human`;
  const attempt = operation => {
    operations.push(operation);
    try { update(); }
    catch (error) {
      operations.pop();
      if (!(error instanceof ReferenceGraphError)) throw error;
      rejected.push("memory_" + error.code);
    }
  };
  if (evidence.human) {
    if (evidence.antecedent) attempt({ kind: "mention", id: `${turn}:antecedent`, ...evidence.antecedent, antecedent: null });
    const { usesAntecedent, ...human } = evidence.human;
    attempt({ kind: "mention", id: mentionId, ...human,
      antecedent: usesAntecedent && operations.some(op => op.id === `${turn}:antecedent`) ? `${turn}:antecedent` : null });
  }
  // An antecedent is useful only if its current human mention is admissible.
  if (!operations.some(op => op.id === mentionId)) operations.length = 0;
  for (const dropped of evidence.dropped ?? []) rejected.push("memory_" + dropped.reason);
  if (operations.some(op => op.id === mentionId)) {
    const focus = ({ mode, slot }) => attempt({ kind: "focus", id: `${turn}:${mode}`, slot, mode, mentionId });
    if (evidence.feature) attempt({ kind: "feature", id: `${turn}:feature`, ...evidence.feature, mentionId });
    // A lone revisit returns to the deferred slot before a name said in the same
    // turn; staged after it, that name would make the revisit look not deferred.
    const revisitFirst = evidence.focus.length > 0 && evidence.focus.every(({ mode }) => mode === "revisit");
    if (revisitFirst) evidence.focus.forEach(focus);
    if (evidence.name) attempt({ kind: "name", id: `${turn}:name`, ...evidence.name, mentionIds: [mentionId],
      replaces: graph.records.findLast(r => r.kind === "name" && r.slot === evidence.name.slot)?.id ?? null });
    if (!revisitFirst) evidence.focus.forEach(focus);
  }
  return { update: update(), rejected: rejected.length ? [...new Set(rejected)].join(",") : null };
}
export function stageMemory(graph, turn, interpretation = null, publicTurns) {
  return prepareMemory(graph, turn, interpretation, publicTurns).update;
}
export function visibleTurns(history) {
  return publicTurnsFromHistory(history).slice(-REFERENCE_LIMITS.publicTurns);
}
