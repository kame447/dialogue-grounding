// P1 frozen 309d49f3 + 773704e0. Synthetic clients only; no live API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createMockJevDecisionClient } from '../dialogue-model/runtime/decision/mocks.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { createDialogueV2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { scoreTrial as scoreNames } from '../dialogue-model/runtime/scoring.mjs';

const seed = 909;
const trial = createTrialV2({seed}), own = modelView(trial);
const memo = {observedAt:'2026-10-20T00:00:00.000Z',figures:own.anchors.map((a:any)=>({id:a.id,region:a.bbox,
  holistic:[],analytic:{shapes:['三角'],composition:'二つの部分が接する',relations:[]},unknowns:[],reobservations:[]}))};
const timeouts = {observationMs:20000,localMs:20000,decisionMs:20000,lunaAttemptMs:80000,generationMs:40000,trialMs:600000};
const profile = researchTrialProfileV3({timeoutMs:null,maxCompletionTokens:1000},timeouts);
const limits = {lunaCalls:100,lunaPosts:100,lunaTokens:100000,jevPosts:100,jevUsd:10};
function setup(extra:any={}) {
  let observations=0, calls=0, saved:any;
  const client={async complete(_m:any,o:any={}){calls++;return{text:o.phase==='local_extraction'||o.phase==='ai_extraction'?'[]':o.phase==='final_submission'?JSON.stringify(Object.fromEntries(own.anchors.map((a:any)=>[a.id,null]))):'なるほど。',model:'synthetic-luna'};}};
  const jevResearch={profile,observer:{async observeAll(){observations++;return structuredClone(memo);},async reobserve(){throw Error('unused');}},
    jevDecision:createMockJevDecisionClient(()=>({action:'accept',target:{kind:'none'},name:null,feature:null,observe:null})),
    localGrounding:{classifier:{async classify(){return[];}},timeoutMs:profile.timeouts.localMs,aiPublicClaims:true},ledger:new RunBudget(limits)};
  const options={client,strategy:'repair-first',seed,referenceMemory:true,runDir:null,createTrial:()=>trial,
    judge:{async judge(){return{action:'accept',targetSlot:null,candidateName:null,discriminatingFeature:null,note:null};}},
    jevResearch,onPersist:async(r:any)=>{saved=structuredClone(r);},...extra};
  return {options,jevResearch,counts:()=>({observations,calls}),record:()=>saved};
}

test('J-D1/D2: Jev initializes its memo before queue creation, without a completion',async()=>{
  const h=setup(),task=await createNamingTaskV2(h.options);
  assert.equal(task.researcherView().privateState.schemaVersion,'jev_private_state_v2');
  assert.deepEqual(task.researcherView().privateState.observationMemo,memo);
  assert.deepEqual(h.counts(),{observations:1,calls:0});
  assert.equal(h.record().options.jevResearch,true);
});

test('J-R1/R3: restored Jev needs its explicit matching config; old records stay old',async()=>{
  const h=setup(),first=await createNamingTaskV2(h.options),saved=h.record();
  assert.ok(saved.options.jevResearch);
  await assert.rejects(createNamingTaskV2({...h.options,jevResearch:null,restore:saved}),{code:'invalid_options'});
  const restored=await createNamingTaskV2({...h.options,restore:saved});
  assert.deepEqual(restored.researcherView().privateState,first.researcherView().privateState);
  assert.equal(h.counts().observations,1);
});

test('J-V1: Jev rejects disabled memory and legacy decision paths before calls',async()=>{
  for(const extra of [{referenceMemory:false},{activeDecision:{purpose:'decision_jev',client:{chooseAction(){}}}},
    {localGrounding:{}},{groundingShadow:{}},{decisionShadowClient:{chooseAction(){}}}]){
    const h=setup(extra);await assert.rejects(createNamingTaskV2(h.options),{code:'invalid_options'});
    assert.deepEqual(h.counts(),{observations:0,calls:0});
  }
});

test('J-V1/R1/R3: malformed profile, unknown restore marker and changed profile fail before observation',async()=>{
  for(const profileChange of [{...profile,id:'research_trial_profile_v2'},
    {...profile,interventionPolicy:{...profile.interventionPolicy,version:'unknown'}},
    {...profile,maxReobservations:3}]){
    const h=setup();h.options.jevResearch={...h.jevResearch,profile:profileChange} as any;
    await assert.rejects(createNamingTaskV2(h.options),{code:'invalid_options'});
    assert.deepEqual(h.counts(),{observations:0,calls:0});
  }
  const h=setup();await createNamingTaskV2(h.options);const saved=h.record();
  for(const restored of [{...saved,options:{...saved.options,jevResearch:'unknown'}},
    {...saved,options:{...saved.options,profileSha256:'0'.repeat(64)}},
    {...saved,queueState:{...saved.queueState,privateState:{...saved.queueState.privateState,schemaVersion:'unknown'}}}])
    await assert.rejects(createNamingTaskV2({...h.options,restore:restored}),{code:'invalid_options'});
  assert.deepEqual(h.counts(),{observations:1,calls:0});
});

test('J-R3/D0: an old record restored on a Jev server keeps legacy options and no Jev initialization',async()=>{
  const h=setup();await createNamingTaskV2({...h.options,jevResearch:null});const saved=h.record();
  await createNamingTaskV2({...h.options,restore:saved});
  assert.deepEqual(h.record().options,saved.options);assert.deepEqual(h.counts(),{observations:0,calls:0});
  await assert.rejects(createNamingTaskV2({...h.options,restore:{...saved,options:{...saved.options,profileSha256:'0'.repeat(64)}}}),{code:'invalid_options'});
});

test('J-T1: overtaken generation is not committed or installed in durable Jev state',async()=>{
  let started!:()=>void,finish!:()=>void,generations=0;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const h=setup({client:{async complete(_messages:any,options:any){
    if(['local_extraction','ai_extraction'].includes(options.phase))return{text:'[]'};
    if(++generations===1){started();return new Promise(resolve=>{finish=()=>resolve({text:'古い応答'});});}
    return{text:'新しい応答'};
  }}});
  const task=await createNamingTaskV2(h.options);task.message('最初の説明','first');await ready;
  task.message('説明を補います','second');finish();await task.whenIdle();
  assert.equal(task.getState().aiStatus,'idle');
  assert.ok(!task.getState().events.some((e:any)=>e.text==='古い応答'));
  assert.equal(h.record().jevTraces.filter((r:any)=>r.status==='committed').length,1);
  assert.ok(h.record().jevTraces.some((r:any)=>r.status!=='committed'));
  assert.equal(h.record().queueState.privateState.judgments.length,1);
});

test('J-T2: settlement is attempted once after close; its failure does not block scoring',async t=>{
  const h=setup(),task=await createNamingTaskV2(h.options);task.message('形を確認します','one');await task.whenIdle();
  assert.equal(task.getState().aiStatus,'idle');
  const failing=t.mock.method(crypto.subtle,'digest',async()=>{throw Error('synthetic-settlement-failure');});
  await task.submitHuman({names:Object.fromEntries(task.getState().scene.shapes.map((s:any)=>[s.id,null]))});
  assert.deepEqual(h.record().aiPublicSettlement,{status:'error',code:'settlement_failed'});
  assert.equal(failing.mock.callCount(),1);failing.mock.restore();
  await task.persistNow();await task.submitAI();
  assert.equal(task.getState().status,'completed');
});

test('J-R2: frozen synthetic private state is reusable across labels without changing BASE bindings',async()=>{
  const h=setup(),task=await createNamingTaskV2(h.options),frozen=task.researcherView().privateState;
  const original=structuredClone(frozen);
  for(const strategy of ['repair-first','bypass-enabled']){
    const dialogue=createDialogueV2({client:h.options.client,strategy,referenceMemory:true,decisionMode:'jev',
      image:{mimeType:own.mimeType,base64:own.png.toString('base64')},anchors:own.anchors,
      observer:h.jevResearch.observer,jevDecision:h.jevResearch.jevDecision,localGrounding:h.jevResearch.localGrounding,
      interventionPolicy:profile.interventionPolicy,decisionTimeoutMs:profile.timeouts.decisionMs});
    const result=await dialogue.runAiTurn({events:[{id:'public-1',seq:1,speaker:'human',text:'この形を話題にします'}],privateState:frozen,lastEventId:'public-1'});
    assert.equal(result.privateState.schemaVersion,'jev_private_state_v2');
    assert.deepEqual(frozen,original);
  }
  assert.equal(h.counts().observations,1);
});

test('J-F1: a generation failure recovers on the scheduled attempt',async()=>{
  let generation=0;
  const h=setup({client:{async complete(_messages:any,options:any){
    if(['local_extraction','ai_extraction'].includes(options.phase))return{text:'[]'};
    if(options.phase==='generation'&&++generation===1)throw Error('synthetic-failure-with-private-body');
    return{text:'理解しました。'};
  }}});
  let recover: (() => void) | undefined;
  const task=await createNamingTaskV2({...h.options,recoveryTimers:{
    set(callback){recover=callback;return 0 as unknown as ReturnType<typeof setTimeout>;},clear(){recover=undefined;},
  }});task.message('この形を確認します','retry');await task.whenIdle();
  assert.equal(task.getState().recovering,true);
  assert.ok(!JSON.stringify(task.getState()).includes('synthetic-failure-with-private-body'));
  assert.ok(recover);recover();await task.whenIdle();assert.equal(task.getState().aiStatus,'idle');
  assert.deepEqual(h.record().jevTraces.map((r:any)=>r.status),['error','committed']);
});

const v3 = researchTrialProfileV3(profile.lunaRequest, timeouts, 'two_stage_v3', 'holistic_v3');
const ownSlots: string[] = own.anchors.map(({ id }: { id: string }) => id);
const [agreedSlot, otherSlot] = ownSlots;
const agreedName = '札A';
const proposal = 'この形の呼び名は札Aがよさそうです。';
const agreement = '「札A」にしましょう。';
const emptyNames: Record<string, string | null> = Object.fromEntries(ownSlots.map(id => [id, null]));
const movedName = { ...emptyNames, [otherSlot]: agreedName };

function agreementTrial(strategy: 'repair-first' | 'bypass-enabled',
  answers: Array<Record<string, string | null>>, drafts = [agreement]) {
  let generationCalls = 0;
  const finalRequests: Array<Array<{ role: string; content: string }>> = [];
  const submissions: Array<Record<string, string>> = [];
  const h = setup({ strategy, utteranceStyle: v3.utteranceStyle,
    scoreTrial(data: { key: { human: Record<string, string>; ai: Record<string, string> };
      humanSubmission: Record<string, string>; aiSubmission: Record<string, string> }) {
      submissions.push(data.aiSubmission);
      return scoreNames(data);
    },
    client: { async complete(messages: typeof finalRequests[number], { phase }: { phase: string }) {
      let text = '[]';
      if (phase === 'local_extraction') text = JSON.stringify([{ segmentId: '1', quote: proposal, proposition: proposal,
        aspect: 'name', name: agreedName, targets: [agreedSlot], linkedIssueId: null, respondsToTurn: null }]);
      if (phase === 'generation') {
        assert.ok(drafts[generationCalls], 'unexpected generation');
        text = drafts[generationCalls++];
      }
      if (phase === 'final_submission') {
        const answer = answers[finalRequests.length];
        assert.ok(answer, 'unexpected final request');
        finalRequests.push(messages);
        text = JSON.stringify(answer);
      }
      return { text, model: 'synthetic-luna' };
    } },
  });
  let responses = 0;
  const native = createJevDecisionClient({ enabled: true, questionLayout: 'two_stage_v3', timeoutMs: v3.timeouts.decisionMs,
    readKey: async () => 'sk-or-SYNTHETIC-final-name-0000000000',
    async fetchImpl(_url, init) {
      const { model, questions } = JSON.parse(String(init.body));
      const choices = Object.fromEntries(Object.entries(questions).map(([key, question]: [string, any]) => {
        const labels = Object.keys(question.criteria);
        const choice = key === 'action' ? 'agree' : key === 'target' || key === 'human_referent' ? 'figure_0' : labels[0];
        assert.ok(labels.includes(choice));
        return [key, { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(label => [label, Number(label === choice)])) }];
      }));
      return Response.json({ model, id: 'gen-agreed-final-' + ++responses, usage: { cost: 0 }, answers: choices });
    } })!;
  h.options.jevResearch = { ...h.jevResearch, profile: v3, technicalTrial: { version: 'adaptive_repair_v3' }, jevDecision: native,
    localGrounding: { ...h.jevResearch.localGrounding, classifier: {
      async classify() { return [{ segmentId: '1', act: 'name_propose', respondsToClaimId: null, rawScore: 1 }]; },
    } } };
  return { ...h, finalRequests, submissions, generationCalls: () => generationCalls };
}

for (const strategy of ['repair-first', 'bypass-enabled'] as const) {
  test('v3 final submission retries a wrong agreed slot using the committed names (' + strategy + ')', async () => {
    const corrected: Record<string, string | null> = { ...emptyNames, [agreedSlot]: '札Ａ', [otherSlot]: '別の候補' };
    const h = agreementTrial(strategy, [movedName, corrected]);
    const task = await createNamingTaskV2(h.options);
    task.message(proposal, 'first');
    await task.whenIdle();
    const before = h.record();
    assert.equal(before.events.at(-1).text, agreement);
    assert.deepEqual(before.ownLedger[agreedSlot], { status: 'agreed', name: agreedName });
    const restored = await createNamingTaskV2({ ...h.options, restore: JSON.parse(JSON.stringify(before)) });
    await restored.submitHuman({ names: Object.fromEntries(restored.getState().scene.shapes.map(({ id }: { id: string }) => [id, null])) });
    await restored.submitAI();
    assert.equal(h.finalRequests.length, 2);
    assert.equal(h.finalRequests[1].at(-1)?.content.split('\n').at(-1), JSON.stringify({ [agreedSlot]: agreedName }));
    assert.deepEqual(h.record().aiSubmission, corrected);
    assert.equal(h.submissions.length, 1);
    assert.equal(h.submissions[0][agreedSlot], corrected[agreedSlot]);
    assert.deepEqual(h.record().ownLedger, before.ownLedger);
  });

  test('v3 final submission persists no names and does not score after a second mismatch (' + strategy + ')', async () => {
    const h = agreementTrial(strategy, [movedName, { ...emptyNames, [agreedSlot]: '別名' }]);
    const task = await createNamingTaskV2(h.options);
    task.message(proposal, 'first');
    await task.whenIdle();
    await task.submitHuman({ names: Object.fromEntries(task.getState().scene.shapes.map(({ id }: { id: string }) => [id, null])) });
    assert.equal(task.getState().recovering, true);
    assert.equal(h.finalRequests.length, 2);
    assert.equal(h.record().finalError, 'submission_error');
    assert.equal(h.record().aiSubmission, null);
    assert.equal(h.record().scoring, null);
    assert.equal(h.submissions.length, 0);
    assert.deepEqual(h.record().ownLedger[agreedSlot], { status: 'agreed', name: agreedName });
  });

  test('v3 does not publish an empty fallback or commit when both agree drafts fail (' + strategy + ')', async () => {
    const h = agreementTrial(strategy, [], ['名前の案を聞きました。', '候補を確認しています。']);
    const task = await createNamingTaskV2(h.options);
    const before = h.record().queueState.privateState;
    task.message(proposal, 'first');
    await task.whenIdle();
    const record = h.record();
    assert.equal(h.generationCalls(), 2);
    assert.equal(task.getState().recovering, true);
    assert.equal(record.jevTraces[0].errorCode, 'unsafe_generation');
    assert.equal(record.jevTraces[0].generationGuard.fallback, false);
    assert.equal(record.jevTraces[0].publicSpeech, null);
    assert.equal(record.events.filter((event: { speaker: string }) => event.speaker === 'ai').length, 1);
    assert.equal(record.queueState.pendingHumanEventIds.length, 1);
    assert.deepEqual(record.queueState.privateState, before);
  });
}
