// #159 admin layout: structure the CSS relies on, without changing fields, values or wording.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_CSS, renderEntry, renderList, renderReceptions, renderSettings } from '../workers/tangram-experiment/src/admin/render.ts';
import type { SettingsView } from '../workers/tangram-experiment/src/admin/reception-port.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const unsaved: SettingsView = { protocol: null, mode: { value: 'unset', revision: 0 }, protocolHistory: [], modeHistory: [] };
const filter = { status: 'any', error: 'any', memory: 'any' } as const;

test('every admin page has the same navigation with the current page marked', () => {
  const pages: [string, string][] = [
    ['/admin/receptions', renderReceptions([], null, { configured: false, mode: 'unset' })], ['/admin/entry', renderEntry('https://example.test/')],
    ['/admin/reception-settings', renderSettings(unsaved)], ['/admin', renderList([], { ...filter }, null, [], undefined, false, true)]];
  for (const [path, html] of pages) {
    const nav = html.match(/<nav>([\s\S]*?)<\/nav>/)?.[1]; assert.ok(nav, path);
    assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map(m => m[1]), ['/admin/receptions', '/admin/entry', '/admin/reception-settings', '/admin']);
    assert.deepEqual([...nav.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map(m => m[1]), [path]);
  }
  assert.doesNotMatch(renderList([], { ...filter }, null, []), /<nav>/, 'without receptions the log has no navigation, as before');
});

test('reception rows label each cell with its column heading for the narrow layout', () => {
  const html = renderReceptions([{ receptionId: ID, number: '001', createdAt: '2026-10-29T00:00:00.000Z', status: 'pending', revision: 1, plan: null, trials: [] }], null,
    { configured: false, mode: 'on' });
  const headings = [...(html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? '').matchAll(/<th>([^<]*)<\/th>/g)].map(m => m[1]);
  const labels = [...(html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '').matchAll(/<td data-label="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(labels, headings); assert.equal(headings.length, 8);
});

test('settings: every input sits inside its label and fieldset, the two history tables are named', () => {
  const html = renderSettings(unsaved);
  const form = html.match(/<form method="post" action="\/admin\/reception-settings\/protocol">([\s\S]*?)<\/form>/)?.[1]; assert.ok(form);
  for (const input of form.matchAll(/<input type="(radio|checkbox)"[^>]*>/g)) {
    const before = form.slice(0, input.index); assert.ok(before.lastIndexOf('<label>') > before.lastIndexOf('</label>'), input[0]);
  }
  assert.equal((form.match(/<fieldset>/g) ?? []).length, 6); assert.equal((form.match(/<legend>/g) ?? []).length, 6);
  assert.match(html, /<h2>履歴<\/h2><div class="history"><h3>プロトコル<\/h3>[\s\S]*<h3>受付モード<\/h3>/);
});

test('the stylesheet is self-contained and has a narrow layout', () => {
  assert.doesNotMatch(ADMIN_CSS, /@import|url\(|https?:/);
  assert.match(ADMIN_CSS, /@media \(max-width:699px\)/); assert.match(ADMIN_CSS, /:focus-visible/);
  assert.match(ADMIN_CSS, /#reception-new:empty/);
});
