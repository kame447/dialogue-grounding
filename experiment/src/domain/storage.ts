import type { SessionState } from './types';

/**
 * DEMO persistence: sessionStorage only (per-tab, cleared when the tab closes).
 * Nothing is sent anywhere. Production needs server-side storage with access control.
 */
export const STORAGE_KEY = 'dg-experiment-demo-session-v1';

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function loadSession(): SessionState | null {
  const raw = store()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return parseSession(raw);
  } catch {
    return null;
  }
}

export function saveSession(state: SessionState): void {
  try {
    store()?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota or privacy mode: the demo keeps working in memory */
  }
}

export function clearSession(): void {
  store()?.removeItem(STORAGE_KEY);
}

export function exportSession(state: SessionState): string {
  return JSON.stringify({ format: 'dg-experiment-demo', demo: true, exportedAt: new Date().toISOString(), session: state }, null, 2);
}

/** Accepts either an export envelope or a bare session; throws Error with a readable message when invalid. */
export function importSession(json: string): SessionState {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('JSONとして読み込めません。');
  }
  const candidate = data && typeof data === 'object' && 'session' in data ? (data as { session: unknown }).session : data;
  return parseSession(JSON.stringify(candidate));
}

function parseSession(raw: string): SessionState {
  const s = JSON.parse(raw) as SessionState;
  if (!s || s.version !== 1 || typeof s.sessionId !== 'string' || !Array.isArray(s.blocks) || s.blocks.length !== 2 || !Array.isArray(s.events) || typeof s.phase !== 'string') {
    throw new Error('このプロトタイプのセッション形式ではありません。');
  }
  return s;
}
