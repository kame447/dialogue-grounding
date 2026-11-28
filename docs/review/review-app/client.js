'use strict';
const $ = id => document.getElementById(id);
const model = RegionEditorModel;
const colors = ['#5d99d0','#e7b365','#76b6a1','#c69bd8','#e48c87','#8cadd5','#d4c16a','#a2b5c1'];
const svgNS = 'http://www.w3.org/2000/svg';
let data, saved, results, currentId, dirty=false, saving=null, conflict=false;
const key = 'dialogue-grounding:figure-review:pending:v1';
const clone = value => JSON.parse(JSON.stringify(value));
const snapshot = () => ({dataSha256:data.dataSha256,revision:saved.revision,currentFigureId:currentId,results:clone(results)});
const index = () => data.items.findIndex(item => item.figureId===currentId);
const item = () => data.items[index()];
const row = () => results[index()];
const exactDone = status => status==='確認済み'||status==='user_specified'||status==='confirmed'||status==='確認';
const reported = status => status==='前回確認済み（分割未取得）';
function info(message,warn=false){
 $('save-status').textContent=message;$('save-status').classList.toggle('warn',warn);
 $('retry').hidden=!warn||conflict;$('backup').hidden=!warn;$('reload-saved').hidden=!conflict;
}
function stash(){
 try{localStorage.setItem(key,JSON.stringify(snapshot()));return true}catch{return false}
}
function clearStash(){try{localStorage.removeItem(key)}catch{}}
function sameState(a,b){return a.currentFigureId===b.currentFigureId&&JSON.stringify(a.results)===JSON.stringify(b.results)}
async function api(path,body){
 const res=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const json=await res.json();if(!res.ok){const e=Error(json.error||'通信に失敗しました');e.status=res.status;throw e}return json;
}
function changed(){
 dirty=true;stash();info('保存中…');void flush();
}
function flush(){
 if(saving)return saving;
 if(conflict)return Promise.resolve(false);
 if(!dirty)return Promise.resolve(true);
 saving=(async()=>{
  while(dirty){
   dirty=false;const outgoing=snapshot();
   try{
    saved=await api('/api/state',outgoing);
    if(!dirty){results=clone(saved.results);currentId=saved.currentFigureId;clearStash();renderNav();info('Macに保存済み · '+new Date(saved.updatedAt).toLocaleTimeString('ja-JP'))}
    else stash();
   }catch(e){
    dirty=true;conflict=e.status===409;const kept=stash();
    info('保存できませんでした: '+e.message+(kept?'（ブラウザに一時退避済み）':''),true);return false;
   }
  }
  return true;
 })().finally(()=>{saving=null});
 return saving;
}
function node(tag,attrs={}){
 const el=document.createElementNS(svgNS,tag);
 for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));
 return el;
}
function outlinePath(it,mask){
 const c=it.candidates.find(c=>c.mask===mask);
 if(!c)throw Error('輪郭がありません');
 return c.outlines.map(loop=>loop.map((p,i)=>(i?'L':'M')+it.points[p].join(' ')).join(' ')+' Z').join(' ');
}
function draw(target,it,mode,groups){
 const [w,h]=it.size,pad=Math.max(w,h)*.065;
 const svg=node('svg',{viewBox:[-pad,-pad,w+2*pad,h+2*pad].join(' '),role:'img','aria-label':it.figureId+' '+mode});
 const add=(d,fill,stroke,width)=>svg.append(node('path',{d,fill,stroke,'stroke-width':width,'stroke-linejoin':'round','fill-rule':'evenodd'}));
 const edge=Math.max(w,h)/220;
 if(mode==='silhouette')add(outlinePath(it,it.wholeMask),'#293544','#293544',edge);
 else if(mode==='pieces'){
  for(const a of it.atoms){
   const d=a.polygon.map((p,i)=>(i?'L':'M')+p.join(' ')).join(' ')+' Z';
   add(d,'#dce6ef','#52677b',edge);
   const center=a.polygon.reduce((v,p)=>[v[0]+p[0]/a.polygon.length,v[1]+p[1]/a.polygon.length],[0,0]);
   const label=node('text',{x:center[0],y:center[1],'font-size':Math.max(w,h)*.048,'text-anchor':'middle','dominant-baseline':'central',fill:'#172d40'});
   label.textContent=a.id;svg.append(label);
  }
  if(it.cut){
   const [a,b]=it.cut.endpoints;
   svg.append(node('line',{x1:a[0],y1:a[1],x2:b[0],y2:b[1],stroke:'#b33c31','stroke-width':edge*2,'stroke-dasharray':(edge*4)+' '+(edge*3)}));
  }
 }else{
  groups.forEach((g,i)=>add(outlinePath(it,model.mask(it,g)),colors[i%colors.length],'#fff',edge*1.5));
  add(outlinePath(it,it.wholeMask),'none','#34485a',edge);
 }
 $(target).replaceChildren(svg);
}
function renderNav(){
 const confirmed=results.filter(r=>exactDone(r.status)).length,prior=results.filter(r=>reported(r.status)).length;
 $('progress').textContent='確定 '+confirmed+' / 30　前回確認済み・式未取得 '+prior;
 const nav=$('figure-nav');nav.replaceChildren();
 results.forEach(r=>{
  const b=document.createElement('button');b.textContent=r.figureId;b.title=r.status;
  b.className=(r.figureId===currentId?'active ':'')+(exactDone(r.status)?'done':reported(r.status)?'reported':r.status==='要再確認'||r.status==='修正あり'?'revise':'');
  b.addEventListener('click',()=>go(r.figureId));nav.append(b);
 });
 $('figure-status').textContent=row().status;
}
function check(){
 try{const groups=model.parse(item(),row().draft);$('error').textContent='';$('confirm').disabled=false;return groups}
 catch(e){$('error').textContent=e.message+'（直前の有効な分割を表示しています）';$('confirm').disabled=true;return null}
}
function render(){
 $('editor').hidden=false;
 const it=item(),r=row();$('figure-title').textContent=it.figureId+' / F30';
 $('expression').value=r.draft;$('note').value=r.note;
 $('cut-note').textContent=it.cut?'切断した元ピース: '+it.cut.sourcePiece+'（破線）　'+(it.note||''):'';
 draw('silhouette',it,'silhouette',r.groups);draw('pieces',it,'pieces',r.groups);draw('grouped',it,'grouped',r.groups);
 check();renderNav();$('prev').disabled=index()===0;$('next').disabled=index()===29;
}
function go(id){if(id===currentId)return;currentId=id;render();changed()}
$('expression').addEventListener('input',()=>{
 row().draft=$('expression').value;row().status='未確認';
 const g=check();if(g){row().groups=g;draw('grouped',item(),'grouped',g)}renderNav();changed();
});
$('note').addEventListener('input',()=>{row().note=$('note').value;row().status='修正あり';renderNav();changed()});
$('prev').addEventListener('click',()=>{if(index()>0)go(data.items[index()-1].figureId)});
$('next').addEventListener('click',()=>{if(index()<29)go(data.items[index()+1].figureId)});
$('confirm').addEventListener('click',()=>{
 const groups=check();if(!groups)return;
 row().groups=groups;row().draft=model.format(item(),groups);row().status='確認済み';
 if(index()<29)currentId=data.items[index()+1].figureId;
 render();changed();
});
$('retry').addEventListener('click',()=>void flush());
function download(value,name){
 const url=URL.createObjectURL(new Blob([value],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function downloadBackup(){download(JSON.stringify({reviewId:saved.reviewId,dataSha256:data.dataSha256,results,currentFigureId:currentId},null,2),'tangram-review-unsaved.json')}
$('backup').addEventListener('click',downloadBackup);
$('reload-saved').addEventListener('click',()=>{downloadBackup();clearStash();location.reload()});
$('export').addEventListener('click',async()=>{
 if(!saved)return;
 if(!await flush()){info('未保存のため、退避ボタンから現在の編集をJSONで保存してください。',true);return}
 const a=document.createElement('a');a.href='/api/export';a.download='tangram-review-results.json';a.click();
});
$('import-toggle').addEventListener('click',()=>{$('import-panel').hidden=!$('import-panel').hidden});
$('import-file').addEventListener('change',async()=>{const f=$('import-file').files[0];if(f)$('import-text').value=await f.text()});
$('import-apply').addEventListener('click',async()=>{
 const raw=$('import-text').value;if(!raw.trim())return;
 $('import-apply').disabled=true;$('editor').inert=true;$('figure-nav').inert=true;
 try{
  if(!await flush())throw Error('先に現在の編集を保存してください。');
  const parsed=model.importResults(data,raw,results);
  if(!window.confirm(parsed.importedCount+'図形の確認結果を読み込みます。現在の内容はバックアップされます。'))return;
  const imported=await api('/api/import',{revision:saved.revision,text:raw});
  saved=imported.state;results=clone(saved.results);currentId=saved.currentFigureId;dirty=false;clearStash();
  render();info('取り込み・保存済み');$('import-status').textContent=imported.importedCount+'図形を取り込みました。'+(imported.cutUpdatedIds.length?'切断変更のある図形は再確認してください: '+imported.cutUpdatedIds.join('、'):'');
 }catch(e){$('import-status').textContent=e.message}
 finally{$('import-apply').disabled=false;$('editor').inert=false;$('figure-nav').inert=false}
});
(async()=>{
 try{
  [data,saved]=await Promise.all([api('/api/data'),api('/api/state')]);results=clone(saved.results);currentId=saved.currentFigureId;
  let pending=null;try{pending=JSON.parse(localStorage.getItem(key)||'null')}catch{}
  if(pending&&pending.dataSha256===data.dataSha256){
   if(sameState(pending,saved)){clearStash()}
   else if(pending.revision===saved.revision){results=clone(pending.results);currentId=pending.currentFigureId;dirty=true}
   else{
    results=clone(pending.results);currentId=pending.currentFigureId;dirty=true;conflict=true;
   }
  }
  render();
  if(conflict)info('別の保存版があります。未保存データをJSONで退避してからページを開き直してください。',true);
  else if(dirty){info('未保存の編集を復元しました。保存中…');void flush()}
  else info('Macの保存データを読み込みました');
 }catch(e){info('読み込み失敗: '+e.message,true)}
})();
