/** Small bounded CDP transport; no dependency on Playwright or a shared browser profile. */
export async function channel(url: string, timeoutMs = 30000) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('cdp_connect_timeout')); }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp_connect_failed')); }, {once: true});
  });
  let seq = 0;
  const pending = new Map<number, {resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)), p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id); clearTimeout(p.timer);
    message.error ? p.reject(new Error('cdp_command_failed')) : p.resolve(message.result);
  });
  ws.addEventListener('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('cdp_closed')); } pending.clear(); });
  return {close: () => ws.close(), call: (method: string, params: Record<string, unknown> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp_command_timeout')); }, timeoutMs);
      pending.set(id, {resolve, reject, timer}); ws.send(JSON.stringify({id, method, params}));
    })};
}
