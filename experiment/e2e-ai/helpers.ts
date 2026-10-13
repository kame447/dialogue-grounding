import { expect, type Page } from '@playwright/test';

export const base = process.env.AI_BASE_URL || 'http://127.0.0.1:8795';
export const names = ['山', '川', '星', '舟', '鳥', '月'];

/** On narrow screens figures and chat are tabs; switch when the tab bar is shown. */
export async function showTab(page: Page, name: '図形' | '会話') {
  const tab = page.getByRole('tablist', { name: '表示切替' }).getByRole('tab', { name: new RegExp(`^${name}`) });
  if (await tab.isVisible()) await tab.click();
}

export async function startMock(page: Page) {
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: '図形の命名対話' })).toBeVisible();
  await page.getByRole('button', { name: 'デモを始める' }).click();
  await expect(page.getByRole('region', { name: 'あなたの図形' })).toBeVisible();
  await showTab(page, '会話');
  await expect(page.getByRole('log', { name: '会話' })).toBeVisible();
  await expect(page.getByText('（模擬AI）').first()).toBeVisible();
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
}

export async function fillNames(page: Page, values = names) {
  for (let i = 0; i < 6; i++) await page.getByRole('textbox', { name: `図形${i + 1}の名前` }).fill(values[i]);
}

export async function confirmNames(page: Page) {
  await page.getByRole('button', { name: '名前を確認する' }).click();
  await page.getByRole('dialog', { name: 'この名前で確定しますか？' }).getByRole('button', { name: '確定する' }).click();
}

export async function submitSurvey(page: Page) {
  for (const [label, count] of [['精神的努力', 9], ['円滑さ', 7], ['煩わしさ', 7]] as const) {
    const group = page.getByRole('radiogroup', { name: new RegExp(label) });
    await group.getByRole('radio', { name: '1', exact: true }).check();
  }
  await page.getByRole('button', { name: '回答を送信' }).click();
}

export async function completeMockToResults(page: Page) {
  await startMock(page);
  for (let i = 1; i <= 6; i++) {
    await sendHuman(page, `図形${i}は${names[i - 1]}`);
    await expect(page.getByRole('log', { name: '会話' })).toContainText('（模擬AI）');
  }
  await endChat(page);
  await fillNames(page, Array(6).fill('山'));
  await expect(page.getByText('未入力')).toHaveCount(0);
  await expect(page.getByText('同じ名前があります').first()).toBeVisible();
  await fillNames(page);
  await confirmNames(page);
  await submitSurvey(page);
  await expect(page.getByRole('heading', { name: '結果' })).toBeVisible();
}
