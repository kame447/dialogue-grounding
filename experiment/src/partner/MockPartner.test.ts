import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../domain/types';
import { MockPartner } from './MockPartner';
import type { RespondInput, SubmitNamesInput } from './PartnerPort';

const history: ChatMessage[] = [{ id: 'm1', speaker: 'human', text: 'これは「青い鳥」でしょうか？', at: '2026-01-01T00:00:00.000Z' }];
const visibleStimuli = Array.from({ length: 6 }, (_, slot) => ({ slotToken: `opaque-${slot}`, slot, stimulus: { id: `alpha-${slot + 1}`, setId: 'alpha' as const, polygons: [], researcherNote: 'DEMO自作:テスト' } }));
const respondInput: RespondInput = { history, visibleStimuli, policyContext: { condition: 'B', round: 1, turnIndex: 0 } };
const namesInput: SubmitNamesInput = { history, visibleStimuli, policyContext: respondInput.policyContext };

describe('MockPartner', () => {
  it('never exposes identifiers, slots or condition in participant replies', async () => {
    const partner = new MockPartner({ seed: 3 });
    for (let i = 0; i < 20; i += 1) {
      const reply = await partner.respond({ ...respondInput, policyContext: { ...respondInput.policyContext, turnIndex: i } });
      expect(reply.text).not.toMatch(/alpha-\d|beta-\d|slot|\bA\b|\bB\b|condition|\d+番/);
      expect(reply.diagnostics).toMatchObject({ mock: true, condition: 'B' });
    }
  });
  it('submits distinct names and uses quoted human proposals', async () => {
    const result = await new MockPartner({ seed: 8 }).submitNames(namesInput);
    expect(Object.keys(result.names)).toEqual(visibleStimuli.map((item) => item.slotToken));
    expect(new Set(Object.values(result.names)).size).toBe(6);
    expect(Object.values(result.names)).toContain('青い鳥');
    expect(result.diagnostics).toEqual({ mock: true, note: 'not image understanding' });
  });
  it('fails the requested call and then recovers', async () => {
    const partner = new MockPartner({ seed: 1, failNextCalls: 1 });
    await expect(partner.respond(respondInput)).rejects.toThrow('MOCK_PARTNER_FAILURE');
    await expect(partner.respond(respondInput)).resolves.toHaveProperty('text');
    partner.failNext(1);
    await expect(partner.submitNames(namesInput)).rejects.toThrow('MOCK_PARTNER_FAILURE');
  });
  it('honours an aborted signal', async () => {
    const partner = new MockPartner({ latencyMs: 100 });
    const controller = new AbortController();
    const pending = partner.respond(respondInput, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
