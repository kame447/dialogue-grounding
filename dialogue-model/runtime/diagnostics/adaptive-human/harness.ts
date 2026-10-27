import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {channel} from './cdp.ts';
import {validateOutput} from './simulator.ts';
import type {HumanInput, HumanOutput, Persona, PublicTurn} from './simulator.ts';

type Surface = {label: string; phase: string; status: number; text: string};
export type HarnessOptions = {
  appOrigin: string; cdpOrigin: string; outputDirectory: string; persona: Persona;
  simulator: (input: HumanInput) => HumanOutput | Promise<HumanOutput>;
  maxTurns?: number; timeoutMs?: number; includeBoardImage?: boolean;
  beforeSimulatorTurn?: () => Promise<void>;
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A failure as a closed code only (e.g. participant_ui_timeout); any other message is never printed. */
export const failureCode = (error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{0,63}$/u.test(message) ? message : 'unexpected_error';
};
const counts = (state: any) => ({human: state.trial.events.filter((e: any) => e.speaker === 'human').length,
  ai: state.trial.events.filter((e: any) => e.speaker === 'ai').length});

/** Technical smoke: final names and questionnaire answers are synthetic, not outcome estimates. */
export async function driveParticipant(options: HarnessOptions) {
  const maxTurns = options.maxTurns ?? 4, timeoutMs = options.timeoutMs ?? 360000;
  assert.ok(Number.isSafeInteger(maxTurns) && maxTurns > 0 && maxTurns <= 100);
  for (const origin of [options.appOrigin, options.cdpOrigin]) {
    const u = new URL(origin); assert.ok(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname));
  }
  await mkdir(options.outputDirectory, {recursive: true, mode: 0o700});
  const surfaces: Surface[] = [], turns: {historyLength: number; output: HumanOutput}[] = [];
  const log: {stage: string; [key: string]: unknown}[] = [];
  const meta = await (await fetch(options.cdpOrigin + '/json/version')).json() as any;
  const browser = await channel(meta.webSocketDebuggerUrl);
  let context: any, page: Awaited<ReturnType<typeof channel>> | undefined;
  let stopReason = 'turn_cap', sessionId: string | undefined;
  try {
    context = await browser.call('Target.createBrowserContext');
    const tab = await browser.call('Target.createTarget', {url: 'about:blank', browserContextId: context.browserContextId});
    const url = new URL(meta.webSocketDebuggerUrl); url.pathname = '/devtools/page/' + tab.targetId;
    page = await channel(url.href);
    const call = page.call;
    async function js(expression: string): Promise<any> {
      const r = await call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (r.exceptionDetails) throw new Error('browser_evaluation_failed');
      return r.result.value;
    }
    const state = () => js(`fetch('/api/state').then(r=>r.json())`);
    async function until(expression: string) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await js(expression)) return;
        if ((await state()).trial?.aiStatus === 'error') throw new Error('participant_ai_error');
        await wait(100);
      }
      throw new Error('participant_ui_timeout');
    }
    async function grab(label: string, path: string, phase: string) {
      const r = await js(`(async()=>{const r=await fetch(${JSON.stringify(path)});return {status:r.status,text:await r.text()}})()`);
      surfaces.push({label, phase, ...r}); assert.equal(r.status, 200, label);
      return JSON.parse(r.text);
    }
    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', {width: 1280, height: 800, deviceScaleFactor: 1, mobile: false});
    await call('Page.navigate', {url: options.appOrigin + '/'});
    // A new trial starts only from the participant's explicit Start button (#139).
    await until(`document.querySelectorAll('#board path[role=button]').length===6||(()=>{const b=document.getElementById('start-trial');return !!b&&!b.disabled&&!document.getElementById('start-stage').hidden})()`);
    await js(`(()=>{const b=document.getElementById('start-trial');if(b&&!b.disabled&&!document.getElementById('start-stage').hidden)b.click();return true})()`);
    await until(`document.querySelectorAll('#board path[role=button]').length===6`);
    sessionId = (await state()).trial.sessionId;
    log.push({stage: 'loaded'});
    for (let index = 0; index < maxTurns; index++) {
      const before = await state(), beforeCounts = counts(before);
      // Rebuild the whitelist explicitly. Never pass state, event IDs or scene metadata.
      const history: PublicTurn[] = before.trial.events.filter((e: any) => e.speaker === 'human' || e.speaker === 'ai')
        .map((e: any) => ({speaker: e.speaker, text: e.text}));
      const input: HumanInput = {persona: options.persona, history};
      if (options.includeBoardImage !== false) {
        const clip = await js(`(()=>{const r=document.getElementById('board').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1}})()`);
        const shot = await call('Page.captureScreenshot', {format: 'png', clip, captureBeyondViewport: true});
        (input as {boardImage?: HumanInput['boardImage']}).boardImage = {mimeType: 'image/png', base64: shot.data};
      }
      await options.beforeSimulatorTurn?.();
      const output = validateOutput(await options.simulator(input));
      turns.push({historyLength: history.length, output});
      await js(`document.getElementById('utterance').value=${JSON.stringify(output.utterance)};document.getElementById('send-message').click();true`);
      await until(`fetch('/api/state').then(r=>r.json()).then(s=>s.trial.aiStatus==='idle'&&s.trial.events.filter(e=>e.speaker==='human').length===${beforeCounts.human + 1}&&s.trial.events.filter(e=>e.speaker==='ai').length>${beforeCounts.ai}&&s.trial.events.at(-1)?.speaker==='ai')`);
      log.push({stage: 'turn', turn: index + 1, ...counts(await state())});
      if (output.done) { stopReason = 'simulator_done'; break; }
    }
    await grab('GET /api/state (poll)', '/api/state', 'before_questionnaire_submit');
    await js(`document.getElementById('finish-conversation').click();for(const [i,p] of [...document.querySelectorAll('#board path[role=button]')].entries()){p.dispatchEvent(new MouseEvent('click',{bubbles:true}));document.getElementById('figure-name').value='合成の名前'+(i+1);document.querySelector('#name-form button[type=submit]').click()}true`);
    await until(`!document.getElementById('review-names').disabled&&/6 *[/] *6$/.test(document.getElementById('name-count').textContent)`);
    await js(`document.getElementById('review-names').click();true`);
    await until(`document.getElementById('confirm-dialog').open&&!document.getElementById('confirm-submit').disabled`);
    await js(`document.getElementById('confirm-submit').click();true`);
    await until(`!document.getElementById('questionnaire-stage').hidden&&!document.getElementById('questionnaire-form').hidden`);
    const locked = await grab('GET review (locked)', `/api/records/${sessionId}/review`, 'before_questionnaire_submit');
    assert.equal(locked.result, undefined);
    await grab('GET questionnaire', `/api/records/${sessionId}/questionnaire`, 'before_questionnaire_submit');
    await grab('GET /api/records', '/api/records', 'before_questionnaire_submit');
    await js(`for(const input of document.querySelectorAll('#questionnaire-items input[type=radio]'))if(input.value==='4')input.click();document.getElementById('questionnaire-submit').click();true`);
    await until(`!document.getElementById('results').hidden&&document.getElementById('result-list').children.length===6`);
    await grab('GET /api/state (after submit)', '/api/state', 'after_questionnaire_submit');
    const unlocked = await grab('GET review (unlocked)', `/api/records/${sessionId}/review`, 'after_questionnaire_submit');
    assert.ok(unlocked.result);
    await grab('GET questionnaire (after submit)', `/api/records/${sessionId}/questionnaire`, 'after_questionnaire_submit');
    await grab('GET /api/records (after submit)', '/api/records', 'after_questionnaire_submit');
    await call('Page.reload');
    await until(`!document.getElementById('results').hidden&&document.getElementById('result-list').children.length===6`);
    const restored = await grab('GET /api/state (reload)', '/api/state', 'after_questionnaire_submit');
    assert.equal(restored.trial.sessionId, sessionId);
    await writeFile(join(options.outputDirectory, 'page.public.html'), await js('document.documentElement.outerHTML'), {mode: 0o600});
    log.push({stage: 'reload', sameTrial: true, stopReason, syntheticSubmission: true});
    return {sessionId, stopReason, turns: turns.length, surfaces: surfaces.length};
  } catch (error) {
    // The stage before the failure is already logged; add only a closed code (#141).
    log.push({stage: 'failed', code: failureCode(error)});
    throw error;
  } finally {
    // Private human assessments are never mixed into the scanner's public-surface file.
    await writeFile(join(options.outputDirectory, 'surfaces.private.json'), JSON.stringify(surfaces, null, 2), {mode: 0o600});
    await writeFile(join(options.outputDirectory, 'human.private.json'), JSON.stringify({persona: options.persona, turns}, null, 2), {mode: 0o600});
    await writeFile(join(options.outputDirectory, 'DRIVER-LOG.json'), JSON.stringify(log, null, 2), {mode: 0o600});
    page?.close();
    try { if (context) await browser.call('Target.disposeBrowserContext', {browserContextId: context.browserContextId}); }
    finally { browser.close(); }
  }
}
