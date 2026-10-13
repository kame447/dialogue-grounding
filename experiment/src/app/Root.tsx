import { lazy, Suspense, useEffect, useState } from 'react';
import { parseRoomHash } from '../ai/protocol';
import { Intro } from './Intro';
import { Researcher } from './Researcher';
import { Room } from './Room';
import './tokens.css';
import './app.css';

// The earlier browser-only mock flow is kept for reference under #/legacy and loads its own styles.
const LegacyApp = lazy(() => import('../App').then((m) => ({ default: m.App })));

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = (event: HashChangeEvent) => {
      // Legacy styles are global; leave the legacy flow with a fresh page so they do not leak.
      if (new URL(event.oldURL).hash.startsWith('#/legacy') && !window.location.hash.startsWith('#/legacy')) window.location.reload();
      else setHash(window.location.hash);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function Root() {
  const hash = useHash();
  useEffect(() => { window.scrollTo?.(0, 0); }, [hash]);
  if (hash.startsWith('#/legacy')) {
    return <Suspense fallback={null}><div className="legacy-root"><LegacyApp /></div></Suspense>;
  }
  if (hash.startsWith('#/researcher')) return <Researcher />;
  const room = parseRoomHash(hash);
  if (room) return <Room key={`${room.roomId}/${room.token}`} roomId={room.roomId} token={room.token} />;
  return <Intro />;
}
