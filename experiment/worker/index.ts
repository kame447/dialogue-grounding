import { LIVE_LIMITS, isRoomId, type CreateRoomResponse, type LiveRole } from '../src/live/protocol';
import { sha256Hex, randomHex } from './tokens';
export { LiveRoom } from './room';

interface Env { ROOMS: DurableObjectNamespace; ASSETS: { fetch(request: Request): Promise<Response> } }
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } });
const createTimes = new Map<string, number[]>();
function sameHost(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true });
  if (url.pathname === '/api/rooms' && request.method === 'POST') {
    if (!sameHost(request)) return json({ error: 'forbidden' }, 403);
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const now = Date.now();
    const recent = (createTimes.get(ip) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= LIVE_LIMITS.createPerMinute) return json({ error: 'rate_limited' }, 429);
    createTimes.set(ip, [...recent, now]);
    const roomId = randomHex(16);
    const tokens: Record<LiveRole, string> = { p1: randomHex(24), p2: randomHex(24) };
    const tokenHashes = { p1: await sha256Hex(tokens.p1), p2: await sha256Hex(tokens.p2) };
    const expiresAt = now + LIVE_LIMITS.roomTtlMs;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    const init = await stub.fetch('https://room/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId, tokenHashes, setId: Math.random() < 0.5 ? 'alpha' : 'beta', seed: crypto.getRandomValues(new Uint32Array(1))[0], now }) });
    if (!init.ok) return json({ error: 'room_init_failed' }, 500);
    return json({ roomId, expiresAt, tokens } satisfies CreateRoomResponse, 201);
  }
  const match = /^\/api\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
  if (match && request.method === 'GET') {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
    if (!isRoomId(match[1])) return json({ error: 'not_found' }, 404);
    if (!sameHost(request)) return json({ error: 'forbidden' }, 403);
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  }
  return json({ error: 'not_found' }, 404);
} };
