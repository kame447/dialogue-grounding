import { createChatClient } from '../client.mjs';

type VisionClientConfig = { provider: string; baseUrl: string; apiKey: string; timeoutMs?: number; maxCompletionTokens?: number };

/** Dedicated visual transport; the historical dialogue transport stays unchanged. */
export function createVisualObservationClient(config: VisionClientConfig, fetchImpl: typeof fetch = globalThis.fetch) {
  if (config.provider !== 'cloudflare') throw new Error('Visual observation requires the research proxy');
  return createChatClient({ ...config, purpose: 'visual_observation' }, (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/model-policy')) url.searchParams.set('purpose', 'visual_observation');
    return fetchImpl(url, init);
  });
}
