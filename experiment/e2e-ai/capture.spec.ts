import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { confirmNames, endChat, fillNames, names, showTab, submitSurvey } from './helpers';

/** Deterministic screenshots of every participant state for visual inspection (screenshots/{local,deployed}/<project>/, gitignored). */
async function shot(page: Page, project: string, name: string) {
  const dir = `screenshots/${process.env.AI_BASE_URL ? "deployed" : "local"}/${project}`;
  await mkdir(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${dir}/${name}.png` });
  await page.screenshot({ path: `${dir}/${name}-full.png`, fullPage: true });
}

test('capture participant and researcher states @narrow', async ({ page }, info) => {
  const project = info.project.name;
  await page.goto('/#/');
  await shot(page, project, '01-intro');
  await page.getByRole('button', { name: 'デモを始める' }).click();
  await expect(page.getByRole('region', { name: 'あなたの図形' })).toBeVisible();
  await page.waitForTimeout(1500);
  await shot(page, project, '02-figures');
  await showTab(page, '会話');
  await expect(page.getByText('（模擬AI）').first()).toBeVisible();
  await shot(page, project, '03-chat-start');
  const log = page.getByRole('log', { name: '会話' });
  for (let i = 1; i <= 4; i++) {
    await page.getByRole('textbox', { name: 'メッセージ' }).fill(i === 2 ? '図形2は細長くて、左に傾いた人みたいに見えます。図形2は踊り子' : `図形${i}は${names[i - 1]}`);
    await page.getByRole('button', { name: '送信', exact: true }).click();
    await expect(log.getByText('（模擬AI）')).toHaveCount(i + 1);
  }
  await page.getByRole('textbox', { name: 'メッセージ' }).fill('残りは図形5と6ですね');
  await shot(page, project, '04-chat-active');
  await page.getByRole('textbox', { name: 'メッセージ' }).fill('');
  await showTab(page, '図形');
  await page.getByRole('button', { name: '図形1を拡大' }).click();
  await shot(page, project, '05-zoom');
  await page.getByRole('button', { name: '閉じる' }).click();
  await showTab(page, '会話');
  await page.getByRole('button', { name: '会話を終えて名前を決める' }).click();
  await shot(page, project, '06-end-confirm');
  await page.getByRole('dialog', { name: '会話を終えますか？' }).getByRole('button', { name: '名前の入力へ進む' }).click();
  await expect(page.getByRole('textbox', { name: '図形1の名前' })).toBeVisible();
  await shot(page, project, '07-naming');
  await fillNames(page, ['山', '踊り子', '星', '山', '', '']);
  await page.getByRole('button', { name: '名前を確認する' }).click();
  await shot(page, project, '08-naming-errors');
  await fillNames(page, names);
  await page.getByRole('button', { name: '名前を確認する' }).click();
  await shot(page, project, '09-naming-confirm');
  await page.getByRole('dialog', { name: 'この名前で確定しますか？' }).getByRole('button', { name: '修正する' }).click();
  await confirmNames(page);
  await expect(page.getByRole('radiogroup', { name: /精神的努力/ })).toBeVisible();
  await shot(page, project, '10-survey');
  await page.getByRole('button', { name: '回答を送信' }).click();
  await shot(page, project, '11-survey-missing');
  await submitSurvey(page);
  await expect(page.getByRole('heading', { name: '結果' })).toBeVisible();
  await shot(page, project, '12-results');
  await page.goto('/#/researcher');
  await page.getByRole('button', { name: '外部AI用ルームを作成' }).click();
  const participant = await page.getByRole('textbox', { name: '参加者用URL' }).inputValue();
  await shot(page, project, '13-researcher');
  const waiting = await page.context().newPage();
  await waiting.goto(participant);
  await expect(waiting.getByText('AI接続待機中')).toBeVisible();
  await shot(waiting, project, '14-waiting-ai');
});
