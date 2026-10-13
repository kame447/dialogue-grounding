import { useCallback, useEffect, useMemo, useState } from 'react';
import { sequenceForIndex } from './domain/assignment';
import { randomId, randomSeed } from './domain/ids';
import { createSession, reduce, type Action } from './domain/session';
import { clearSession, loadSession, saveSession } from './domain/storage';
import type { SessionState } from './domain/types';
import { MockPartner } from './partner/MockPartner';
import type { PartnerPort } from './partner/PartnerPort';
import { ChatScreen } from './participant/ChatScreen';
import { ConsentScreen, DoneScreen, InstructionsScreen, InterblockScreen, WelcomeScreen } from './participant/IntroScreens';
import { NamingScreen } from './participant/NamingScreen';
import { ResultsScreen } from './participant/ResultsScreen';
import { Shell } from './participant/Shell';
import { BlockSurveyScreen, ComparisonScreen } from './participant/SurveyScreens';
import { usePartner } from './participant/usePartner';
import { LiveLobby } from './live/LiveLobby';
import { LiveRoom } from './live/LiveRoom';
import { parseInviteHash } from './live/protocol';
import { ResearcherDemo } from './researcher/ResearcherDemo';
import { getStimulus } from './stimuli/sets';

const COUNTER_KEY = 'dg-experiment-demo-counter';

/** Local round-robin over S1..S4 for the demo. Production must assign sequences on the server. */
function nextSequence() {
  let n = 0;
  try {
    n = Number(localStorage.getItem(COUNTER_KEY) ?? '0') || 0;
    localStorage.setItem(COUNTER_KEY, String(n + 1));
  } catch {
    n = Math.floor(Math.random() * 4);
  }
  return sequenceForIndex(n);
}

/** Demo-only switches: ?mockLatency=ms, ?mockFailNext=n (error/retry check). */
function createPartner(): PartnerPort {
  const params = new URLSearchParams(window.location.search);
  const latency = Number(params.get('mockLatency') ?? '900');
  return new MockPartner({ seed: randomSeed(), latencyMs: Number.isFinite(latency) ? latency : 900, failNextCalls: Number(params.get('mockFailNext') ?? '0') || 0 });
}

type Route = 'participant' | 'researcher' | 'live';

function readRoute(): Route {
  const hash = window.location.hash;
  if (hash.startsWith('#/researcher')) return 'researcher';
  if (hash === '#/live' || hash.startsWith('#/live/')) return 'live';
  return 'participant';
}

function useRoute() {
  const [route, setRoute] = useState<{ name: Route; hash: string }>(() => ({ name: readRoute(), hash: window.location.hash }));
  useEffect(() => {
    const on = () => setRoute({ name: readRoute(), hash: window.location.hash });
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function App() {
  const { name: route, hash } = useRoute();
  const [session, setSession] = useState<SessionState | null>(() => {
    const loaded = loadSession();
    return loaded ? reduce(loaded, { type: 'RESTORED' }) : null;
  });
  const [notice, setNotice] = useState<string | null>(null);
  const partner = useMemo(createPartner, []);

  useEffect(() => {
    if (session) saveSession(session);
    else clearSession();
  }, [session]);

  const dispatch = useCallback((action: Action) => setSession((s) => (s ? reduce(s, action) : s)), []);
  const { error: partnerError, clearError } = usePartner(session, dispatch, partner);

  // Browser back must not rewind the experiment: the screen is derived from the
  // session phase only, so we re-push the entry and explain instead.
  useEffect(() => {
    if (route !== 'participant') return;
    window.history.pushState({ guard: true }, '', window.location.href);
    const onPop = () => {
      if (readRoute() !== 'participant') return;
      window.history.pushState({ guard: true }, '', window.location.href);
      setNotice('このデモでは前の画面に戻ることはできません。現在の画面から続けてください。');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [route]);

  useEffect(() => {
    setNotice(null);
    window.scrollTo?.(0, 0);
  }, [session?.phase, session?.blockIndex]);

  if (route === 'researcher') {
    return <ResearcherDemo session={session} onReplace={setSession} />;
  }
  if (route === 'live') {
    // Human-pair live DEMO: state lives in the room server, independent of the mock-partner session.
    const invite = parseInviteHash(hash);
    return invite ? <LiveRoom key={`${invite.roomId}/${invite.token}`} roomId={invite.roomId} token={invite.token} /> : <LiveLobby />;
  }

  const start = () => {
    if (session) return dispatch({ type: 'ADVANCE_FROM_WELCOME' });
    const fresh = createSession({ sessionId: randomId('demo'), sequenceId: nextSequence(), seed: randomSeed() });
    setSession(reduce(fresh, { type: 'ADVANCE_FROM_WELCOME' }));
  };

  let body;
  if (!session || session.phase === 'welcome') {
    body = <WelcomeScreen onStart={start} resumable={false} />;
  } else {
    const block = session.blocks[session.blockIndex];
    const round = block.plan.round;
    const stimuli = block.layout.human.map(getStimulus);
    switch (session.phase) {
      case 'consent':
        body = <ConsentScreen onAgree={() => dispatch({ type: 'ACK_CONSENT' })} />;
        break;
      case 'instructions':
        body = <InstructionsScreen onBegin={() => dispatch({ type: 'BEGIN_BLOCK' })} />;
        break;
      case 'chat':
        body = (
          <ChatScreen
            key={`chat-${session.blockIndex}`}
            round={round}
            block={block}
            stimuli={stimuli}
            awaitingPartner={session.awaitingPartner}
            partnerError={partnerError}
            onSend={(id, text) => dispatch({ type: 'SEND_MESSAGE', id, text })}
            onComposing={(active) => dispatch({ type: 'COMPOSING', active })}
            onRetry={() => {
              clearError();
              dispatch({ type: 'RETRY_PARTNER' });
            }}
            onMemo={(slot, text) => dispatch({ type: 'SET_MEMO', slot, text })}
            onEnd={() => dispatch({ type: 'END_NAMING' })}
          />
        );
        break;
      case 'naming':
        body = <NamingScreen key={`naming-${session.blockIndex}`} round={round} stimuli={stimuli} initialNames={block.memos} onLock={(namesBySlot) => dispatch({ type: 'LOCK_NAMES', namesBySlot })} />;
        break;
      case 'survey':
        body = <BlockSurveyScreen key={`survey-${session.blockIndex}`} round={round} onSubmit={(survey) => dispatch({ type: 'SUBMIT_SURVEY', survey })} />;
        break;
      case 'interblock':
        body = <InterblockScreen onBegin={() => dispatch({ type: 'BEGIN_BLOCK' })} />;
        break;
      case 'comparison':
        body = <ComparisonScreen onSubmit={(comparison) => dispatch({ type: 'SUBMIT_COMPARISON', comparison })} />;
        break;
      case 'results':
        body = <ResultsScreen session={session} onFinish={() => dispatch({ type: 'FINISH' })} />;
        break;
      case 'done':
        body = <DoneScreen onRestart={() => setSession(null)} />;
        break;
    }
  }

  return (
    <Shell session={session} notice={notice}>
      {body}
    </Shell>
  );
}
