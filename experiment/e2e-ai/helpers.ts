import { expect, type Locator, type Page } from '@playwright/test';

export const base = process.env.AI_BASE_URL || 'http://127.0.0.1:8795';
export const names = ['山', '川', '星', '舟', '鳥', '月'];
export const INTRO = '6つの図形の名前を、AIと決めてください';
/** Any visible figure number / ordinal ("図形1", "図形２", "図形N"). */
export const NUMBERED = /図形\s*[0-9０-９NＮ]|[0-9０-９]番目の図形|左から[0-9０-９]/;

export const scene = (page: Page) => page.getByRole('region', { name: 'あなたの図形' });
export const figureButtons = (page: Page) => scene(page).getByRole('button');
/** Click a figure at its centre hit area (kept clear of the other silhouettes by the generator). */
export const clickFigure = (figure: Locator) => figure.locator('circle').click();
export const aiMessages = (page: Page) => page.getByRole('log', { name: '会話' }).locator('.msg-ai .bubble');

export async function startMock(page: Page) {
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: INTRO })).toBeVisible();
  await page.getByRole('button', { name: 'デモを始める' }).click();
  await expect(scene(page)).toBeVisible();
  await expect(page.getByRole('log', { name: '会話' })).toBeVisible();
  await expect(aiMessages(page).first()).toBeVisible();
}

export async function sendHuman(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'メッセージ' });
  await box.fill(text);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.getByRole('log', { name: '会話' })).toContainText(text);
}

export async function endChat(page: Page) {
  await page.getByRole('button', { name: '会話を終えて名前を決める' }).click();
  await page.getByRole('dialog', { name: '会話を終えますか？' }).getByRole('button', { name: '名前の入力へ進む' }).click();
  await expect(page.getByRole('heading', { name: '名前をつける' })).toBeVisible();
}

/** Opens the naming dialog of the i-th figure (DOM order only; nothing on screen is numbered). */
export async function nameFigure(page: Page, i: number, value: string) {
  await clickFigure(figureButtons(page).nth(i));
  const dialog = page.getByRole('dialog', { name: '名前をつける' });
  await dialog.getByRole('textbox', { name: '名前' }).fill(value);
  await dialog.getByRole('button', { name: '決定' }).click();
  return dialog;
}

export async function fillNames(page: Page, values = names) {
  for (let i = 0; i < 6; i++) {
    const dialog = await nameFigure(page, i, values[i]);
    await expect(dialog).toHaveCount(0);
  }
}

export async function confirmNames(page: Page) {
  await page.getByRole('button', { name: '名前を確定する' }).click();
  await page.getByRole('dialog', { name: 'この名前で確定しますか？' }).getByRole('button', { name: '確定する' }).click();
}

export async function submitSurvey(page: Page) {
  for (const label of ['精神的努力', '円滑さ', '煩わしさ']) {
    await page.getByRole('radiogroup', { name: new RegExp(label) }).getByRole('radio', { name: '1', exact: true }).check();
  }
  await page.getByRole('button', { name: '回答を送信' }).click();
}

/** Visible text plus accessibility/tooltip/placeholder attributes of the whole document. */
export async function participantText(page: Page) {
  return page.evaluate(() => {
    const attrs = [...document.querySelectorAll('*')].flatMap((el) => ['aria-label', 'title', 'placeholder', 'alt', 'aria-description'].map((a) => el.getAttribute(a) ?? ''));
    return `${document.body.innerText}\n${document.body.textContent}\n${attrs.join('\n')}`;
  });
}

export async function expectNoFigureNumbers(page: Page) {
  expect(await participantText(page)).not.toMatch(NUMBERED);
}
