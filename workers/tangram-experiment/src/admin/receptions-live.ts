// Self-hosted script for /admin/receptions (served as /admin/receptions.js after admin authentication).
// It polls the authenticated version endpoint, refetches the same page when the version changes (and
// periodically, since the version comes from the best-effort index), and updates the list without touching
// a row that holds focus or typed input. Receptions that existed when the page was rendered are never new.
// Nothing is stored in the browser; requests carry only the browser's own admin credentials.
export const VISIBLE_POLL_MS = 15000;
export const HIDDEN_POLL_MS = 60000;
export const MAX_BACKOFF_MS = 120000;
/** Bounds for a 429's Retry-After, so a missing or odd value still gives a finite, polite wait. */
export const MIN_RETRY_AFTER_S = 60;
export const MAX_RETRY_AFTER_S = 600;
/** The version comes from the best-effort index, so a visible page is refetched at least this often anyway. */
export const FORCED_REFRESH_MS = 120000;
/** Network timeout for each request; a fallback timer covers browsers without AbortSignal.timeout. */
export const REQUEST_TIMEOUT_MS = 10000;

export const RECEPTIONS_LIVE_JS = `(function () {
  'use strict';
  var root = document.getElementById('reception-list');
  var notice = document.getElementById('reception-new');
  var sync = document.getElementById('reception-sync');
  if (!root || !notice || !sync || typeof fetch !== 'function' || typeof DOMParser !== 'function') return;
  var VISIBLE = ${VISIBLE_POLL_MS}, HIDDEN = ${HIDDEN_POLL_MS}, MAX = ${MAX_BACKOFF_MS}, FORCED = ${FORCED_REFRESH_MS};
  var HEX = /^[a-f0-9]{64}$/;
  var baseTitle = document.title;
  var sinceText = root.getAttribute('data-since') || '';
  // Only receptions created at or after this page was rendered can be new, so rows that slide in from another page
  // never are. (A reception indexed only after the render, but created before it, is listed but not announced.)
  var since = Date.parse(sinceText);
  // A later page cannot show new receptions (they sort first), so it shows the server's count of them instead.
  var laterPage = /(^|[?&])after=/.test(location.search.slice(1));
  var known = new Set(), latest = new Map();
  // Empty when the server could not read it; the first good version then differs and the page is fetched again.
  var version = root.getAttribute('data-version') || '';
  var stale = false, force = false, stopped = false, busy = false, failures = 0, timer = null, blockedUntil = 0, shown = -1;
  var serverNew = 0, refreshedAt = Date.now();

  function rows(scope) { return Array.prototype.slice.call(scope.querySelectorAll('tr[data-id]')); }
  function remember(scope) {
    latest = new Map();
    rows(scope).forEach(function (row) {
      latest.set(row.getAttribute('data-id'), { status: row.getAttribute('data-status'), created: Date.parse(row.getAttribute('data-created') || '') });
    });
  }
  rows(root).forEach(function (row) { known.add(row.getAttribute('data-id')); });
  remember(root);

  function holdsFocus(node) {
    var active = document.activeElement;
    return Boolean(active && active !== document.body && node.contains(active));
  }
  // Typed or chosen but not sent: the row keeps its inputs together with the hidden values they were shown with.
  function protectedRow(row) {
    if (holdsFocus(row)) return true;
    return Array.prototype.slice.call(row.querySelectorAll('input[name="confirm"], select')).some(function (field) { return field.value !== ''; });
  }
  function isNew(id) {
    var entry = latest.get(id);
    return Boolean(entry) && entry.status === 'pending' && !known.has(id) && entry.created >= since;
  }

  function mark() {
    var count = 0;
    if (laterPage) count = serverNew;
    else latest.forEach(function (entry, id) { if (isNew(id)) count++; });
    rows(root).forEach(function (row) { row.classList.toggle('new', !laterPage && isNew(row.getAttribute('data-id'))); });
    if (count !== shown) { notice.textContent = count ? '新しい受付 ' + count + '件' : ''; shown = count; }
    document.title = count ? '(' + count + ') ' + baseTitle : baseTitle;
  }

  // Returns false when a protected row had to be kept as it was; the page is then fetched again next time.
  function apply(next) {
    var oldBody = root.querySelector('tbody'), newBody = next.querySelector('tbody');
    if (!oldBody || !newBody) {
      if (rows(root).some(protectedRow)) return false;
      while (root.firstChild) root.removeChild(root.firstChild);
      Array.prototype.slice.call(next.childNodes).forEach(function (node) { root.appendChild(document.adoptNode(node)); });
      return true;
    }
    var active = document.activeElement, start = null, end = null;
    try { start = active.selectionStart; end = active.selectionEnd; } catch (e) { start = null; }
    var oldWrap = oldBody.closest('[data-part="table"]'), newWrap = newBody.closest('[data-part="table"]');
    var held = new Set(), complete = true;
    Array.prototype.slice.call(root.children).forEach(function (child) {
      if (child === oldWrap) return;
      if (holdsFocus(child)) { held.add(child.getAttribute('data-part')); complete = false; } else root.removeChild(child);
    });
    var after = false;
    Array.prototype.slice.call(next.children).forEach(function (child) {
      if (child === newWrap) { after = true; return; }
      if (held.has(child.getAttribute('data-part'))) return;
      var node = document.adoptNode(child);
      if (after) root.appendChild(node); else root.insertBefore(node, oldWrap);
    });
    var current = new Map(), wanted = [];
    rows(root).forEach(function (row) { current.set(row.getAttribute('data-id'), row); });
    rows(next).forEach(function (row) {
      var id = row.getAttribute('data-id'), old = current.get(id);
      current.delete(id);
      if (old && old.getAttribute('data-key') === row.getAttribute('data-key')) wanted.push(old);
      else if (old && protectedRow(old)) { wanted.push(old); complete = false; }
      else wanted.push(document.adoptNode(row));
    });
    current.forEach(function (row) { if (protectedRow(row)) { wanted.push(row); complete = false; } });
    wanted.forEach(function (row, i) {
      var at = oldBody.children[i];
      if (at !== row) oldBody.insertBefore(row, at || null);
    });
    while (oldBody.children.length > wanted.length) oldBody.removeChild(oldBody.lastElementChild);
    if (active && active !== document.activeElement && root.contains(active) && typeof active.focus === 'function') {
      active.focus({ preventScroll: true });
      if (start !== null && typeof active.setSelectionRange === 'function') { try { active.setSelectionRange(start, end); } catch (e) { /* not a text field */ } }
    }
    return complete;
  }

  // Resolves with the whole body (parsed JSON or text). The timer covers headers and body alike, so a response
  // that stalls at any point frees the single check slot, with or without an abortable fetch.
  function request(url, type) {
    var options = { headers: { Accept: type }, credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
    var controller = typeof AbortController === 'function' ? new AbortController() : null, timeout = null;
    if (controller) options.signal = controller.signal;
    var expired = new Promise(function (resolve, reject) {
      timeout = setTimeout(function () { if (controller) controller.abort(); reject(new Error('timeout')); }, ${REQUEST_TIMEOUT_MS});
    });
    var whole = fetch(url, options).then(function (response) {
      var kind = (response.headers.get('Content-Type') || '').split(';')[0].trim();
      if (response.ok && kind === type) return type === 'application/json' ? response.json() : response.text();
      var error = new Error('http');
      error.status = response.ok ? 0 : response.status;
      error.retryAfter = Number(response.headers.get('Retry-After'));
      throw error;
    });
    return Promise.race([whole, expired]).then(function (body) { clearTimeout(timeout); return body; },
      function (error) { clearTimeout(timeout); throw error; });
  }

  function refresh() {
    return request(location.pathname + location.search, 'text/html').then(function (html) {
      var next = new DOMParser().parseFromString(html, 'text/html').getElementById('reception-list');
      var nextVersion = next && next.getAttribute('data-version');
      if (!next || !HEX.test(nextVersion || '')) throw new Error('page');
      if (stopped) return;
      remember(next);
      stale = !apply(next);
      version = nextVersion;
      root.setAttribute('data-version', version);
      refreshedAt = Date.now();
      force = false;
    });
  }
  function check() {
    var url = '/admin/receptions/version' + (laterPage ? '?since=' + encodeURIComponent(sinceText) : '');
    return request(url, 'application/json').then(function (data) {
      if (!data || !HEX.test(typeof data.version === 'string' ? data.version : '')) throw new Error('version');
      if (laterPage) serverNew = typeof data.newPending === 'number' && data.newPending >= 0 ? data.newPending : 0;
      var due = document.visibilityState !== 'hidden' && Date.now() - refreshedAt >= FORCED;
      if (data.version !== version || stale || force || due) return refresh();
    });
  }

  function interval() { return document.visibilityState === 'hidden' ? HIDDEN : VISIBLE; }
  function schedule(ms) {
    if (timer !== null) clearTimeout(timer);
    timer = stopped ? null : setTimeout(tick, Math.max(0, ms));
  }
  function tick() {
    timer = null;
    if (stopped || busy || navigator.onLine === false) return;
    busy = true;
    check().then(function () {
      // A cycle counts as successful only once the page it needed was also applied.
      failures = 0; blockedUntil = 0; sync.textContent = '';
      mark();
      return interval();
    }, function (error) {
      var status = error && error.status;
      if (status === 401 || status === 403 || status === 404) {
        stopped = true; sync.textContent = '自動更新を止めました。ページを開き直してください。';
        return 0;
      }
      sync.textContent = '更新できませんでした。しばらくして再試行します。';
      if (status === 429) {
        var wait = error.retryAfter > 0 ? error.retryAfter : 0;
        return Math.min(${MAX_RETRY_AFTER_S}, Math.max(${MIN_RETRY_AFTER_S}, wait)) * 1000;
      }
      failures++;
      return Math.max(interval(), Math.min(MAX, VISIBLE * Math.pow(2, failures - 1)));
    }).then(function (delay) {
      busy = false;
      blockedUntil = sync.textContent ? Date.now() + delay : 0;
      schedule(delay);
    });
  }
  // Events only bring the next check forward; they never skip a backoff or a Retry-After wait.
  function soon() { if (!stopped && !busy) schedule(blockedUntil - Date.now()); }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { force = true; soon(); }
  });
  window.addEventListener('online', soon);
  window.addEventListener('offline', function () { if (timer !== null) { clearTimeout(timer); timer = null; } });
  mark();
  schedule(interval());
})();
`;
