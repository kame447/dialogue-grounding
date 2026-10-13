import { test, expect } from '@playwright/test';
import { startMock } from './helpers';

const forbidden = /alpha-|beta-|setId|seed|agentToken|tokenHash/;

test('participant DOM and received websocket frames do not reveal private fields', async ({ page }) => {
  const frames: string[] = [];
  page.on('websocket', socket => socket.on('framereceived', event => frames.push(String(event.payload))));
  await page.goto('/#/');
  expect(await page.locator('body').innerText()).not.toMatch(/AIトークン|agentToken/);
  expect(await page.content()).not.toMatch(forbidden);
  await startMock(page);
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  const joined = frames.join('\n');
  expect(joined).not.toMatch(forbidden);
  expect(joined).not.toMatch(/aiName|"results"\s*:\s*\{/);
  expect(await page.content()).not.toMatch(forbidden);
});
