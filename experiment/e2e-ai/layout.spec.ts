import { test, expect, type Page } from '@playwright/test';
import { clickFigure, endChat, expectNoFigureNumbers, figureButtons, scene, startMock } from './helpers';

const centres = (page: Page) => figureButtons(page).evaluateAll((els) => els.map((el) => {
  const r = el.querySelector('circle')!.getBoundingClientRect();
  return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
}));

test('figures and conversation share one screen; figures are scattered, unnumbered and stable @narrow', async ({ page }, testInfo) => {
  const viewport = page.viewportSize()!;
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.goto('/#/');
  await noOverflow();
  await startMock(page);
  await noOverflow();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(figureButtons(page)).toHaveCount(6);
  // Scene, every figure, the thread and the composer are all inside the viewport at once.
  const inView = async (box: { x: number; y: number; width: number; height: number } | null) => {
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1); expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1); expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  };
  await inView(await scene(page).boundingBox());
  for (let i = 0; i < 6; i++) await inView(await figureButtons(page).nth(i).locator('.fig-shape').boundingBox());
  await inView(await page.getByRole('textbox', { name: 'メッセージ' }).boundingBox());
  await inView(await page.getByRole('button', { name: '送信', exact: true }).boundingBox());
  await inView(await page.getByRole('button', { name: '会話を終了する' }).boundingBox());
  const log = await page.getByRole('log', { name: '会話' }).boundingBox();
  expect(log!.height).toBeGreaterThan(testInfo.project.name === 'narrow' ? 120 : 200);
  // Legible silhouettes (longer side of the drawn shape).
  const minimum = testInfo.project.name === 'desktop' ? 110 : testInfo.project.name === 'mobile' ? 48 : 40;
  for (let i = 0; i < 6; i++) {
    const box = (await figureButtons(page).nth(i).locator('.fig-shape').boundingBox())!;
    expect(Math.max(box.width, box.height)).toBeGreaterThanOrEqual(minimum);
  }
  // Irregular: not all on one row or one column, and not two neat rows of three.
  const pts = await centres(page);
  const rows = new Set(pts.map(([, y]) => Math.round(y / 12)));
  const cols = new Set(pts.map(([x]) => Math.round(x / 12)));
  expect(rows.size).toBeGreaterThan(2);
  expect(cols.size).toBeGreaterThan(2);
  await expectNoFigureNumbers(page);
  // Same placement after reload (fixed by the room seed on the server).
  await page.reload();
  await expect(figureButtons(page)).toHaveCount(6);
  expect(await centres(page)).toEqual(pts);
  if (testInfo.project.name !== 'desktop') {
    for (const b of [await page.getByRole('button', { name: '送信', exact: true }).boundingBox()]) expect(b!.height).toBeGreaterThanOrEqual(44);
  }
});

test('zoom is local, keeps the orientation and closes with Escape', async ({ page }) => {
  const sent: string[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (e) => sent.push(String(e.payload))));
  await startMock(page);
  const before = sent.length;
  await clickFigure(figureButtons(page).first());
  const dialog = page.getByRole('dialog', { name: '拡大表示' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('img', { name: '拡大した図形' })).toBeVisible();
  await expectNoFigureNumbers(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // Keyboard access: focus a figure and open it with Enter.
  await figureButtons(page).nth(2).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  // Picking a figure never reaches the server (only pings may be sent meanwhile).
  expect(sent.slice(before).filter((f) => !f.includes('"ping"'))).toEqual([]);
});

test('naming keeps the same scattered scene as the conversation', async ({ page }) => {
  await startMock(page);
  const pts = await centres(page);
  await endChat(page);
  expect(await centres(page)).toEqual(pts);
  await expectNoFigureNumbers(page);
});
