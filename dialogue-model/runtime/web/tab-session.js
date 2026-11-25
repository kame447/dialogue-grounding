(function () {
  "use strict";

  const storageKey = "tangramTab";
  const ownerPrefix = "tangram-tab-owner:";
  const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
  const scope = globalThis;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  let binding = null;
  let resolving = null;
  let releaseOwner = null;
  let ownershipAttempt = 0;
  let suspended = false;
  let disposed = false;

  function uuid() {
    const crypto = scope.crypto;
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }

  function validSessionId(id) {
    return id === "legacy" || typeof id === "string" && uuidPattern.test(id);
  }

  function storedBinding() {
    try {
      const saved = JSON.parse(scope.sessionStorage.getItem(storageKey));
      if (typeof saved?.tabToken === "string" && uuidPattern.test(saved.tabToken) &&
          (saved.sessionId === null || validSessionId(saved.sessionId))) return saved;
    } catch { /* A blocked or invalid storage entry behaves like a fresh tab. */ }
    return null;
  }

  function save(next) {
    binding = next;
    try { scope.sessionStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { /* The current document can still use its in-memory binding. */ }
    try { scope.history.replaceState({ ...scope.history.state, tangramTab: next }, ""); }
    catch { /* Storage and live ownership still protect the binding. */ }
  }

  function holdWebLock(locks, name, attempt) {
    return new Promise((resolve, reject) => {
      locks.request(name, { ifAvailable: true }, lock => {
        if (!lock || attempt !== ownershipAttempt) { resolve(false); return; }
        const held = new Promise(release => { releaseOwner = release; });
        resolve(true);
        return held;
      }).catch(reject);
    });
  }

  async function holdBroadcastChannel(name, attempt) {
    if (typeof scope.BroadcastChannel !== "function") return true;
    let channel;
    try { channel = new scope.BroadcastChannel(name); }
    catch { return true; }
    const probe = uuid();
    let owned = false, collision = false;
    releaseOwner = () => channel.close();
    channel.onmessage = ({ data }) => {
      if (data?.type === "probe") {
        if (owned || probe < data.probe) channel.postMessage({ type: "owned", probe: data.probe });
        else if (data.probe < probe) collision = true;
      }
      if (data?.type === "owned" && data.probe === probe) collision = true;
    };
    channel.postMessage({ type: "probe", probe });
    await wait(40);
    if (attempt !== ownershipAttempt) return false;
    if (collision) { releaseOwnership(); return false; }
    owned = true;
    return true;
  }

  async function hold(tabToken) {
    if (suspended || disposed) return false;
    const name = ownerPrefix + tabToken;
    const attempt = ++ownershipAttempt;
    const locks = scope.navigator?.locks;
    if (typeof locks?.request === "function") {
      try { return await holdWebLock(locks, name, attempt); }
      catch { /* Use the second ownership mechanism if Web Locks is blocked. */ }
    }
    return attempt === ownershipAttempt && await holdBroadcastChannel(name, attempt);
  }

  function releaseOwnership() {
    ownershipAttempt++;
    releaseOwner?.();
    releaseOwner = null;
  }

  function result(kind, reason) {
    return { kind, reason, sessionId: binding.sessionId, tabToken: binding.tabToken };
  }

  async function fresh(reason) {
    const next = { sessionId: null, tabToken: uuid() };
    await hold(next.tabToken);
    if (!disposed) save(next);
    return { kind: "fresh", reason, ...next };
  }

  async function resolveBinding() {
    const stored = storedBinding();
    const navigation = scope.performance?.getEntriesByType?.("navigation")?.[0]?.type;
    if (!stored) return fresh(navigation === "reload" ? "storage_empty" : "new_tab");

    let historyAvailable = false, historyToken;
    try {
      historyAvailable = Boolean(scope.history && "state" in scope.history);
      historyToken = scope.history?.state?.tangramTab?.tabToken;
    } catch { historyAvailable = false; }
    if (navigation !== "reload" && historyToken !== stored.tabToken) {
      if (scope.opener) return fresh("window_open");
      if (historyAvailable) return fresh("duplicated_tab");
    }

    let acquired = await hold(stored.tabToken);
    if (!acquired && navigation === "reload" && !suspended && !disposed) {
      await wait(30);
      acquired = await hold(stored.tabToken);
    }
    if (!acquired && !suspended && !disposed) return fresh("duplicated_tab");
    if (!disposed) save(stored);
    return { kind: "restored", reason: "reload", ...stored };
  }

  function onLeave() {
    suspended = true;
    releaseOwnership();
  }

  function onShow(event) {
    if (!event.persisted || !suspended || disposed) return;
    suspended = false;
    if (!binding) return;
    const saved = binding;
    resolving = (async () => {
      const acquired = await hold(saved.tabToken);
      if (!acquired && !suspended && !disposed) return fresh("duplicated_tab");
      return result("restored", "reload");
    })();
  }

  scope.addEventListener?.("pagehide", onLeave);
  scope.addEventListener?.("beforeunload", onLeave);
  scope.addEventListener?.("pageshow", onShow);
  scope.TangramTabSession = {
    resolve() { return resolving ??= resolveBinding(); },
    bind(sessionId) {
      if (!validSessionId(sessionId)) throw new TypeError("invalid_tab_session_id");
      if (!binding || disposed) throw new Error("tab_session_not_resolved");
      save({ sessionId, tabToken: binding.tabToken });
    },
    clear() {
      if (binding && !disposed) save({ sessionId: null, tabToken: binding.tabToken });
    },
    current() { return binding?.sessionId ?? null; },
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseOwnership();
      scope.removeEventListener?.("pagehide", onLeave);
      scope.removeEventListener?.("beforeunload", onLeave);
      scope.removeEventListener?.("pageshow", onShow);
    },
  };
}());
