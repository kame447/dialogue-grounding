import { useEffect, useRef, useState } from 'react';
import type { Action } from '../domain/session';
import type { BlockIndex, SessionState } from '../domain/types';
import { randomId } from '../domain/ids';
import type { PartnerPort, VisibleStimulus } from '../partner/PartnerPort';
import { getStimulus } from '../stimuli/sets';

/**
 * Partner-side view of a block. In this mock the slot token is the stimulus id;
 * a production adapter must keep this mapping on the server (docs/partner-port.md).
 */
export function partnerVisibleStimuli(session: SessionState, blockIndex: BlockIndex): VisibleStimulus[] {
  return session.blocks[blockIndex].layout.partner.map((id, slot) => ({ slotToken: id, slot, stimulus: getStimulus(id) }));
}

function policyContext(session: SessionState, blockIndex: BlockIndex) {
  const block = session.blocks[blockIndex];
  return { condition: block.plan.condition, round: block.plan.round, turnIndex: block.messages.filter((m) => m.speaker === 'human').length };
}

/** Drives PartnerPort calls from the state machine; the UI never calls the partner directly. */
export function usePartner(session: SessionState | null, dispatch: (a: Action) => void, partner: PartnerPort) {
  const [error, setError] = useState<string | null>(null);
  const awaiting = session?.awaitingPartner ?? false;
  const latest = useRef(session);
  latest.current = session;

  // Conversational replies.
  useEffect(() => {
    const s = latest.current;
    if (!s || !awaiting || s.phase !== 'chat') return;
    const blockIndex = s.blockIndex;
    const controller = new AbortController();
    const started = performance.now();
    setError(null);
    partner
      .respond({ history: s.blocks[blockIndex].messages, visibleStimuli: partnerVisibleStimuli(s, blockIndex), policyContext: policyContext(s, blockIndex) }, controller.signal)
      .then((reply) => dispatch({ type: 'PARTNER_REPLY', id: randomId('p'), text: reply.text, diagnostics: reply.diagnostics, waitMs: Math.round(performance.now() - started) }))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        dispatch({ type: 'PARTNER_FAILED', error: message, waitMs: Math.round(performance.now() - started) });
      });
    return () => controller.abort();
  }, [awaiting, session?.phase, session?.blockIndex, partner, dispatch]);

  // Recover the retry banner after reload (RESTORED converts an in-flight request into a failure).
  useEffect(() => {
    const last = session?.events[session.events.length - 1];
    if (session?.phase === 'chat' && !session.awaitingPartner && last?.type === 'partner_request_failed') setError(String(last.payload.error ?? 'error'));
  }, [session]);

  // Independent final submission, started once the participant ends a block's conversation.
  const pendingKey = session ? pendingPartnerNames(session).join(',') : '';
  useEffect(() => {
    if (!pendingKey) return;
    const controller = new AbortController();
    const run = (blockIndex: BlockIndex, attempt: number) => {
      const cur = latest.current!;
      partner
        .submitNames({ history: cur.blocks[blockIndex].messages, visibleStimuli: partnerVisibleStimuli(cur, blockIndex), policyContext: policyContext(cur, blockIndex) }, controller.signal)
        .then((r) => dispatch({ type: 'PARTNER_NAMES', blockIndex, names: r.names, diagnostics: r.diagnostics }))
        .catch(() => {
          if (controller.signal.aborted || attempt >= 3) return;
          setTimeout(() => !controller.signal.aborted && run(blockIndex, attempt + 1), 800);
        });
    };
    pendingKey.split(',').forEach((i) => run(Number(i) as BlockIndex, 0));
    return () => controller.abort();
  }, [pendingKey, partner, dispatch]);

  return { error, clearError: () => setError(null) };
}

const CONVERSATION_OVER: SessionState['phase'][] = ['naming', 'survey', 'interblock', 'comparison', 'results', 'done'];

export function pendingPartnerNames(s: SessionState): BlockIndex[] {
  return ([0, 1] as BlockIndex[]).filter(
    (i) => s.blocks[i].partnerNames === null && (i < s.blockIndex || (i === s.blockIndex && CONVERSATION_OVER.includes(s.phase))),
  );
}
