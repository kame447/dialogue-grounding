export type LocalDrainableServer = { drainAndClose(): Promise<void> };

/** Only the direct CLI opts into process signals. Duplicate signals share one deadline. */
export function attachLocalShutdown(server: LocalDrainableServer, options: { timeoutMs?: number } = {}): () => void {
  const timeout = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error('invalid_shutdown_options');
  let stopping = false, finished = false, timer: ReturnType<typeof setTimeout> | undefined;
  const detach = () => {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (timer !== undefined) clearTimeout(timer);
  };
  const finish = (code: number) => {
    if (finished) return;
    finished = true; detach();
    if (code !== 0) process.stderr.write('shutdown_incomplete\n');
    process.exit(code);
  };
  function stop() {
    if (stopping || finished) return;
    stopping = true;
    timer = setTimeout(() => finish(1), timeout);
    try { server.drainAndClose().then(() => finish(0), () => finish(1)); }
    catch { finish(1); }
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return detach;
}
