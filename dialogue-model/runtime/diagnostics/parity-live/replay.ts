// Offline native-pipeline replay. Recorded model results are fixed materials,
// never semantic expectations, and this module performs no network/key reads.
import { createDialogueV2 } from "../../v2/dialogue-v2.mjs";
import { createJevDecisionClient } from "../../decision/jev-decision.ts";
import { createJevLocalTestClassifier } from "../../local-grounding/jev-local-test.ts";
import { researchHash } from "../../v2/research-profile.ts";
import type { researchTrialProfile } from "../../v2/research-profile.ts";
import type { JevPrivateState } from "../../v2/jev-turn.ts";
import type { ObservationInput, ReobservationResult } from "../../observation/contract.ts";
import type { LunaClient } from "./live.ts";
import { buildReobservationMessages } from "../../observation/observe.ts";
import { EVIDENCE_NORMALIZED_ENVELOPE_FIELDS, imageProjection, projectReplayValue } from "./evidence.ts";
import type { ReplaySide } from "./evidence.ts";
export type Profile = ReturnType<typeof researchTrialProfile>;
export type ReplayTape = { state: JevPrivateState; events: Array<{ id: string; seq: number; speaker: "human" | "ai"; text: string }>;
  luna: Array<{ phase: string; response: Awaited<ReturnType<LunaClient["complete"]>> }>;
  jev: Array<Record<string, unknown>>; reobservations: ReobservationResult[];
  expectedRequests: Array<{ provider: string; phase: string; requestSha256: string }> };
// No JSON/body keys are removed. Only envelope metadata outside the actual wire
// body is excluded; phase deadlines remain represented by the effective profile.
export const REPLAY_EXCLUDED_ENVELOPE_FIELDS = EVIDENCE_NORMALIZED_ENVELOPE_FIELDS;
export function createProfileDialogue(profile: Profile, options: Parameters<typeof createDialogueV2>[0]) {
  return createDialogueV2({ ...options, referenceMemory: profile.referenceMemory, decisionMode: profile.decisionMode,
    utteranceStyle: profile.utteranceStyle, maxReobservations: profile.maxReobservations,
    localGrounding: { ...options.localGrounding!, timeoutMs: profile.timeouts.localMs, aiPublicClaims: profile.localGrounding.aiPublicClaims } });
}
export async function pairedReplay(tape: ReplayTape, own: ObservationInput, expectedModel: string, profile: Profile) {
  const sides: ReplaySide[] = [];
  const replay = async (label: "repair-first" | "bypass-enabled") => {
    const frozen = structuredClone(tape), requests: ReplayTape["expectedRequests"] = [];
    const material = { state: structuredClone(frozen.state), events: structuredClone(frozen.events),
      luna: structuredClone(frozen.luna), jev: structuredClone(frozen.jev), reobservations: structuredClone(frozen.reobservations),
      own: { ownImage: imageProjection(own.ownImage), ownAnchors: structuredClone(own.ownAnchors) },
      model: expectedModel, profile: structuredClone(profile), boundary: { luna: "complete_messages", jev: "http_json_body" } };
    const side: ReplaySide = { label, material, materialSha256: researchHash(material), requests: [] }; sides.push(side);
    const capture = (provider: "luna" | "jev", phase: string, body: unknown) => {
      const payload = projectReplayValue(body, own.ownImage), requestSha256 = researchHash(body);
      requests.push({ provider, phase, requestSha256 });
      side.requests.push({ provider, phase, payload, payloadSha256: researchHash(payload), recordedRequestSha256: requestSha256 });
    };
    let lunaIndex = 0, jevIndex = 0, observationIndex = 0;
    const client = { async complete(messages: unknown[], opts: { phase: string }) {
      capture("luna", opts.phase, messages);
      const next = frozen.luna[lunaIndex++];
      if (!next || next.phase !== opts.phase) throw new Error("replay_luna_unreached");
      return structuredClone(next.response);
    } };
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)), keys = Object.keys(body.questions), state = JSON.parse(body.state);
      const phase = keys.includes("human_referent") ? "human_referent" : keys.some(k => k.endsWith("_support")) ? "ai_support"
        : keys.some(k => k.endsWith("_act")) ? Object.hasOwn(state, "aiSeq") ? "ai_function" : "local_function" : "decision";
      capture("jev", phase, body);
      const response = frozen.jev[jevIndex++]; if (!response) throw new Error("replay_jev_unreached");
      return Response.json(response);
    };
    const readKey = async () => "sk-or-SYNTHETIC-offline-replay-key-0000";
    const jev = { enabled: true, readKey, fetchImpl, timeoutMs: profile.timeouts.decisionMs };
    const runtime = createProfileDialogue(profile, { client, image: own.ownImage, anchors: [...own.ownAnchors], strategy: label,
      observer: { async observeAll() { return structuredClone(frozen.state.observationMemo!); }, async reobserve(input) {
        const next = frozen.reobservations[observationIndex++]; if (!next) throw new Error("replay_observation_unreached");
        await client.complete(buildReobservationMessages(input), { phase: "observation_targeted" });
        return structuredClone(next);
      } }, jevDecision: createJevDecisionClient({ ...jev, questionLayout: profile.questionLayout })!,
      localGrounding: { classifier: createJevLocalTestClassifier(jev)!, aiPublicTransport: { readKey, fetchImpl, timeoutMs: profile.timeouts.decisionMs } } });
    await runtime.runAiTurn({ events: frozen.events, privateState: frozen.state, lastEventId: frozen.events.at(-1)!.id, requestSeq: frozen.events.at(-1)!.seq });
    if (lunaIndex !== frozen.luna.length || jevIndex !== frozen.jev.length || observationIndex !== frozen.reobservations.length) throw new Error("replay_unused_material");
    return { requests, contextSha256: researchHash({ profile, requestedModels: { purpose: profile.modelPolicy.purpose, luna: expectedModel, jev: profile.modelPolicy.jevModel },
      respondedModels: [...frozen.luna.map(r => r.response.model), ...frozen.jev.map(r => r.model)] }) };
  };
  try {
    const a = await replay("repair-first"), b = await replay("bypass-enabled");
    const same = researchHash(a) === researchHash(b), reproduced = researchHash(a.requests) === researchHash(tape.expectedRequests);
    return { status: same && reproduced ? "same_material_same_payload" : "same_material_payload_mismatch", requests: a.requests,
      reproducedRecordedWire: reproduced, labelsEqual: same, contextSha256: a.contextSha256, excludedEnvelopeFields: REPLAY_EXCLUDED_ENVELOPE_FIELDS,
      sides };
  } catch (error) { return { status: "not_reached", error: error instanceof Error && ["replay_luna_unreached", "replay_jev_unreached", "replay_observation_unreached", "replay_unused_material"].includes(error.message) ? error.message : "replay_pipeline_failed",
    requests: [], reproducedRecordedWire: false, labelsEqual: false, sides,
    excludedEnvelopeFields: REPLAY_EXCLUDED_ENVELOPE_FIELDS }; }
}
