import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleRequest } from './index.mjs';

interface ProxyEnvironment {
  RESEARCH_PROXY_TOKEN: string;
  UPSTREAM_PROVIDER?: string;
  UPSTREAM_API_KEY: string;
  DIALOGUE_MODEL: string;
  MAX_COMPLETION_TOKENS: string;
}

interface InternalResult {
  status: number;
  data: unknown;
}

/**
 * This named entrypoint is accessible through an account-level Service binding,
 * not through the public workers.dev HTTP route. Authentication remains inside
 * this Worker: the existing upstream and proxy secrets never leave its env.
 */
export class InternalResearchProxy extends WorkerEntrypoint<ProxyEnvironment> {
  async chat(payload: unknown): Promise<InternalResult> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { status: 400, data: { error: 'invalid_request' } };
    }
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).byteLength > 18 * 1024 * 1024) {
      return { status: 413, data: { error: 'request_too_large' } };
    }
    const request = new Request('https://internal.proxy/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.env.RESEARCH_PROXY_TOKEN}`,
      },
      body,
    });
    const result = await handleRequest(request, this.env);
    return { status: result.status, data: await result.json() };
  }
}

export default {
  fetch(request: Request, env: ProxyEnvironment): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<ProxyEnvironment>;
