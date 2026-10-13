import { test, expect } from '@playwright/test';
import { startMock } from './helpers';

test('rapid send is idempotent and draft plus messages survive reload', async ({ page }) => {
  await startMock(page);
  const input = page.getByRole('textbox', { name: 'メッセージ' });
  await input.fill('一度だけ送る文');
  await Promise.all([
    page.getByRole('button', { name: '送信', exact: true }).click(),
    page.getByRole('button', { name: '送信', exact: true }).click().catch(() => undefined),
  ]);
  await expect(page.getByRole('log', { name: '会話' }).getByText('一度だけ送る文')).toHaveCount(1);
  await input.fill('下書き');
  const url = page.url();
  await page.reload();
  await expect(page.getByRole('log', { name: '会話' })).toContainText('一度だけ送る文');
  await expect(page.getByRole('textbox', { name: 'メッセージ' })).toHaveValue('下書き');
  expect(page.url()).toBe(url);
});

test('offline state announces reconnect and recovers', async ({ page, context }) => {
  await startMock(page);
  await context.setOffline(true);
  await expect(page.getByText(/再接続中/)).toBeVisible({ timeout: 10_000 });
  await context.setOffline(false);
  await expect(page.getByRole('log', { name: '会話' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/再接続中/)).toHaveCount(0, { timeout: 20_000 });
});
