import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { aiMessages, clickFigure, confirmNames, endChat, figureButtons, fillNames, nameFigure, names, scene, submitSurvey } from './helpers';

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
  await expect(scene(page)).toBeVisible();
  await expect(aiMessages(page).first()).toBeVisible();
  await shot(page, project, '02-workspace-start');
  const turns = ['右上のほうにある、鳥が羽を広げたみたいなのを鳥にしませんか', '左下の、斜めに傾いた細長いのは何に見えますか？', 'それは舟にしましょう', '真ん中の大きいのは山っぽい'];
  for (const [i, text] of turns.entries()) {
    await page.getByRole('textbox', { name: 'メッセージ' }).fill(text);
    await page.getByRole('button', { name: '送信', exact: true }).click();
    await expect(aiMessages(page)).toHaveCount(i + 2);
  }
  await page.getByRole('textbox', { name: 'メッセージ' }).fill('残りの2つは星と月で');
  await shot(page, project, '03-workspace-active');
  await page.getByRole('textbox', { name: 'メッセージ' }).fill('');
  await clickFigure(figureButtons(page).first());
  await shot(page, project, '04-zoom');
  await page.getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: '会話を終えて名前を決める' }).click();
  await shot(page, project, '05-end-confirm');
  await page.getByRole('dialog', { name: '会話を終えますか？' }).getByRole('button', { name: '名前の入力へ進む' }).click();
  await expect(page.getByRole('heading', { name: '名前をつける' })).toBeVisible();
  await shot(page, project, '06-naming');
  await nameFigure(page, 0, '山');
  await nameFigure(page, 2, '鳥');
  const dialog = await nameFigure(page, 1, '山');
  await shot(page, project, '07-naming-dialog-duplicate');
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await page.getByRole('button', { name: '名前を確定する' }).click();
  await shot(page, project, '08-naming-partial');
  await fillNames(page, names);
  await page.getByRole('button', { name: '名前を確定する' }).click();
  await shot(page, project, '09-naming-confirm');
  await page.getByRole('dialog', { name: 'この名前で確定しますか？' }).getByRole('button', { name: '修正する' }).click();
  await confirmNames(page);
  await expect(page.getByRole('radiogroup', { name: /精神的努力/ })).toBeVisible();
  await shot(page, project, '10-survey');
  await submitSurvey(page);
  await expect(page.getByRole('heading', { name: '結果' })).toBeVisible();
  await shot(page, project, '11-results');
  await page.goto('/#/researcher');
  await page.getByRole('button', { name: '外部AI用ルームを作成' }).click();
  const participant = await page.getByRole('textbox', { name: '参加者用URL' }).inputValue();
  await shot(page, project, '12-researcher');
  const waiting = await page.context().newPage();
  await waiting.goto(participant);
  await expect(waiting.getByText('AI接続待機中')).toBeVisible();
  await shot(waiting, project, '13-waiting-ai');
});
