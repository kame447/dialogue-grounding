import { test, expect } from '@playwright/test';
import { startRoundOne, endChat, submitNames } from './helpers';

test('chat advances only through end confirmation; names and surveys validate; locked names cannot be edited', async ({ page }) => {
  await startRoundOne(page);
  await expect(page.getByRole('textbox', { name: '図形1の名前' })).toHaveCount(0);
  await page.getByRole('button', { name: '会話を終えて名前の入力へ' }).click(); await page.getByRole('button', { name: '終了して名前入力へ' }).click();
  await page.getByRole('button', { name: '名前を確定する' }).click(); await expect(page.getByRole('alert')).toBeVisible();
  const vals = ['ねこ',' ねこ ','A','B','C','D'];
  for (let i=1;i<=6;i++) await page.getByRole('textbox', { name: `図形${i}の名前` }).fill(vals[i-1]);
  await page.getByRole('button', { name: '名前を確定する' }).click(); await expect(page.getByRole('alert')).toBeVisible();
  for (let i=1;i<=6;i++) await page.getByRole('textbox', { name: `図形${i}の名前` }).fill(`名前${i}`);
  await page.getByRole('button', { name: '名前を確定する' }).click(); await page.getByRole('button', { name: '確定する', exact: true }).click();
  await page.goBack(); await expect(page.getByRole('status')).toContainText('前の画面に戻ることはできません');
  await expect(page.getByRole('textbox', { name: '図形1の名前' })).toHaveCount(0);
  await page.getByRole('button', { name: '回答を送信', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: /ラウンド 1 \/ 2 についての質問/ })).toBeVisible();
});

test('confirmation helper locks valid names', async ({ page }) => { await startRoundOne(page); await endChat(page); await submitNames(page,'固有'); await expect(page.getByRole('heading', { name: /についての質問/ })).toBeVisible(); });
