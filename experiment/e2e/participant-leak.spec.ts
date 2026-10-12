import { test, expect } from '@playwright/test';
import { startRoundOne, sendMessage, endChat, submitNames, submitBlockSurvey } from './helpers';

const forbidden = [/alpha-/i,/beta-/i,/条件A|条件B/,'condition',/\bS[1-4]\b/,'DEMO自作','相手側配置'];
async function assertNoLeak(page: any) {
  const text = await page.locator('body').innerText(); const html = await page.content();
  for (const f of forbidden) { expect(text).not.toMatch(f as any); expect(html).not.toMatch(f as any); }
  for (const m of await page.getByRole('log', { name: '会話' }).locator('.msg-partner').allInnerTexts().catch(() => [])) expect(m).not.toMatch(/図形\s*[1-6]/);
}

test('participant screens do not expose researcher-only details', async ({ page }) => {
  await page.goto('/?mockLatency=50'); await assertNoLeak(page);
  await page.getByRole('button', { name: 'デモをはじめる' }).click(); await assertNoLeak(page);
  await page.getByLabel('上記を読み、デモとして進めることに同意します').check(); await page.getByRole('button', { name: '同意して進む' }).click(); await assertNoLeak(page);
  await page.getByRole('button', { name: 'ラウンド1を始める' }).click(); await assertNoLeak(page);
  await sendMessage(page, '図形の話です'); await assertNoLeak(page);
  await endChat(page); await assertNoLeak(page);
  await submitNames(page, '名'); await assertNoLeak(page);
  await submitBlockSurvey(page); await assertNoLeak(page);
  await page.getByRole('button', { name: 'ラウンド2を始める' }).click(); await assertNoLeak(page);
});
