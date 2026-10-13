import { test, expect } from '@playwright/test';
import { completeRun, storedSession } from './helpers';

test('full participant path, event record and screen captures', async ({ page }, testInfo) => {
  await page.goto('/?mockLatency=50#/legacy');
  await completeRun(page, true);
  await expect(page.getByRole('heading', { name: 'ご協力ありがとうございました' })).toBeVisible();
  const s = await storedSession(page);
  const types = s.events.map((e: any) => e.type);
  const required = ['session_started','consent_acknowledged','block_started','message_sent','message_received','naming_end_requested','names_locked','survey_submitted','block_started','comparison_submitted','results_viewed'];
  let at = -1; for (const type of required) { at = types.indexOf(type, at + 1); expect(at, `${type} event in order`).toBeGreaterThan(-1); }
  for (const e of s.events) { expect(Number.isNaN(Date.parse(e.at))).toBeFalsy(); expect(typeof e.mono).toBe('number'); }
  for (const e of s.events.filter((e: any) => e.type === 'survey_submitted')) {
    expect(e.payload.effort).toBeGreaterThanOrEqual(1); expect(e.payload.effort).toBeLessThanOrEqual(9);
    for (const k of ['fluency','annoyance']) { expect(e.payload[k]).toBeGreaterThanOrEqual(1); expect(e.payload[k]).toBeLessThanOrEqual(7); }
    expect(e.payload.naturalness).toBeNull(); expect(e.payload.satisfaction).toBeNull();
    expect(e.payload.missing).toContain('naturalness'); expect(e.payload.missing).toContain('satisfaction');
  }
  expect(s.blocks[0].plan.stimulusSet).not.toBe(s.blocks[1].plan.stimulusSet);
  expect(s.blocks[0].plan.condition).not.toBe(s.blocks[1].plan.condition);
  expect(types.indexOf('results_viewed')).toBeGreaterThan(types.indexOf('comparison_submitted'));
  expect(testInfo.project.name).toMatch(/desktop|mobile/);
});
