import {
  LIMITS,
  isRoomId,
  type CreateRoomResponse,
  type RoomMode,
} from "../src/ai/protocol";
import { createLimit } from "./limits";
import { randomHex, sha256Hex } from "./tokens";
export { TangramRoom } from "./room";
interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Local E2E only: raises the per-IP creation limit, honoured only on localhost (never on workers.dev). */
  DEV_CREATE_PER_MINUTE?: string;
}
const baseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: {
      ...baseHeaders,
      "content-type": "application/json; charset=utf-8",
    },
  });
const createTimes = new Map<string, number[]>();
const sameHost = (r: Request) => {
  const o = r.headers.get("Origin");
  if (!o) return true;
  try {
    return new URL(o).host === new URL(r.url).host;
  } catch {
    return false;
  }
};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/health" && request.method === "GET")
      return json({ ok: true });
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      if (!sameHost(request)) return json({ error: "forbidden" }, 403);
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown",
        now = Date.now(),
        recent = (createTimes.get(ip) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= createLimit(env, url))
        return json({ error: "rate_limited" }, 429);
      let body: { mode?: RoomMode };
      try {
        body = (await request.json()) as { mode?: RoomMode };
      } catch {
        return json({ error: "bad_request" }, 400);
      }
      if (body.mode !== "mock" && body.mode !== "external")
        return json({ error: "bad_request" }, 400);
      createTimes.set(ip, [...recent, now]);
      const mode = body.mode,
        roomId = randomHex(16),
        humanToken = randomHex(24),
        agentToken = mode === "external" ? randomHex(24) : undefined,
        tokenHashes = {
          human: await sha256Hex(humanToken),
          agent: agentToken ? await sha256Hex(agentToken) : null,
        },
        expiresAt = now + LIMITS.roomTtlMs;
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId)),
        init = await stub.fetch("https://room/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            roomId,
            tokenHashes,
            mode,
            setId: Math.random() < 0.5 ? "alpha" : "beta",
            seed: crypto.getRandomValues(new Uint32Array(1))[0],
            now,
          }),
        });
      if (!init.ok) return json({ error: "room_init_failed" }, 500);
      const response: CreateRoomResponse = {
        roomId,
        mode,
        expiresAt,
        humanToken,
        ...(agentToken ? { agentToken } : {}),
      };
      return json(response, 201);
    }
    const human = /^\/api\/rooms\/([^/]+)\/ws$/.exec(url.pathname),
      agent = /^\/api\/agent\/rooms\/([^/]+)\/ws$/.exec(url.pathname),
      match = human ?? agent;
    if (match && request.method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return json({ error: "websocket_required" }, 426);
      if (!isRoomId(match[1])) return json({ error: "not_found" }, 404);
      if (human && !sameHost(request)) return json({ error: "forbidden" }, 403);
      if (agent && !sameHost(request) && request.headers.has("Origin"))
        return json({ error: "forbidden" }, 403);
      const headers = new Headers(request.headers);
      headers.set("x-tangram-seat", human ? "human" : "ai");
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(
        new Request(request, { headers }),
      );
    }
    return json({ error: "not_found" }, 404);
  },
};
