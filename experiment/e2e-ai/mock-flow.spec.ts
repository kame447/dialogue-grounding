import { test, expect } from '@playwright/test';
import { aiMessages, confirmNames, endChat, expectNoFigureNumbers, fillNames, INTRO, nameFigure, names, scene, sendHuman, startMock, submitSurvey } from './helpers';

test.describe('human + mock AI flow', () => {
  test('intro, free chat, naming on the scene, survey, unscored results and deletion', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.getByRole('heading', { name: INTRO })).toBeVisible();
    await expect(page.getByText('実際のAIモデルには接続していません')).toBeVisible();
    await expect(page.getByRole('link', { name: '研究者向け: 外部AIの接続' })).toHaveAttribute('href', '#/researcher');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await startMock(page);
    const free = ['右上の鳥っぽいのは鳥にしよう', '真ん中あたりで斜めになってる細長いのは？', 'じゃあそれは舟で', '左下の大きいのは山', '残りは星と月にします', 'これで6つかな'];
    for (const [i, text] of free.entries()) {
      await sendHuman(page, text);
      await expect(aiMessages(page)).toHaveCount(i + 2);
    }
    for (const text of await aiMessages(page).allInnerTexts()) expect(text).not.toMatch(/図形\s*[0-9０-９]|番号|記録しました/);
    await expectNoFigureNumbers(page);
    await endChat(page);
    // Conversation stays visible next to the scene while naming.
    await expect(page.getByRole('log', { name: '会話の記録' })).toContainText('右上の鳥っぽいのは鳥にしよう');
    await page.getByRole('button', { name: '名前を確定する' }).click();
    await expect(page.getByRole('alert')).toContainText('未入力');
    await nameFigure(page, 0, '山');
    const dup = await nameFigure(page, 1, '山');
    await expect(dup).toContainText('ほかの図形と同じ名前です');
    await dup.getByRole('button', { name: 'キャンセル' }).click();
    await fillNames(page);
    await expect(scene(page)).toContainText('舟');
    await expectNoFigureNumbers(page);
    await page.getByRole('button', { name: '名前を確定する' }).click();
    const confirm = page.getByRole('dialog', { name: 'この名前で確定しますか？' });
    for (const name of names) await expect(confirm).toContainText(name);
    await expectNoFigureNumbers(page);
    await confirm.getByRole('button', { name: '確定する' }).click();
    await page.getByRole('button', { name: '回答を送信' }).click();
    await expect(page.getByRole('alert')).toContainText('未回答の項目があります');
    await submitSurvey(page);
    await expect(page.getByRole('heading', { name: '結果' })).toBeVisible();
    await expect(page.getByText('模擬AIは図形を見ていないため、一致は判定しません')).toBeVisible();
    await expect(page.getByText(/一致 \d/)).toHaveCount(0);
    await expect(page.getByText('模擬AI未判定')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'あなたがつけた名前' })).toContainText('鳥');
    await expectNoFigureNumbers(page);
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
