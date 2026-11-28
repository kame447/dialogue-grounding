// Authenticated, read-only polling of the same admin HTML page. Never calls a model or a participant API.
export const LOG_DETAIL_POLL_MS = 10000;
export const LOG_LIST_POLL_MS = 15000;
export const LOG_HIDDEN_POLL_MS = 60000;
export const LOG_REQUEST_TIMEOUT_MS = 12000;

export const LOG_LIVE_JS = `(function () {
  'use strict';
  var root = document.getElementById('admin-log-live');
  var status = document.getElementById('admin-log-sync');
  if (!root || !status || typeof fetch !== 'function' || typeof DOMParser !== 'function') return;
  var interval = root.getAttribute('data-view') === 'detail' ? ${LOG_DETAIL_POLL_MS} : ${LOG_LIST_POLL_MS};
  var path = location.pathname + location.search;
  var markup = root.innerHTML, busy = false, stopped = false, suspended = false, failures = 0, timer = null, blockedUntil = 0;
  function schedule() {
    if (stopped || suspended) return;
    clearTimeout(timer);
    timer = setTimeout(poll, Math.max(document.visibilityState === 'hidden' ? ${LOG_HIDDEN_POLL_MS} : interval,
      blockedUntil - Date.now(), failures ? Math.min(120000, interval * Math.pow(2, failures)) : 0));
  }
  function editing() {
    var active = document.activeElement;
    if (active && root.contains(active) && active.matches('input, select, textarea')) return true;
    if (Array.from(root.querySelectorAll('input[name="confirm"], textarea')).some(function (field) { return field.value !== ''; })) return true;
    if (Array.from(root.querySelectorAll('select')).some(function (field) {
      var initial = Array.from(field.options).findIndex(function (option) { return option.defaultSelected; });
      return field.selectedIndex !== Math.max(0, initial);
    })) return true;
    if (typeof CSS !== 'undefined' && CSS.supports('selector(:popover-open)') && root.querySelector(':popover-open')) return true;
    var selection = window.getSelection && window.getSelection();
    return Boolean(selection && !selection.isCollapsed && root.contains(selection.anchorNode));
  }
  function detailsKey(element, index) {
    var summary = element.querySelector('summary');
    var row = element.closest('tr'), popover = element.closest('[popover]');
    var recordLink = row && row.querySelector('a[href^="/admin/record/"]');
    return (element.id || (popover && popover.id) || (row && row.id) || (recordLink && recordLink.getAttribute('href')) || '') +
      '|' + (summary ? summary.textContent.replace(/（[^）]*件[^）]*）/g, '').trim() : index);
  }
  function update(next) {
    if (next.innerHTML === markup) return;
    var open = new Set(Array.from(root.querySelectorAll('details')).map(function (el, i) { return el.open ? detailsKey(el, i) : null; }).filter(Boolean));
    var sheet = root.querySelector('.turn-sheet');
    var x = window.scrollX, y = window.scrollY, left = sheet ? sheet.scrollLeft : 0, top = sheet ? sheet.scrollTop : 0;
    var follow = sheet && sheet.scrollHeight > sheet.clientHeight && sheet.scrollHeight - sheet.clientHeight - top < 24;
    markup = next.innerHTML;
    while (root.firstChild) root.removeChild(root.firstChild);
    while (next.firstChild) root.appendChild(document.adoptNode(next.firstChild));
    Array.from(root.querySelectorAll('details')).forEach(function (el, i) { if (open.has(detailsKey(el, i))) el.open = true; });
    sheet = root.querySelector('.turn-sheet');
    if (sheet) { sheet.scrollLeft = left; sheet.scrollTop = follow ? sheet.scrollHeight : top; }
    window.scrollTo(x, y);
  }
  async function poll() {
    if (stopped || suspended || busy) return;
    if (document.visibilityState === 'hidden' || editing() || Date.now() < blockedUntil) { schedule(); return; }
    busy = true;
    var controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); }, ${LOG_REQUEST_TIMEOUT_MS});
    try {
      var response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        stopped = true;
        if (response.status === 404) root.textContent = '';
        status.textContent = response.status === 404 ? '記録がありません。' : '認証が必要です。ページを開き直してください。';
        return;
      }
      if (response.status === 429) {
        var retry = Number(response.headers.get('Retry-After'));
        blockedUntil = Date.now() + Math.max(60, Math.min(600, Number.isFinite(retry) ? retry : 60)) * 1000;
        status.textContent = '更新を一時停止中';
        return;
      }
      if (!response.ok) throw new Error('refresh');
      var next = new DOMParser().parseFromString(await response.text(), 'text/html').getElementById('admin-log-live');
      if (!next || next.getAttribute('data-view') !== root.getAttribute('data-view')) throw new Error('refresh');
      // A user may have started entering a confirmation while the GET was pending.
      if (!editing()) update(next);
      failures = 0; status.textContent = '自動更新中';
    } catch (_) {
      failures++;
      status.textContent = '更新できませんでした。再試行します。';
    } finally {
      clearTimeout(timeout);
      busy = false;
      schedule();
    }
  }
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('pagehide', function () { suspended = true; clearTimeout(timer); });
  window.addEventListener('pageshow', function () { suspended = false; schedule(); });
  status.textContent = '自動更新中';
  schedule();
})();`;
