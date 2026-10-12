import type { ChatMessage, ConditionId } from '../domain/types';
import type { PartnerPort, RespondInput, SubmitNamesInput } from './PartnerPort';

export interface MockPartnerOptions {
  seed?: number;
  latencyMs?: number;
  failNextCalls?: number;
}

const FAILURE = 'MOCK_PARTNER_FAILURE';
const FALLBACK_NAMES = ['とがった形', '細長い形', '角のある形', '広がった形', '小さな形', '曲がった形'];
const ACKNOWLEDGEMENTS = ['なるほど、そういう見方もできますね。', 'わかりました。こちらでも候補が見えてきました。', 'たしかに、その特徴は手がかりになりそうです。'];
const CLARIFICATIONS = ['どのあたりがいちばん目立ちますか？', 'その形の向きについて、もう少し確認してもいいですか？', '先ほどの候補と同じものを指していますか？'];

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
}

function extractQuotedNames(history: ChatMessage[]): string[] {
  const names: string[] = [];
  const pattern = /[「『]([^」』\n]{1,40})[」』]/g;
  for (const message of history) {
    if (message.speaker !== 'human') continue;
    for (const match of message.text.matchAll(pattern)) {
      const name = match[1].trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function quoteName(name: string): string {
  return `「${name.replace(/[「」『』]/g, '').trim()}」`;
}

export class MockPartner implements PartnerPort {
  readonly kind = 'mock' as const;
  private readonly rng: () => number;
  private readonly latencyMs: number;
  private failuresRemaining: number;

  constructor(options: MockPartnerOptions = {}) {
    this.rng = makeRng(options.seed ?? 1);
    this.latencyMs = Math.max(0, options.latencyMs ?? 0);
    this.failuresRemaining = Math.max(0, Math.floor(options.failNextCalls ?? 0));
  }

  failNext(n: number): void {
    this.failuresRemaining += Math.max(0, Math.floor(n));
  }

  private async prepare(signal?: AbortSignal): Promise<void> {
    checkAbort(signal);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error(FAILURE);
    }
    if (this.latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.latencyMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
    checkAbort(signal);
  }

  async respond(input: RespondInput, signal?: AbortSignal) {
    await this.prepare(signal);
    const { condition, turnIndex } = input.policyContext;
    const clarificationChance = condition === 'A' ? 0.5 : 0.15;
    const askedClarification = this.rng() < clarificationChance;
    const humanMessage = [...input.history].reverse().find((message) => message.speaker === 'human')?.text ?? '';
    const quotedName = extractQuotedNames([{ id: '', speaker: 'human', text: humanMessage, at: '' }])[0];
    const index = Math.floor(this.rng() * (askedClarification ? CLARIFICATIONS.length : ACKNOWLEDGEMENTS.length));
    const text = askedClarification
      ? `${quotedName ? `なるほど、${quoteName(quotedName)}ですね。` : ''}${CLARIFICATIONS[index]}`
      : quotedName
        ? `なるほど、その${quoteName(quotedName)}っぽいのはこちらでも見つかりました。`
        : `${ACKNOWLEDGEMENTS[index]} 先へ進めましょう。`;
    return {
      text,
      diagnostics: { mock: true as const, rule: `condition-${condition.toLowerCase()}-turn-${turnIndex}`, askedClarification, condition },
    };
  }

  async submitNames(input: SubmitNamesInput, signal?: AbortSignal) {
    await this.prepare(signal);
    const tokens = input.visibleStimuli.map((item) => item.slotToken);
    const names = extractQuotedNames(input.history);
    const start = Math.floor(this.rng() * Math.max(1, tokens.length));
    const orderedNames = Array.from({ length: tokens.length }, (_, i) => names[(start + i) % Math.max(1, names.length)]);
    const used = new Set<string>();
    const result: Record<string, string> = {};
    for (let i = 0; i < tokens.length; i += 1) {
      let candidate = orderedNames[i];
      if (!candidate || used.has(candidate)) {
        candidate = FALLBACK_NAMES.find((name) => !used.has(name)) ?? `形の候補 ${i + 1}`;
      }
      result[tokens[i]] = candidate;
      used.add(candidate);
    }
    return { names: result, diagnostics: { mock: true as const, note: 'not image understanding' } };
  }
}

export type { ConditionId };
