'use strict';
const $=id=>document.getElementById(id), colors=['#80aacd','#d9b16c','#80b7a1','#ad95c5','#e18c88'];
const rotations=[0,90,180,270],ns='http://www.w3.org/2000/svg';
const copy=v=>JSON.parse(JSON.stringify(v));
let data,saved,results,currentId,dirty=false,saving=null,conflict=false,ready=false;
const key='dialogue-grounding:orientation-review:pending:v1';
const current=()=>results.find(r=>r.id===currentId);
const template=()=>data.templates.find(t=>t.id===currentId);
const byId=id=>results.find(r=>r.id===id);
const complete=r=>r.status==='確認済み';
const filter=()=> $('pending-only').checked;
const figures=()=>Array.from(new Set(data.templates.map(t=>t.figureId)));
const visible=()=>results.filter(r=>!filter()||!complete(r));
const snapshot=()=>({sourceSha256:data.sourceSha256,revision:saved.revision,currentId,results:copy(results)});
const equal=(a,b)=>a.currentId===b.currentId&&JSON.stringify(a.results)===JSON.stringify(b.results);
function info(message,warn=false){
 $('save-status').textContent=message;$('save-status').classList.toggle('warn',warn);
 $('retry').hidden=!warn||conflict;$('backup').hidden=!warn||!ready;$('reload').hidden=!conflict;
}
function stash(){try{localStorage.setItem(key,JSON.stringify(snapshot()));return true}catch{return false}}
function clearStash(){try{localStorage.removeItem(key)}catch{}}
async function api(path,body){
 const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const j=await r.json();if(!r.ok){const e=Error(j.error||'通信に失敗しました');e.status=r.status;throw e}return j;
}
function changed(){dirty=true;stash();info(conflict?'保存版と競合しています。編集を退避してください。':'保存中…',conflict);void flush()}
function flush(){
 if(saving)return saving;if(conflict)return Promise.resolve(false);if(!dirty)return Promise.resolve(true);
 saving=(async()=>{
  while(dirty){
   dirty=false;const outgoing=snapshot();
   try{
    saved=await api('/api/state',outgoing);
    if(!dirty){clearStash();info('Macに保存済み · '+new Date(saved.updatedAt).toLocaleTimeString('ja-JP'))}
    else stash();
   }catch(e){dirty=true;conflict=e.status===409;const kept=stash();info('保存できませんでした: '+e.message+(kept?'（ブラウザに一時退避済み）':''),true);return false}
  }
  return true;
 })().finally(()=>{saving=null});
 return saving;
}
function el(tag,cls,text){const x=document.createElement(tag);if(cls)x.className=cls;if(text!==undefined)x.textContent=text;return x}
function svgEl(tag,attrs){const x=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))x.setAttribute(k,String(v));return x}
function drawing(t,grouped=false,labels=false){
 const [w,h]=t.size,pad=Math.max(w,h)*.055,stroke=Math.max(w,h)*.0045;
 const svg=svgEl('svg',{viewBox:[-pad,-pad,w+2*pad,h+2*pad].join(' '),role:'img','aria-label':t.figureId+' '+t.rotation+'度'});
 t.parts.forEach((p,i)=>{
  const d=p.outlines.map(loop=>loop.map((point,k)=>(k?'L':'M')+point.join(' ')).join(' ')+' Z').join(' ');
  svg.append(svgEl('path',{d,fill:grouped?colors[i%colors.length]:'#293544',stroke:grouped?'#ffffff':'#293544','stroke-width':grouped?stroke:stroke*.2,'stroke-linejoin':'round','fill-rule':'evenodd'}));
  if(labels){
   const [x,y]=p.centroid;
   const text=svgEl('text',{x,y,'text-anchor':'middle','dominant-baseline':'central','font-size':Math.max(w,h)*.044,'font-weight':'650',fill:'#152433','paint-order':'stroke',stroke:'#fff','stroke-width':stroke*1.2});
   text.textContent=p.id;svg.append(text);
  }
 });
 return svg;
}
function navigation(){
 const done=results.filter(complete).length;
 const doneFigures=figures().filter(f=>results.filter(r=>r.id.startsWith(f+'@')).every(complete)).length;
 $('progress').textContent='分割は30図形確定済み　／　観察メモ '+done+' / 120方向　（'+doneFigures+' / 30図形）';
 const nav=$('figure-nav');nav.replaceChildren();
 figures().forEach(f=>{
  const rows=results.filter(r=>r.id.startsWith(f+'@')),n=rows.filter(complete).length;
  if(filter()&&n===4)return;
  const b=el('button', (n===4?'done ':rows.some(r=>r.status==='要修正')?'revise ':'')+(template().figureId===f?'active':''),f+' '+n+'/4');
  b.title=f+' '+n+'方向確認済み';b.addEventListener('click',()=>go((rows.find(r=>!complete(r))||rows[0]).id));nav.append(b);
 });
 const row=current(),t=template();
 $('figure-status').textContent=row.status;
 const orientation=$('orientations');orientation.replaceChildren();
 rotations.forEach(rotation=>{
  const q=data.templates.find(x=>x.figureId===t.figureId&&x.rotation===rotation),r=byId(q.id);
  const b=el('button','orientation '+(q.id===currentId?'active ':'')+(complete(r)?'done':r.status==='要修正'?'revise':''));
  const img=el('div','mini');img.append(drawing(q,true));b.append(img,el('div','mini-label',rotation+'°'),el('div','mini-status',r.status));
  b.setAttribute('aria-label',rotation+'度 '+r.status);b.addEventListener('click',()=>go(q.id));orientation.append(b);
 });
 const pending=visible(),i=pending.findIndex(r=>r.id===currentId);
 $('prev').disabled=i<=0;$('next').disabled=i<0||i===pending.length-1;
 $('complete').hidden=done!==120||!filter();
}
function lines(s){return s.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)}
function edit(){current().status='未確認';navigation();changed()}
function textArea(value,rows,label,onInput){
 const a=el('textarea');a.rows=rows;a.value=value;a.setAttribute('aria-label',label);a.addEventListener('input',()=>onInput(a.value));return a;
}
function render(){
 const t=template(),r=current();$('editor').hidden=false;
 $('figure-title').textContent=t.figureId+'　'+t.rotation+'°（時計回り）';
 $('silhouette').replaceChildren(drawing(t));
 $('grouped').replaceChildren(drawing(t,true,true));
 $('relations').replaceChildren(...t.relations.map(v=>el('p','',v)));
 $('whole').value=r.whole;$('whole-basis').value=r.wholeBasis.join('\n');$('note').value=r.note;
 const parts=$('parts');parts.replaceChildren();
 t.parts.forEach((p,i)=>{
  const x=r.parts[i],section=el('section','part'),head=el('div','part-head');
  const swatch=svgEl('svg',{viewBox:'0 0 12 12',width:12,height:12,'aria-hidden':'true'});
  swatch.append(svgEl('rect',{x:0,y:0,width:12,height:12,rx:2,fill:colors[i%colors.length]}));
  head.append(swatch,el('strong','',p.id+'　'+p.shapeName+'　'+p.areaPercent+'%'),el('span','facts','（'+p.members.join('+')+'）'));section.append(head);
  const facts=el('div','facts'),w=Math.round(p.bbox[2]/t.size[0]*100),h=Math.round(p.bbox[3]/t.size[1]*100);
  facts.append(el('p','','全体に対する外接幅 '+w+'%・高さ '+h+'%'+(p.tipDirection?'・頂点 '+p.tipDirection+'向き':'')));
  if(p.contacts.length)facts.append(el('p','',p.contacts.map(c=>c.part+'：'+c.direction+'側').join(' ／ ')));
  section.append(facts,el('label','','形・位置の説明'),textArea(x.description,2,p.id+' 形・位置の説明',v=>{x.description=v;edit()}),
   el('label','','部分の見立て（1行につき1候補、空欄可）'),textArea(x.candidates.join('\n'),Math.max(2,Math.min(4,x.candidates.length)),p.id+' 見立て',v=>{x.candidates=lines(v);edit()}));
  parts.append(section);
 });
 navigation();
}
function go(id){if(!byId(id)||id===currentId)return;currentId=id;render();changed()}
function advance(status){
 const r=current();r.status=status;
 const index=results.indexOf(r);
 const next=results.slice(index+1).find(x=>!complete(x))||results.slice(0,index).find(x=>!complete(x));
 if(next)currentId=next.id;
 render();changed();
}
function step(delta){
 const list=visible();const index=list.findIndex(r=>r.id===currentId);const next=list[index+delta];if(next)go(next.id);
}
$('whole').addEventListener('input',()=>{current().whole=$('whole').value;edit()});
$('whole-basis').addEventListener('input',()=>{current().wholeBasis=lines($('whole-basis').value);edit()});
$('note').addEventListener('input',()=>{current().note=$('note').value;edit()});
$('prev').addEventListener('click',()=>step(-1));$('next').addEventListener('click',()=>step(1));
$('confirm').addEventListener('click',()=>advance('確認済み'));$('needs').addEventListener('click',()=>advance('要修正'));
$('pending-only').addEventListener('change',()=>{
 const list=visible();if(list.length&&!list.includes(current()))go(list[0].id);else navigation();
});
function download(v,name){const u=URL.createObjectURL(new Blob([JSON.stringify(v,null,2)],{type:'application/json'}));const a=el('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
function backup(){download({...snapshot(),schemaVersion:data.schemaVersion},'tangram-orientation-unsaved.json')}
$('retry').addEventListener('click',()=>void flush());$('backup').addEventListener('click',backup);
$('reload').addEventListener('click',()=>{backup();clearStash();location.reload()});
$('export').addEventListener('click',async()=>{if(!ready)return;if(!await flush())return;const a=el('a');a.href='/api/export';a.download='tangram-orientation-review-results.json';a.click()});
$('import-toggle').addEventListener('click',()=>{$('import-panel').hidden=!$('import-panel').hidden});
$('import-apply').addEventListener('click',async()=>{
 const file=$('import-file').files[0];if(!file||!ready)return;
 $('import-apply').disabled=true;$('editor').inert=true;$('figure-nav').inert=true;
 try{
  if(!await flush())throw Error('先に現在の編集を保存してください。');
  const document=JSON.parse(await file.text());
  if(document.sourceSha256!==data.sourceSha256||document.schemaVersion!==data.schemaVersion)throw Error('このページで書き出した同じ版のJSONを指定してください。');
  if(!window.confirm('保存済みの確認結果を置き換えます。直前の版はバックアップされます。よろしいですか？'))return;
  saved=await api('/api/import',{revision:saved.revision,document});results=copy(saved.results);currentId=saved.currentId;dirty=false;clearStash();render();info('取り込み・保存済み');$('import-status').textContent='全120方向の確認結果を読み込みました。';
 }catch(e){$('import-status').textContent=e.message}
 finally{$('import-apply').disabled=false;$('editor').inert=false;$('figure-nav').inert=false}
});
(async()=>{
 try{
  [data,saved]=await Promise.all([api('/api/data'),api('/api/state')]);results=copy(saved.results);currentId=saved.currentId;
  let pending;try{pending=JSON.parse(localStorage.getItem(key)||'null')}catch{}
  if(pending&&pending.sourceSha256===data.sourceSha256){
   if(equal(pending,saved))clearStash();
   else if(Array.isArray(pending.results)&&pending.results.length===results.length&&byId(pending.currentId)){
    results=copy(pending.results);currentId=pending.currentId;dirty=true;conflict=pending.revision!==saved.revision;
   }
  }
  ready=true;render();
  if(conflict)info('別の保存版があります。未保存データを退避してください。',true);
  else if(dirty){info('未保存の編集を復元しました。保存中…');void flush()}
  else info('Macの保存データを読み込みました');
 }catch(e){info('読み込みに失敗しました: '+e.message,true)}
})();
