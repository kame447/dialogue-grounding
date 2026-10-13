import { test, expect } from '@playwright/test';
import { completeRun } from './helpers';

test('researcher demo exposes records, import/export and reset guard', async ({ page }) => {
  await page.goto('/#/legacy/researcher');
  await expect(page.getByText(/実験本番には使用禁止/)).toBeVisible();
  for (const id of ['S1','S2','S3','S4']) await expect(page.getByRole('row').filter({ hasText: id }).first()).toBeVisible();
  await page.getByLabel('新規セッションの系列').selectOption('S3'); await page.getByRole('button',{name:'この系列で新規デモセッション'}).click();
  await expect(page.getByRole('row').filter({hasText:'S3（現在）'})).toBeVisible();
  await page.goto('/?mockLatency=50#/legacy'); await completeRun(page);
  await page.goto('/#/legacy/researcher');
  await expect(page.getByRole('heading',{name:'進捗イベント'})).toBeVisible(); await expect(page.getByRole('heading',{name:'提出記録'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'評価プレビュー'})).toBeVisible();
  await expect(page.getByLabel('エクスポートJSON')).toHaveValue(/"sessionId"/);
  await page.getByLabel('インポートJSON').fill('{invalid'); await page.getByRole('button',{name:'貼り付けたJSONを読み込む'}).click(); await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button',{name:'セッションを消去'}).click(); await expect(page.getByText('このセッションを消去しますか？')).toBeVisible();
  await page.getByRole('button',{name:'本当に消去する'}).click(); await expect(page.getByText('セッションがありません')).toBeVisible();
});
