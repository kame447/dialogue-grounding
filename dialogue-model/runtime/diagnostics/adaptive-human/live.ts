import {createChatClient} from '../../client.mjs';
import {createLiveHuman} from './simulator.ts';

/** The operator supplies credentials; this diagnostic never reads env, files or Keychain. */
export function liveHuman(options: {baseUrl: string; apiKey: string; timeoutMs?: number; maxCompletionTokens?: number},
  fetchImpl: typeof fetch = globalThis.fetch) {
  return createLiveHuman(createChatClient({provider: 'cloudflare', purpose: 'dialogue_turn',
    baseUrl: options.baseUrl, apiKey: options.apiKey, timeoutMs: options.timeoutMs,
    maxCompletionTokens: options.maxCompletionTokens}, fetchImpl));
}
