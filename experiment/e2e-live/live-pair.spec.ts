import { devices, expect, test, type Browser, type Page } from '@playwright/test';

/** Two independent browser contexts (= two devices) talking through the real Worker + Durable Object. */

const SHOTS = process.env.LIVE_BASE_URL ? 'test-results/live-screens/deployed' : 'test-results/live-screens/local';

async function noOverflow(page: Page, name: string, shot = true) {
  const [inner, scroll] = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth]);
  expect(scroll, `horizontal overflow on ${name}`).toBeLessThanOrEqual(inner);
  if (shot) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function createRoom(page: Page) {
  await page.goto('/#/live');
  await page.getByRole('button', { name: 'ルームを作成' }).click();
  const p1 = await page.getByRole('textbox', { name: '参加者1の招待リンク' }).inputValue();
  const p2 = await page.getByRole('textbox', { name: '参加者2の招待リンク' }).inputValue();
  expect(p1).toMatch(/#\/live\/[0-9a-f]{32}\/[0-9a-f]{48}$/);
  expect(p2).toMatch(/#\/live\/[0-9a-f]{32}\/[0-9a-f]{48}$/);
  expect(p1).not.toEqual(p2);
  return { p1, p2 };
}

async function openDevice(browser: Browser, kind: 'desktop' | 'mobile') {
  const context = await browser.newContext(kind === 'desktop' ? { viewport: { width: 1280, height: 800 } } : { ...devices['Pixel 7'] });
  return { context, page: await context.newPage() };
}

/** Figure signature = its polygon points, which are identical on both devices for the same figure. */
async function figureSignatures(page: Page) {
  const figures = page.getByRole('region', { name: 'あなたの図形' }).locator('svg');
  await expect(figures).toHaveCount(6);
  return figures.evaluateAll((svgs) => svgs.map((svg) => Array.from(svg.querySelectorAll('polygon')).map((p) => p.getAttribute('points')).join('|')));
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'メッセージ' }).fill(text);
  await page.getByRole('button', { name: '送信', exact: true }).click();
}

async function nameFigures(page: Page, names: string[]) {
  for (let i = 0; i < 6; i++) await page.getByRole('textbox', { name: `図形${i + 1}の名前` }).fill(names[i]);
  await page.getByRole('button', { name: '名前を確定する' }).click();
  await page.getByRole('button', { name: '確定する', exact: true }).click();
}

async function answerSurvey(page: Page) {
  for (const name of [/^精神的な努力/, /^進めやすさ/, /^煩わしさ/]) await page.getByRole('group', { name }).getByRole('radio').nth(2).check();
  await page.getByRole('button', { name: '回答を送信', exact: true }).click();
}

test('two devices chat in real time, name, wait for each other and see the DEMO result', async ({ browser }) => {
  const a = await openDevice(browser, 'desktop');
  const b = await openDevice(browser, 'mobile');
  const { p2 } = await createRoom(a.page);
  await noOverflow(a.page, 'p1-lobby');
  await a.page.getByRole('button', { name: '参加者1としてこの端末で入る' }).click();
  await expect(a.page.getByText('相手の参加を待っています')).toBeVisible();
  await noOverflow(a.page, 'p1-waiting-peer');

  await b.page.goto(p2);
  await expect(b.page.getByRole('textbox', { name: 'メッセージ' })).toBeVisible();
  await expect(a.page.getByRole('textbox', { name: 'メッセージ' })).toBeVisible();

  // Same six figures, in a different order on each device; no stimulus IDs anywhere in the DOM.
  const sigA = await figureSignatures(a.page);
  const sigB = await figureSignatures(b.page);
  expect([...sigA].sort()).toEqual([...sigB].sort());
  expect(sigA).not.toEqual(sigB);
  for (const page of [a.page, b.page]) expect(await page.content()).not.toMatch(/alpha-\d|beta-\d/);

  // Real-time chat both ways, rendered as text (no HTML injection).
  await send(a.page, '<b>左上</b>の細長い形は「はしご」でどうですか');
  const logB = b.page.getByRole('log', { name: '会話ログ' });
  await expect(logB.getByRole('listitem').filter({ hasText: '<b>左上</b>の細長い形' })).toBeVisible();
  await expect(logB.locator('b')).toHaveCount(0);
  await send(b.page, 'いいですね。こちらでは3番目にあります');
  await expect(a.page.getByRole('log', { name: '会話ログ' }).getByText('こちらでは3番目にあります')).toBeVisible();
  await noOverflow(a.page, 'p1-chat');
  await noOverflow(b.page, 'p2-chat-mobile');

  // P1 ends the conversation; P2 can no longer chat and is told to move on.
  await a.page.getByRole('button', { name: '会話を終了する' }).click();
  await a.page.getByRole('button', { name: '終了する', exact: true }).click();
  await expect(a.page.getByRole('textbox', { name: '図形1の名前' })).toBeVisible();
  await expect(b.page.getByText('相手が会話を終了しました')).toBeVisible();
  await expect(b.page.getByRole('textbox', { name: 'メッセージ' })).toBeDisabled();
  await noOverflow(b.page, 'p2-peer-ended-mobile');
  await b.page.getByRole('button', { name: '会話を終了する' }).click();
  await b.page.getByRole('button', { name: '終了する', exact: true }).click();

  // Both name the figures. Names are derived from the figure geometry so they agree, except one deliberate mismatch.
  const canonical = [...sigA].sort();
  const nameFor = (sig: string) => `形${canonical.indexOf(sig) + 1}`;
  await nameFigures(a.page, sigA.map(nameFor));
  const namesB = sigB.map(nameFor);
  const mismatchIndex = namesB.indexOf('形6');
  namesB[mismatchIndex] = 'ちがう名前';
  await expect(b.page.getByRole('textbox', { name: '図形1の名前' })).toBeVisible();
  await noOverflow(b.page, 'p2-naming-mobile');
  await nameFigures(b.page, namesB);

  // P1 finishes first: it must wait, results stay hidden, and a reload keeps it waiting (reconnect).
  await answerSurvey(a.page);
  await expect(a.page.getByText('相手の回答を待っています')).toBeVisible();
  await expect(a.page.getByRole('table', { name: 'DEMO結果' })).toHaveCount(0);
  await noOverflow(a.page, 'p1-waiting-results');
  await a.page.reload();
  await expect(a.page.getByText('相手の回答を待っています')).toBeVisible();
  await expect(a.page.getByRole('table', { name: 'DEMO結果' })).toHaveCount(0);

  await expect(b.page.getByRole('group', { name: /^精神的な努力/ })).toBeVisible();
  await noOverflow(b.page, 'p2-survey-mobile');
  await answerSurvey(b.page);

  for (const page of [a.page, b.page]) {
    const table = page.getByRole('table', { name: 'DEMO結果' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(7);
    await expect(page.getByText(/一致\s*5\s*\/\s*6/)).toBeVisible();
    await expect(table.getByText('ちがう名前')).toBeVisible();
  }
  await noOverflow(a.page, 'p1-results');
  await noOverflow(b.page, 'p2-results-mobile');
  await a.context.close();
  await b.context.close();
});

test('same invite link in a second tab takes over; an invalid link is refused', async ({ browser }) => {
  const a = await openDevice(browser, 'desktop');
  const { p1 } = await createRoom(a.page);
  await a.page.goto(p1);
  await expect(a.page.getByText('相手の参加を待っています')).toBeVisible();

  const second = await a.context.newPage();
  await second.goto(p1);
  await expect(second.getByText('相手の参加を待っています')).toBeVisible();
  await expect(a.page.getByText('別のタブまたは端末でこの招待リンクが開かれた')).toBeVisible();
  await noOverflow(a.page, 'replaced-tab');

  const bad = p1.replace(/[0-9a-f]{48}$/, '0'.repeat(48));
  const third = await a.context.newPage();
  await third.goto(bad);
  await expect(third.getByText('招待リンクが無効です')).toBeVisible();
  await a.context.close();
});

test('server API: no room listing, origin check, token required on the socket', async ({ page, request, baseURL }) => {
  const created = await request.post('/api/rooms');
  expect(created.status()).toBe(201);
  expect(created.headers()['cache-control']).toContain('no-store');
  expect(created.headers()['access-control-allow-origin']).toBeUndefined();
  const body = await created.json();
  expect(Object.keys(body).sort()).toEqual(['expiresAt', 'roomId', 'tokens']);

  expect((await request.get('/api/rooms')).status()).toBe(404);
  expect((await request.get(`/api/rooms/${body.roomId}`)).status()).toBe(404);
  expect((await request.get(`/api/rooms/${body.roomId}/messages`)).status()).toBe(404);
  expect((await request.post('/api/rooms', { headers: { origin: 'https://evil.example' } })).status()).toBe(403);
  expect((await request.get(`/api/rooms/${body.roomId}/ws`, { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', origin: 'https://evil.example' } })).status()).toBe(403);

  await page.goto('/');
  const wsBase = baseURL!.replace(/^http/, 'ws');
  const result = await page.evaluate(async ({ url, token }) => {
    const ws = new WebSocket(url);
    const frames: unknown[] = [];
    return new Promise<{ frames: unknown[]; code: number }>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, token }));
      ws.onmessage = (e) => frames.push(JSON.parse(e.data));
      ws.onclose = (e) => resolve({ frames, code: e.code });
      setTimeout(() => resolve({ frames, code: -1 }), 10_000);
    });
  }, { url: `${wsBase}/api/rooms/${body.roomId}/ws`, token: 'f'.repeat(48) });
  expect(result.code).toBe(4003);
  expect(result.frames).toEqual([expect.objectContaining({ type: 'error', code: 'bad_token' })]);
});
