import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { base, showTab } from './helpers';

let child: ChildProcess | undefined;
/** The participant's separate device uses the same viewport/touch settings as the current project. */
const deviceOptions = () => {
  const { viewport, isMobile, hasTouch, deviceScaleFactor, userAgent } = test.info().project.use;
  return { viewport, isMobile, hasTouch, deviceScaleFactor, userAgent };
};
test.afterEach(() => { child?.kill('SIGTERM'); child = undefined; });

test('researcher provisions external room and stub agent completes the flow', async ({ page, browser }) => {
  await page.goto('/#/researcher');
  await page.getByRole('button', { name: '外部AI用ルームを作成' }).click();
  const participantUrl = await page.getByRole('textbox', { name: '参加者用URL' }).inputValue();
  const roomId = await page.getByRole('textbox', { name: 'ルームID' }).inputValue();
  const aiToken = await page.getByRole('textbox', { name: 'AIトークン' }).inputValue();
  expect(participantUrl).toContain('#/r/'); expect(roomId).toMatch(/^[0-9a-f]{32}$/); expect(aiToken).toMatch(/^[0-9a-f]{48}$/);
  await expect(page.getByLabel('スタブ起動コマンド')).toContainText('stub-agent.mjs');
  await expect(page.getByLabel('スタブ起動コマンド')).toContainText(`DG_AGENT_TOKEN=${aiToken}`);
  const context = await browser.newContext(deviceOptions());
  try {
    const human = await context.newPage();
    await human.goto(participantUrl);
    await expect(human.getByText('AI接続待機中')).toBeVisible();
    child = spawn(process.execPath, ['agent/stub-agent.mjs', '--base', base, '--room', roomId, '--once'], { cwd: process.cwd(), env: { ...process.env, DG_AGENT_TOKEN: aiToken }, stdio: 'ignore' });
    await expect(human.getByRole('region', { name: 'あなたの図形' })).toBeVisible({ timeout: 30_000 });
    await showTab(human, '会話');
    await expect(human.getByRole('log', { name: '会話' })).toBeVisible();
    await human.getByRole('textbox', { name: 'メッセージ' }).fill('図形について相談したいです');
    await human.getByRole('button', { name: '送信', exact: true }).click();
    await expect(human.getByRole('log', { name: '会話' })).toContainText('外部エージェント・スタブ', { timeout: 30_000 });
    await human.getByRole('button', { name: '会話を終えて名前を決める' }).click();
    await human.getByRole('dialog', { name: '会話を終えますか？' }).getByRole('button', { name: '名前の入力へ進む' }).click();
    for (let i = 1; i <= 6; i++) await human.getByRole('textbox', { name: `図形${i}の名前` }).fill(`人間${i}`);
    await human.getByRole('button', { name: '名前を確認する' }).click();
    await human.getByRole('dialog').getByRole('button', { name: '確定する' }).click();
    for (const scale of ['精神的努力', '円滑さ', '煩わしさ']) await human.getByRole('radiogroup', { name: new RegExp(scale) }).getByRole('radio', { name: '1', exact: true }).check();
    await human.getByRole('button', { name: '回答を送信' }).click();
    await expect(human.getByRole('heading', { name: '結果' })).toBeVisible();
    await expect(human.getByRole('table', { name: '名前の対応' })).toContainText('スタブ名1');
  } finally { await context.close(); }
});

test('mock fallback works and each websocket endpoint rejects the opposite seat token', async ({ page, browser }) => {
  await page.goto('/#/researcher');
  await page.getByRole('button', { name: '外部AI用ルームを作成' }).click();
  const participantUrl = await page.getByRole('textbox', { name: '参加者用URL' }).inputValue();
  const roomId = await page.getByRole('textbox', { name: 'ルームID' }).inputValue();
  const agentToken = await page.getByRole('textbox', { name: 'AIトークン' }).inputValue();
  const humanToken = participantUrl.match(/#\/r\/[0-9a-f]{32}\/([0-9a-f]{48})/)?.[1];
  expect(humanToken).toBeTruthy();
  const context = await browser.newContext(deviceOptions());
  try {
    const human = await context.newPage(); await human.goto(participantUrl);
    await human.getByRole('button', { name: '模擬AIで始める' }).click();
    await expect(human.getByRole('region', { name: 'あなたの図形' })).toBeVisible();
    await showTab(human, '会話');
    await expect(human.getByText('（模擬AI）').first()).toBeVisible();
    const failures = await page.evaluate(async ({ roomId, humanToken, agentToken }) => {
      const attempt = (url: string, token: string) => new Promise<string>(resolve => {
        const ws = new WebSocket(url); let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; ws.close(); resolve('timeout'); } }, 5000);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocol: 2, token }));
        ws.onmessage = e => { const data = JSON.parse(String(e.data)); if (data.type === 'error') { settled = true; clearTimeout(timer); ws.close(); resolve(data.code); } };
        ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); resolve('socket_error'); } };
      });
      const wsBase = location.origin.replace(/^http/, 'ws');
      return Promise.all([attempt(`${wsBase}/api/rooms/${roomId}/ws`, agentToken), attempt(`${wsBase}/api/agent/rooms/${roomId}/ws`, humanToken)]);
    }, { roomId, humanToken, agentToken });
    expect(failures).toEqual(['bad_token', 'bad_token']);
  } finally { await context.close(); }
});
