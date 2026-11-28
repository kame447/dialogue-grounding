import assert from "node:assert/strict";

export function manualRecoveryTimers() {
  let pending: { callback: () => void; delayMs: number } | undefined;
  return {
    timers: {
      set(callback: () => void, delayMs: number) {
        assert.equal(pending, undefined, "at most one recovery timer");
        pending = { callback, delayMs };
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear() { pending = undefined; },
    },
    runNext(delayMs = 2000) {
      assert.ok(pending, "recovery must already be scheduled");
      assert.equal(pending.delayMs, delayMs);
      const { callback } = pending;
      pending = undefined;
      callback();
    },
  };
}
