import test from 'node:test';import assert from 'node:assert/strict';
import {web} from './support/s5-base/http-support.ts';
for(const [name,value,expected]of [
 ['quotes','Synthetic "help" & support','Synthetic &quot;help&quot; &amp; support'],
 ['control','broken\ncontact','実験の案内に記載された連絡先へお問い合わせください。'],
 ['markup','<script>synthetic</script>','実験の案内に記載された連絡先へお問い合わせください。'],
 ['too-long','x'.repeat(501),'実験の案内に記載された連絡先へお問い合わせください。'],
 ['bad-type',['synthetic'],'実験の案内に記載された連絡先へお問い合わせください。']
] as const)test('public contact meta '+name,async t=>{const h=await web(t,{participantContactText:value});const r=await h.page();assert.equal(r.status,200);const html=await r.text();assert.ok(html.includes('<meta name="participant-contact" content="'+expected+'">'));assert.ok(!html.includes('<script>synthetic</script>'))});
