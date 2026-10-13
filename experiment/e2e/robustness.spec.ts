import { test, expect } from '@playwright/test';
import { startRoundOne, sendMessage, endChat, submitNames, storedSession } from './helpers';

test('reload preserves chat and survey phase; duplicate sends and locks are idempotent', async ({ page }) => {
  await startRoundOne(page); await sendMessage(page,'維持する発話'); await page.reload();
  await expect(page.getByRole('log', { name: '会話' })).toContainText('維持する発話');
  const input = page.getByRole('textbox', { name: 'メッセージ' }); await input.fill('二重送信テスト');
  await page.getByRole('button', { name: '送信', exact: true }).dblclick(); await expect(page.getByRole('log')).toContainText('二重送信テスト');
  await expect.poll(async () => (await storedSession(page)).events.filter((e: any) => e.type==='message_sent' && e.payload.text==='二重送信テスト').length).toBe(1);
  await endChat(page); for(let i=1;i<=6;i++) await page.getByRole('textbox',{name:`図形${i}の名前`}).fill(`X${i}`);
  await page.getByRole('button',{name:'名前を確定する'}).click(); await page.getByRole('button',{name:'確定する',exact:true}).dblclick();
  await expect.poll(async () => (await storedSession(page)).events.filter((e:any)=>e.type==='names_locked').length).toBe(1);
  await page.reload(); await expect(page.getByRole('heading',{name:/についての質問/})).toBeVisible();
});

test('Enter twice submits one message and retry recovers first failure', async ({ page }) => {
  await page.goto('/?mockLatency=50&mockFailNext=1#/legacy');
  await page.getByRole('button',{name:'デモをはじめる'}).click(); await page.getByLabel('上記を読み、デモとして進めることに同意します').check();
  await page.getByRole('button',{name:'同意して進む'}).click(); await page.getByRole('button',{name:'ラウンド1を始める'}).click();
  const input=page.getByRole('textbox',{name:'メッセージ'}); await input.fill('失敗して再送'); await input.press('Enter');
  await expect(page.getByRole('alert')).toBeVisible(); await page.getByRole('button',{name:'再送信'}).click();
  await expect(page.getByRole('log')).toContainText('相手');
  expect((await storedSession(page)).events.filter((e:any)=>e.type==='message_sent' && e.payload.text==='失敗して再送')).toHaveLength(1);
});
