import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleRequest } from './index.mjs';
import { configuredParticipantPin, participantChoices } from './participant-transport.ts';

interface ProxyEnvironment {
  RESEARCH_PROXY_TOKEN: string;
  UPSTREAM_PROVIDER?: string;
  UPSTREAM_API_KEY: string;
  DIALOGUE_MODEL: string;
  VISION_MODEL?: string;
  PARTICIPANT_MODEL_PIN_JSON?: string;
  MAX_COMPLETION_TOKENS: string;
  RESEARCH_DECISIONS_ENABLED?: string;
  OPENROUTER_DECISIONS_API_KEY?: string;
  RESEARCH_GROUNDING_ENABLED?: string;
}

interface InternalResult {
  status: number;
  data: unknown;
}

// A module function, not a method: every public method of the entrypoint is callable over RPC.
async function forward(env: ProxyEnvironment, path: '/v1/chat/completions' | '/v1/grounding-evidence', payload: unknown, expectedModel: string | null = null): Promise<InternalResult> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 400, data: { error: 'invalid_request' } };
  }
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > 18 * 1024 * 1024) {
    return { status: 413, data: { error: 'request_too_large' } };
  }
  const request = new Request('https://internal.proxy' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.RESEARCH_PROXY_TOKEN}`,
    },
    body,
  });
  const result = await handleRequest(request, env, globalThis.fetch, expectedModel);
  return { status: result.status, data: await result.json() };
}

/**
 * This named entrypoint is accessible through an account-level Service binding,
 * not through the public workers.dev HTTP route. Authentication remains inside
 * this Worker: the existing upstream and proxy secrets never leave its env.
 */
export class InternalResearchProxy extends WorkerEntrypoint<ProxyEnvironment> {
  async chat(payload: unknown): Promise<InternalResult> {
    return forward(this.env, '/v1/chat/completions', payload);
  }

  /** Two-axis grounding evidence for shadow research; off unless RESEARCH_GROUNDING_ENABLED and the upstream secret are set. */
  async grounding(payload: unknown): Promise<InternalResult> {
    return forward(this.env, '/v1/grounding-evidence', payload);
  }
}

/** Named capability for pinned participant trials only. */
export class InternalParticipantProxy extends WorkerEntrypoint<ProxyEnvironment> {
  async participantPolicy() {
    return configuredParticipantPin(this.env);
  }

  async participantChat(payload: unknown, expectedModel: string): Promise<InternalResult> {
    const pin = configuredParticipantPin(this.env);
    if (!pin) return { status: 503, data: { error: 'service_unconfigured' } };
    const purpose = payload && typeof payload === 'object' && Object.hasOwn(payload, 'purpose')
      ? (payload as { purpose: unknown }).purpose : undefined;
    const expected = purpose === 'dialogue_turn' ? pin.lunaModelId : purpose === 'visual_observation' ? pin.terraModelId : null;
    if (expected === null || expected !== expectedModel) return { status: 409, data: { error: 'model_mismatch' } };
    return forward(this.env, '/v1/chat/completions', payload, expected);
  }

  async participantChoices(payload: unknown, expectedModel: string): Promise<InternalResult> {
    return participantChoices(this.env, payload, expectedModel);
  }
}

export default {
  fetch(request: Request, env: ProxyEnvironment): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<ProxyEnvironment>;
