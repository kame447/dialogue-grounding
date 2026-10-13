import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { aiMessages, ANSWER_HEADING, clickFigure, confirmNames, figureButtons, markNotAgreed, nameFigure, scene, submitSurvey } from './helpers';

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
  await page.getByRole('button', { name: '会話を終了する' }).click();
  await shot(page, project, '05-end-confirm');
  await page.getByRole('dialog', { name: '話し合いを終了しますか？' }).getByRole('button', { name: '終了して回答へ' }).click();
  await expect(page.getByRole('heading', { name: ANSWER_HEADING })).toBeVisible();
  await shot(page, project, '06-answer');
  await nameFigure(page, 0, '山');
  await nameFigure(page, 2, '鳥');
  const dialog = await nameFigure(page, 1, '山');
  await shot(page, project, '07-answer-dialog-duplicate');
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await page.getByRole('button', { name: '回答を提出する' }).click();
  await shot(page, project, '08-answer-partial');
  await nameFigure(page, 1, '舟');
  await nameFigure(page, 3, '星');
  await markNotAgreed(page, 4);
  await markNotAgreed(page, 5);
  await page.getByRole('button', { name: '回答を提出する' }).click();
  await shot(page, project, '09-answer-confirm');
  await page.getByRole('dialog', { name: '回答を提出しますか？' }).getByRole('button', { name: '修正する' }).click();
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
