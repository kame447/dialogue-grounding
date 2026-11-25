import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {interventionChecks} from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';

// Additional controls from BoldCurie's independent RI3-FINDINGS; frozen tests
// and fixture bytes remain unchanged.
const normal = JSON.parse(await readFile(new URL('./support/s4-integration/NORMAL-RECORDS.json', import.meta.url), 'utf8'));
function uncommitted() {
  const r = structuredClone(normal), tr = r.trials[0];
  Object.assign(tr.attempts[0], {status:'error', errorCode:'decision_failed', decisions:[], executed:null, intervention:null, finalAction:null, publicSpeech:null});
  Object.assign(tr, {turns:[], lastCommittedState:null, replay:[], calls:[], http:[]});
  r.evidence.pairedReplay = [];
  r.evidence.events = [];
  return r;
}
const component = (r:any, name:string) => interventionChecks(r).find(c => c.id.endsWith('.'+name));

test('RI3 missing independent source preserves optional replay applicability', () => {
  const r = uncommitted();
  assert.equal(component(r,'binding')?.status, 'not_reached');
  assert.equal(component(r,'replay')?.status, 'pass');
  assert.deepEqual(component(r,'replay')?.detail, {applicable:false});
});
test('RI3 a trace copy on another owning turn cannot confirm the event key', () => {
  const r = uncommitted(), tr = r.trials[0];
  tr.turns = [{turn:99, publicText:'unrelated', trace:[structuredClone(tr.attempts[0])]}];
  assert.equal(component(r,'binding')?.status, 'mismatch');
});
test('RI3 malformed supplied optional replay is rejected before absence shortcuts', () => {
  const r = uncommitted();
  r.trials[0].replay = [{}];
  assert.equal(component(r,'replay')?.status, 'mismatch');
});
test('RI3 supplied optional replay must belong to an authoritative turn', () => {
  const r = uncommitted(), entry = structuredClone(normal.trials[0].replay[0]);
  entry.tape.events.at(-1).seq = 999;
  r.trials[0].replay = [entry];
  assert.equal(component(r,'binding')?.status, 'mismatch');
});
test('RI3 every supplied event witness participates in the binding check', () => {
  const r = uncommitted(), entry = structuredClone(normal.trials[0].replay[0]);
  r.trials[0].replay = [entry];
  assert.equal(component(r,'binding')?.status, 'pass');
  const conflicting = structuredClone(entry);
  conflicting.tape.events.at(-1).id = 'human-conflict';
  r.trials[0].replay.push(conflicting);
  assert.equal(component(r,'binding')?.status, 'mismatch');
});
test('RI3 malformed supplied result takes precedence over missing paired evidence', () => {
  const r = structuredClone(normal);
  r.trials[0].replay[0].result = {};
  r.evidence.pairedReplay = [];
  assert.equal(component(r,'replay')?.status, 'mismatch');
  assert.equal(component(r,'replay')?.reason, 'intervention_replay_mismatch');
});
