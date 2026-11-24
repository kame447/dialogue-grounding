import { createChatClient } from '../client.mjs';

type VisionClientConfig = { provider: string; baseUrl: string; apiKey: string; timeoutMs?: number; maxCompletionTokens?: number };

/** Dedicated visual transport; the historical dialogue transport stays unchanged. */
export function createVisualObservationClient(config: VisionClientConfig, fetchImpl: typeof fetch = globalThis.fetch) {
  if (config.provider !== 'cloudflare') throw new Error('Visual observation requires the research proxy');
  return createChatClient({ ...config, purpose: 'visual_observation' }, (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/model-policy')) url.searchParams.set('purpose', 'visual_observation');
    return fetchImpl(url, { ...init, redirect: 'error' }).then(async response => {
      if (!response.ok || !url.pathname.endsWith('/chat/completions')) return response;
      // Fail closed before the legacy chat client can supply a fallback ID.
      const data = await response.clone().json().catch(() => null);
      if (typeof data?.model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,128}$/.test(data.model)) {
        return Response.json({ error: 'invalid_upstream_model' }, { status: 502 });
      }
      return response;
    });
  });
}
