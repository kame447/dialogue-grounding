import { test, expect } from '@playwright/test';
import { fillNames, names, showTab, startMock, submitSurvey, endChat, confirmNames } from './helpers';

test.describe('human + mock AI flow', () => {
  test('intro, six-turn chat, naming, survey, results and deletion', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.getByRole('heading', { name: '図形の命名対話' })).toBeVisible();
    await expect(page.getByText('6つの図形をAIと話し合い、区別できる名前をつけます')).toBeVisible();
    await expect(page.getByRole('link', { name: '研究者向け: 外部AIの接続' })).toHaveAttribute('href', '#/researcher');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await page.getByRole('button', { name: 'デモを始める' }).click();
    await expect(page.getByRole('region', { name: 'あなたの図形' })).toBeVisible();
    await showTab(page, '会話');
    await expect(page.getByRole('log', { name: '会話' })).toBeVisible();
    await expect(page.getByText('（模擬AI）').first()).toBeVisible();
    for (let i = 1; i <= 6; i++) {
      const box = page.getByRole('textbox', { name: 'メッセージ' });
      await box.fill(`図形${i}は${names[i - 1]}`);
      await page.getByRole('button', { name: '送信', exact: true }).click();
      await expect(page.getByRole('log', { name: '会話' })).toContainText(`図形${i}は${names[i - 1]}`);
      await expect(page.getByRole('log', { name: '会話' }).getByText('（模擬AI）')).toHaveCount(i + 1);
    }
    await expect(page.getByRole('log', { name: '会話' })).toContainText('6つの名前を記録しました');
    await page.getByRole('button', { name: '会話を終えて名前を決める' }).click();
    await page.getByRole('dialog', { name: '会話を終えますか？' }).getByRole('button', { name: '名前の入力へ進む' }).click();
    await expect(page.getByText('未入力').first()).toBeVisible();
    await fillNames(page, Array(6).fill('山'));
    await expect(page.getByText('同じ名前があります').first()).toBeVisible();
    await fillNames(page);
    await page.getByRole('button', { name: '名前を確認する' }).click();
    const confirm = page.getByRole('dialog', { name: 'この名前で確定しますか？' });
    for (const name of names) await expect(confirm).toContainText(name);
    await confirm.getByRole('button', { name: '確定する' }).click();
    await page.getByRole('button', { name: '回答を送信' }).click();
    await expect(page.getByRole('alert')).toContainText('未回答の項目があります');
    await submitSurvey(page);
    await expect(page.getByRole('table', { name: '名前の対応' }).getByRole('row')).toHaveCount(7);
    await expect(page.getByText('一致 6 / 6')).toBeVisible();
    await expect(page.getByText(/動作確認用/)).toBeVisible();
    const roomUrl = page.url();
    await page.getByRole('button', { name: 'このデモのデータを削除' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '削除する' }).click();
    await expect(page.getByRole('heading', { name: 'データを削除しました' })).toBeVisible();
    await page.goto('about:blank');
    await page.goto(roomUrl);
    await expect(page.getByRole('heading', { name: 'このリンクは無効です' })).toBeVisible();
  });
});

test('results and AI names stay hidden until survey submission', async ({ page }) => {
  await startMock(page);
  await endChat(page);
  await fillNames(page);
  await confirmNames(page);
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('一致');
});
