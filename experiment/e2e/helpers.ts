import { expect, type Page } from '@playwright/test';

export const sessionKey = 'dg-experiment-demo-session-v1';

export async function startRoundOne(page: Page) {
  await page.goto('/?mockLatency=50#/legacy');
  await page.getByRole('button', { name: 'デモをはじめる' }).click();
  await page.getByLabel('上記を読み、デモとして進めることに同意します').check();
  await page.getByRole('button', { name: '同意して進む' }).click();
  await page.getByRole('button', { name: 'ラウンド1を始める' }).click();
  await expect(page.getByRole('log', { name: '会話' })).toBeVisible();
}

export async function sendMessage(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'メッセージ' }).fill(text);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.getByRole('status', { name: '相手が入力しています' })).toHaveCount(0);
}

export async function endChat(page: Page) {
  await page.getByRole('button', { name: '会話を終えて名前の入力へ' }).click();
  await page.getByRole('button', { name: '終了して名前入力へ' }).click();
}

export async function submitNames(page: Page, prefix: string) {
  for (let i = 1; i <= 6; i++) await page.getByRole('textbox', { name: `図形${i}の名前` }).fill(`${prefix}${i}`);
  await page.getByRole('button', { name: '名前を確定する' }).click();
  await page.getByRole('button', { name: '確定する', exact: true }).click();
}

export async function submitBlockSurvey(page: Page, optional = false) {
  const groups = [/精神的な努力/, /対話の進めやすさ/, /煩わしさ/];
  if (optional) groups.push(/自然さ/, /満足度/);
  for (const name of groups) await page.getByRole('group', { name }).getByRole('radio').first().check();
  await page.getByRole('button', { name: '回答を送信', exact: true }).click();
}

export async function completeRun(page: Page, screenshots = false) {
  const shot = async (name: string) => {
    // No screen may widen the layout viewport (horizontal page scroll on phones).
    const [inner, scroll] = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth]);
    expect(scroll, `horizontal overflow on ${name}`).toBeLessThanOrEqual(inner);
    if (screenshots) await page.screenshot({ path: `test-results/screens/${testProject(page)}/${name}.png`, fullPage: true });
  };
  await shot('welcome');
  await page.getByRole('button', { name: 'デモをはじめる' }).click(); await shot('consent');
  await page.getByLabel('上記を読み、デモとして進めることに同意します').check();
  await page.getByRole('button', { name: '同意して進む' }).click(); await shot('instructions');
  await page.getByRole('button', { name: 'ラウンド1を始める' }).click(); await shot('round1-chat');
  await sendMessage(page, 'この「ねこ」のような形はどうでしょう？');
  await sendMessage(page, 'もう一つの形も確認したいです'); await shot('round1-chat-messages');
  await endChat(page); await shot('round1-naming');
  await submitNames(page, '名前A'); await shot('round1-survey');
  await submitBlockSurvey(page); await shot('interblock');
  await page.getByRole('button', { name: 'ラウンド2を始める' }).click(); await shot('round2-chat');
  await sendMessage(page, '丸い部分があります'); await sendMessage(page, 'こちらも相談します');
  await endChat(page); await shot('round2-naming');
  await submitNames(page, '名前B'); await shot('round2-survey');
  await submitBlockSurvey(page); await shot('comparison');
  for (const name of ['1. 精神的な努力が少なくて済んだのはどちらですか','2. 対話を進めやすかったのはどちらですか','3. 煩わしさが少なかったのはどちらですか']) {
    await page.getByRole('group', { name }).getByRole('radio', { name: '同じくらい' }).check();
  }
  await page.getByRole('button', { name: '回答を送信', exact: true }).click(); await shot('results');
  await page.getByRole('button', { name: '終了する' }).click(); await shot('done');
}

function testProject(page: Page) { return page.context().browser()?.browserType().name() === 'chromium' ? (page.viewportSize()?.width === 1280 ? 'desktop' : 'mobile') : 'desktop'; }

export async function storedSession(page: Page): Promise<any> {
  return page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || 'null'), sessionKey);
}
