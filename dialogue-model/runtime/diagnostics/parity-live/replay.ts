import {resolveInterventionPolicy} from '../../intervention-policy.ts';
import {JevTurnError} from '../../v2/jev-turn.ts';
import { researchGenerationClient } from '../../v2/research-generation-client.ts';
import { RESEARCH_MAX_DEADLINE_MS } from '../../v2/research-timeouts.ts';
import { resolveModelPolicy } from '../../model-policy.ts';
import type { ResearchTrialProfileV2, ResearchTrialProfileV3 } from '../../v2/research-profile.ts';
// Offline native-pipeline replay. Recorded model results are fixed materials,
// never semantic expectations, and this module performs no network/key reads.
import { createDialogueV2 } from "../../v2/dialogue-v2.mjs";
import { createJevDecisionClient } from "../../decision/jev-decision.ts";
import { createJevLocalTestClassifier } from "../../local-grounding/jev-local-test.ts";
import { researchHash } from "../../v2/research-profile.ts";
import type { researchTrialProfile } from "../../v2/research-profile.ts";
import type { JevPrivateState, JevTurnLocalOptions } from "../../v2/jev-turn.ts";
import type { ObservationInput, ReobservationResult } from "../../observation/contract.ts";
import type { LunaClient } from "./live.ts";
import { buildReobservationMessages } from "../../observation/observe.ts";
import { EVIDENCE_NORMALIZED_ENVELOPE_FIELDS, imageProjection, projectReplayValue } from "./evidence.ts";
import type { ReplaySide } from "./evidence.ts";
import { createChatClient } from "../../client.mjs";
export type Profile = ReturnType<typeof researchTrialProfile> | ResearchTrialProfileV2 | ResearchTrialProfileV3;
export type ReplayTape = { state: JevPrivateState; events: Array<{ id: string; seq: number; speaker: "human" | "ai"; text: string }>;
  luna: Array<{ phase: string; response: Awaited<ReturnType<LunaClient["complete"]>> }>;
  jev: Array<Record<string, unknown>>; reobservations: ReobservationResult[];
  expectedRequests: Array<{ provider: string; phase: string; requestSha256: string;
    actualSendMeasured?: boolean; messagesSha256?: string; sendIds?: number[] }> };
// No JSON/body keys are removed. Only envelope metadata outside the actual wire
// body is excluded; phase deadlines remain represented by the effective profile.
export const REPLAY_EXCLUDED_ENVELOPE_FIELDS = EVIDENCE_NORMALIZED_ENVELOPE_FIELDS;
export function createProfileDialogue(profile: Profile, options: Parameters<typeof createDialogueV2>[0]) {
  const intervention=resolveInterventionPolicy(profile);
  if(Object.hasOwn(options,'interventionPolicy')||Object.hasOwn(options,'decisionTimeoutMs'))throw new JevTurnError('invalid_intervention');
  const local = options.localGrounding as JevTurnLocalOptions | undefined;
  const research = profile.id !== "research_trial_profile_v1";
  const researchLimits = research ? { maxDeadlineMs: RESEARCH_MAX_DEADLINE_MS } : undefined;
  return createDialogueV2({ ...options, ...(intervention.mode==='explicit'?{interventionPolicy:intervention.interventionPolicy!,decisionTimeoutMs:profile.timeouts.decisionMs}:{}), client: research ? researchGenerationClient(options.client, profile.timeouts.generationMs) : options.client, referenceMemory: profile.referenceMemory, decisionMode: profile.decisionMode,
    utteranceStyle: profile.utteranceStyle, maxReobservations: profile.maxReobservations,
    localGrounding: { ...options.localGrounding!, ...(research ? { researchLimits, aiPublicTransport: { ...local?.aiPublicTransport, timeoutMs: profile.timeouts.decisionMs, researchLimits } } : {}), timeoutMs: profile.timeouts.localMs, aiPublicClaims: profile.localGrounding.aiPublicClaims } });
}
export async function pairedReplay(tape: ReplayTape, own: ObservationInput, expectedModel: string, profile: Profile) {
  const sides: ReplaySide[] = [];
  if(profile.id==='research_trial_profile_v3')return {status:'not_reached',error:'replay_pipeline_failed',requests:[],reproducedRecordedPayloads:false,actualLunaHttpMeasured:false,hashScheme:'canonical_json_sha256_not_raw_body_bytes',labelsEqual:false,sides,excludedEnvelopeFields:REPLAY_EXCLUDED_ENVELOPE_FIELDS};
  const replay = async (label: "repair-first" | "bypass-enabled") => {
    const frozen = structuredClone(tape), requests: ReplayTape["expectedRequests"] = [];
    const material = { state: structuredClone(frozen.state), events: structuredClone(frozen.events),
      luna: structuredClone(frozen.luna), jev: structuredClone(frozen.jev), reobservations: structuredClone(frozen.reobservations),
      own: { ownImage: imageProjection(own.ownImage), ownAnchors: structuredClone(own.ownAnchors) },
      model: expectedModel, profile: structuredClone(profile), boundary: { luna: "canonical_http_json", jev: "canonical_http_json",
        hashScheme: "canonical_json_sha256_not_raw_body_bytes" } };
    const side: ReplaySide = { label, material, materialSha256: researchHash(material), requests: [] }; sides.push(side);
    const capture = (provider: "luna" | "jev", phase: string, body: unknown) => {
      const payload = projectReplayValue(body, own.ownImage), requestSha256 = researchHash(body);
      requests.push({ provider, phase, requestSha256 });
      side.requests.push({ provider, phase, payload, payloadDomain: "canonical_http_json", payloadSha256: researchHash(payload),
        preProjectionPayloadSha256: requestSha256, ...(provider === "luna" ? { completeMessagesSha256: researchHash((body as { messages: unknown }).messages) } : {}) });
    };
    let lunaIndex = 0, jevIndex = 0, observationIndex = 0;
    let lunaPhase = "", lunaResponse: ReplayTape["luna"][number]["response"];
    // Use the native serializer offline; no additional generation parameters.
    const httpClient = createChatClient({ provider: "cloudflare", apiKey: "synthetic-offline-replay-key",
      purpose: profile.modelPolicy.purpose, baseUrl: "http://offline.invalid/v1",
      timeoutMs: profile.id === "research_trial_profile_v2" ? profile.timeouts.lunaAttemptMs : profile.lunaRequest.timeoutMs ?? undefined, maxCompletionTokens: profile.lunaRequest.maxCompletionTokens ?? undefined },
    async (_url, init) => {
      capture("luna", lunaPhase, JSON.parse(String(init?.body)));
      return Response.json({ model: lunaResponse.model, choices: [{ message: { content: lunaResponse.text } }],
        usage: { prompt_tokens: lunaResponse.usage?.inputTokens, completion_tokens: lunaResponse.usage?.outputTokens } });
    });
    const client = { async complete(messages: object[], opts: { phase: string; timeoutMs?: number; signal?: AbortSignal }) {
      const next = frozen.luna[lunaIndex++];
      if (!next || next.phase !== opts.phase) throw new Error("replay_luna_unreached");
      lunaPhase = opts.phase; lunaResponse = structuredClone(next.response);
      return profile.id === "research_trial_profile_v2" ? httpClient.complete(messages, opts) : httpClient.complete(messages);
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
    const jev = { enabled: true, readKey, fetchImpl, timeoutMs: profile.timeouts.decisionMs, ...(profile.id === "research_trial_profile_v2" ? { researchLimits: { maxDeadlineMs: RESEARCH_MAX_DEADLINE_MS } } : {}) };
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
    const same = researchHash(a) === researchHash(b), reproduced = researchHash(a.requests) === researchHash(tape.expectedRequests.map(({ provider, phase, requestSha256 }) => ({ provider, phase, requestSha256 })));
    return { status: same && reproduced ? "same_material_same_payload" : "same_material_payload_mismatch", requests: a.requests,
      reproducedRecordedPayloads: reproduced, actualLunaHttpMeasured: tape.expectedRequests.filter(r => r.provider === "luna").every(r => r.actualSendMeasured === true),
      hashScheme: "canonical_json_sha256_not_raw_body_bytes", labelsEqual: same, contextSha256: a.contextSha256, excludedEnvelopeFields: REPLAY_EXCLUDED_ENVELOPE_FIELDS,
      sides };
  } catch (error) { return { status: "not_reached", error: error instanceof Error && ["replay_luna_unreached", "replay_jev_unreached", "replay_observation_unreached", "replay_unused_material"].includes(error.message) ? error.message : "replay_pipeline_failed",
    requests: [], reproducedRecordedPayloads: false, actualLunaHttpMeasured: false, hashScheme: "canonical_json_sha256_not_raw_body_bytes", labelsEqual: false, sides,
    excludedEnvelopeFields: REPLAY_EXCLUDED_ENVELOPE_FIELDS }; }
}
