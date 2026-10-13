import { test, expect } from '@playwright/test';
import { showTab, startMock } from './helpers';


test('screens fit their viewport and controls remain usable @narrow', async ({ page }, testInfo) => {
  await page.goto('/#/');
  const checkOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await checkOverflow();
  await page.getByRole('button', { name: 'デモを始める' }).click();
  await expect(page.getByRole('region', { name: 'あなたの図形' })).toBeVisible();
  await checkOverflow();
  const figures = page.getByRole('region', { name: 'あなたの図形' }).getByRole('button', { name: /図形\dを拡大/ });
  await expect(figures).toHaveCount(6);
  if (testInfo.project.name === 'narrow') return;
  const minimum = testInfo.project.name === 'desktop' ? 140 : 96;
  for (let i = 0; i < 6; i++) {
    const svg = figures.nth(i).locator('svg');
    const box = await svg.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(minimum);
    expect(box?.height).toBeGreaterThanOrEqual(minimum);
  }
  if (testInfo.project.name === 'desktop') {
    for (let i = 0; i < 6; i++) {
      const box = await figures.nth(i).boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
      expect(box?.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(900);
    }
    const composer = await page.getByRole('textbox', { name: 'メッセージ' }).boundingBox();
    expect(composer?.y).toBeGreaterThanOrEqual(0); expect(composer!.y + composer!.height).toBeLessThanOrEqual(900);
  } else {
    const tabs = page.getByRole('tablist', { name: '表示切替' });
    await expect(tabs.getByRole('tab', { name: '図形' })).toBeVisible();
    // The AI opening arrives while the figures tab is shown.
    await expect(tabs.getByText(/未読 1/)).toBeVisible();
    for (const tab of await tabs.getByRole('tab').all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    for (let i = 0; i < 6; i++) expect((await figures.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await tabs.getByRole('tab', { name: /^会話/ }).click();
    await expect(tabs.getByText(/未読/)).toHaveCount(0);
    const composer = await page.getByRole('textbox', { name: 'メッセージ' }).boundingBox();
    expect(composer).not.toBeNull();
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(844);
    const send = await page.getByRole('button', { name: '送信', exact: true }).boundingBox();
    expect(send!.height).toBeGreaterThanOrEqual(44);
    expect((await page.getByRole('button', { name: '会話を終えて名前を決める' }).boundingBox())!.height).toBeGreaterThanOrEqual(36);
  }
});

test('zoom dialog opens and closes with Escape', async ({ page }) => {
  await startMock(page);
  await showTab(page, '図形');
  await page.getByRole('button', { name: '図形1を拡大' }).click();
  await expect(page.getByRole('dialog', { name: '図形1' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '図形1' })).toHaveCount(0);
});
