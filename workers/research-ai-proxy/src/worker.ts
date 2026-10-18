import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleRequest } from './index.mjs';

interface ProxyEnvironment {
  RESEARCH_PROXY_TOKEN: string;
  UPSTREAM_PROVIDER?: string;
  UPSTREAM_API_KEY: string;
  DIALOGUE_MODEL: string;
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
async function forward(env: ProxyEnvironment, path: '/v1/chat/completions' | '/v1/grounding-evidence', payload: unknown): Promise<InternalResult> {
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
  const result = await handleRequest(request, env);
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

export default {
  fetch(request: Request, env: ProxyEnvironment): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<ProxyEnvironment>;
