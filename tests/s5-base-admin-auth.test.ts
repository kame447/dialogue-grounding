import test from 'node:test';
import assert from 'node:assert/strict';
import {web,ADMIN} from './support/s5-base/http-support.ts';
for(const withCookie of [false,true])test('BASE local admin auth fingerprint, cookie='+withCookie,{timeout:4000},async t=>{const h=await web(t);if(withCookie)await h.page();const r=await h.request('/admin/record/33333333-3333-4333-8333-333333333333/prepare-next',{}, {Authorization:'Bearer wrong-synthetic-token'},withCookie);assert.equal(r.status,401);assert.match(r.headers.get('www-authenticate')??'',/Basic realm="tangram-admin"/);assert.equal(await r.text(),'Authentication required');assert.equal(h.inputs.length,0)});
