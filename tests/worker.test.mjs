import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {songIdFromUrl,normalizeShareUrl,safeFilename} from '../extension/urls.js';
import {ACTIVE,PENDING,loadState,clearLiveHandles,markRecoverable,pruneJobs,portableState} from '../extension/state.js';
const ID='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ID2='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const URL1=`https://suno.com/song/${ID}`,URL2=`https://suno.com/song/${ID2}`;
const script=fs.readFileSync(new URL('../extension/worker.js',import.meta.url),'utf8').replace(/^import[^;]+;/gm,'');
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},emit(...args){for(const fn of this.listeners)fn(...args);}});
const tick=()=>new Promise(r=>setTimeout(r,5));
async function setup(saved={session:{},local:{}},tabs=new Map(),options={}){
 let mockNow=options.now??null;class TestDate extends Date{static now(){return mockNow??Date.now();}}
 let next=Math.max(9,...tabs.keys())+1,timerId=1,blockedScript=false;const timers=new Map(),alarms=new Map(),scriptWaiters=[];
 const downloads=options.downloads||new Map(),calls=[];const userTabs=new Map([[1,{id:1,windowId:1,active:true,url:'https://suno.com/create'}],[2,{id:2,windowId:1,active:false,url:'https://example.test/'}]]);
 const area=kind=>({get:async key=>{const keys=Array.isArray(key)?key:typeof key==='string'?[key]:Object.keys(saved[kind]);return structuredClone(Object.fromEntries(keys.map(k=>[k,saved[kind][k]])));},set:async values=>Object.assign(saved[kind],structuredClone(values))});
 const chrome={storage:{session:area('session'),local:area('local')},runtime:{id:'extension-test',getURL:path=>'chrome-extension://extension-test/'+path,onMessage:event(),onInstalled:event()},
 action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},alarms:{create:async(name,info)=>alarms.set(name,info),clear:async name=>alarms.delete(name),onAlarm:event()},contextMenus:{removeAll:async()=>{},create:()=>{},onClicked:event()},commands:{onCommand:event()},
 tabs:{onUpdated:event(),onRemoved:event(),onActivated:event(),create:async props=>{const t={id:next++,windowId:1,...props};tabs.set(t.id,t);calls.push(['create',t.id]);return t;},get:async id=>{const tab=tabs.get(id)||userTabs.get(id);if(!tab)throw Error('no tab');return tab;},update:async(id,p)=>{const tab=tabs.get(id)||userTabs.get(id);if(!tab)throw Error('no tab');if(p.active)for(const other of [...tabs.values(),...userTabs.values()])other.active=false;Object.assign(tab,p);calls.push(['update',id,p]);if(p.active)chrome.tabs.onActivated.emit({tabId:id,windowId:tab.windowId});return tab;},remove:async id=>{tabs.delete(id);calls.push(['remove',id]);chrome.tabs.onRemoved.emit(id);},query:async()=>[...tabs.values(),...userTabs.values()].filter(t=>t.active),sendMessage:async()=>({ok:true})},
 scripting:{executeScript:async props=>{calls.push(['script',props]);if(blockedScript){blockedScript=false;await new Promise(resolve=>scriptWaiters.push(resolve));}return [{result:{phase:'armed'}}];}},
 downloads:{onChanged:event(),download:async props=>{const id=Math.max(0,...downloads.keys())+1;downloads.set(id,{id,state:'in_progress',exists:true,filename:props.filename});calls.push(['download',props]);return id;},search:async({id})=>downloads.has(id)?[downloads.get(id)]:[],cancel:async id=>{if(downloads.has(id))downloads.get(id).state='interrupted';},show:async id=>calls.push(['show',id])}};
 const setTimer=(fn,ms)=>{const id=timerId++;timers.set(id,{fn,at:TestDate.now()+ms});return id;};
 function advance(ms){mockNow=(mockNow??Date.now())+ms;for(const [id,t] of [...timers])if(t.at<=mockNow){timers.delete(id);t.fn();}}
 vm.runInNewContext(script,{chrome,crypto,URL,Date:TestDate,console,songIdFromUrl,normalizeShareUrl,safeFilename,ACTIVE,PENDING,loadState,clearLiveHandles,markRecoverable,pruneJobs,portableState,bootstrapState:options.bootstrapState||null,structuredClone,setTimeout:setTimer,clearTimeout:id=>timers.delete(id),Promise,Set,Map,Number});await tick();advance(0);await tick();
 function rpc(request,sender={id:'extension-test',url:'chrome-extension://extension-test/popup.html'}){return new Promise(resolve=>chrome.runtime.onMessage.listeners[0](request,sender,resolve));}
 async function job(){const jobs=(await rpc({type:'list'})).result.jobs;return jobs.find(j=>ACTIVE.has(j.phase))||jobs.find(j=>j.phase==='queued')||jobs.find(j=>j.phase!=='done');}
 async function load(id,waitForState=true){const j=id?(await rpc({type:'list'})).result.jobs.find(j=>j.id===id):await job();const tab=tabs.get(j.tabId);tab.status='complete';chrome.tabs.onUpdated.emit(j.tabId,{status:'complete'},tab);await tick();return waitForState?job():undefined;}
 async function status(state,override={}){const j=await job();return rpc({type:'capture-state',nonce:j.nonce,state},{id:'extension-test',url:j.url,tab:{id:j.tabId},...override});}
 return {chrome,rpc,job,load,status,saved,tabs,userTabs,downloads,calls,timers,alarms,advance,blockScript:()=>{blockedScript=true;},releaseScripts:()=>scriptWaiters.splice(0).forEach(fn=>fn())};
}
const ready={phase:'ready',title:'验收歌',bytes:3823287,duration:213.2,progress:100,objectUrl:'blob:https://suno.com/11111111-1111-1111-1111-111111111111',integrity:{valid:true,duration:213.2065,fragments:107}};
test('粘贴链接直接建立静音后台任务，无需准备操作',async()=>{const r=await setup();assert.equal((await r.rpc({type:'enqueue',url:URL1})).ok,true);const j=await r.job();assert.equal(j.phase,'opening');assert.equal(r.tabs.get(j.tabId).active,false);assert.equal(r.tabs.get(j.tabId).muted,true);});
test('重复点击只会有一个任务',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});const second=await r.rpc({type:'enqueue',url:URL1});assert.equal(second.result.duplicate,true);assert.equal(r.tabs.size,1);});
test('同时排队按顺序处理，不并发播放多首',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.rpc({type:'enqueue',url:URL2});assert.equal(r.tabs.size,1);assert.equal((await r.rpc({type:'list'})).result.jobs.filter(j=>j.phase==='queued').length,1);});
test('校验通过自动发起保存，但不提前宣称完成',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();await r.status(ready);assert.equal((await r.job()).phase,'saving');assert.equal(r.calls.filter(c=>c[0]==='download').length,1);assert.equal(r.calls.find(c=>c[0]==='download')[1].saveAs,false);});
test('只有浏览器确认完整文件落盘才算完成',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();await r.status(ready);Object.assign(r.downloads.get(1),{state:'complete',fileSize:ready.bytes});r.chrome.downloads.onChanged.emit({id:1,state:{current:'complete'}});await tick();const jobs=(await r.rpc({type:'list'})).result.jobs;assert.equal(jobs[0].phase,'done');assert.equal(r.tabs.size,0);assert.equal(r.saved.local.sunoStateV3.history.length,1);});
test('文件已保存时再次点击不会重新采集，删除文件后则允许重新保存',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();await r.status(ready);Object.assign(r.downloads.get(1),{state:'complete',fileSize:ready.bytes});r.chrome.downloads.onChanged.emit({id:1});await tick();const duplicate=await r.rpc({type:'enqueue',url:URL1});assert.equal(duplicate.result.duplicate,true);assert.equal(duplicate.result.job.phase,'done');assert.equal(r.tabs.size,0);r.downloads.get(1).exists=false;const next=await r.rpc({type:'enqueue',url:URL1});assert.equal(next.result.duplicate,false);assert.equal(next.result.job.phase,'opening');assert.equal(r.tabs.size,1);});
test('文件大小不符时不能显示保存成功',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();await r.status(ready);Object.assign(r.downloads.get(1),{state:'complete',fileSize:111});r.chrome.downloads.onChanged.emit({id:1});await tick();assert.equal((await r.job()).code,'FILE_MISMATCH');});
test('加速完整性失败，只自动降速重试一次',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();await r.status({phase:'error',code:'INTEGRITY_FAILED',message:'缺段'});let j=await r.job();assert.equal(j.mode,'normal');assert.equal(j.attempts,2);await r.load();await r.status({phase:'error',code:'INTEGRITY_FAILED',message:'仍缺段'});j=await r.job();assert.equal(j.phase,'error');assert.equal(r.tabs.size,0);});
test('不接受来自其他标签页的伪造完成消息',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();await r.status(ready,{tab:{id:999}});assert.equal(r.downloads.size,0);});
test('不接受外站或远程音频 URL 作为完成结果',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();await r.status({...ready,objectUrl:'https://example.com/private'});assert.equal(r.downloads.size,0);assert.equal((await r.job()).code,'INVALID_RESULT');});
test('取消任务关闭自己的后台页，并启动下一首',async()=>{const r=await setup();const first=(await r.rpc({type:'enqueue',url:URL1})).result.job;await r.rpc({type:'enqueue',url:URL2});await r.rpc({type:'cancel',id:first.id});const jobs=(await r.rpc({type:'list'})).result.jobs;assert.equal(jobs.find(j=>j.id===first.id).phase,'cancelled');assert.equal(jobs.find(j=>j.songId===ID2).phase,'opening');assert.equal(r.tabs.size,1);});
test('service worker 重启后恢复已有任务，不再开一页',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();const second=await setup(r.saved,r.tabs);assert.equal((await second.job()).phase,'armed');assert.equal(second.calls.filter(c=>c[0]==='create').length,0);});
test('错过歌曲页加载事件时，定时检查可以恢复启动而不新建标签页',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});const j=await r.job();r.tabs.get(j.tabId).status='complete';r.chrome.alarms.onAlarm.emit({name:'suno-watchdog'});await tick();assert.equal((await r.job()).phase,'armed');assert.equal(r.calls.filter(c=>c[0]==='create').length,1);});
test('短链接在加载完成后绑定真实歌曲 ID',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:'https://suno.com/s/DemoShareLink001'});let j=await r.job();r.tabs.get(j.tabId).url=URL1;await r.load();j=await r.job();assert.equal(j.songId,ID);});
test('权限隐藏的空白页完成事件不结束任务，等待真正歌曲页',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});const j=await r.job(),tab=r.tabs.get(j.tabId);delete tab.url;tab.status='complete';r.chrome.tabs.onUpdated.emit(j.tabId,{status:'complete'},{id:j.tabId,status:'complete'});await tick();assert.equal((await r.job()).phase,'opening');assert.equal(r.calls.filter(c=>c[0]==='script').length,0);tab.url=URL1;await r.load();assert.equal((await r.job()).phase,'armed');});
test('空白页旧快照不能覆盖正在导航的实时标签页状态',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});const j=await r.job(),tab=r.tabs.get(j.tabId);tab.status='loading';r.chrome.tabs.onUpdated.emit(j.tabId,{status:'complete'},{id:j.tabId});await tick();assert.equal((await r.job()).phase,'opening');assert.equal(r.calls.filter(c=>c[0]==='script').length,0);await r.load();assert.equal((await r.job()).phase,'armed');});
test('会话恢复和分享页中转后 SPA 进入歌曲页再启动，且只启动一次',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:'https://suno.com/s/DemoShareLink001'});const j=await r.job(),tab=r.tabs.get(j.tabId);for(const url of ['about:blank','https://suno.com/auth/session-recovery?redirect=%2Fs%2FDemoShareLink001','https://suno.com/s/DemoShareLink001']){tab.url=url;await r.load();assert.equal((await r.job()).phase,'opening');}tab.url=URL1;r.chrome.tabs.onUpdated.emit(j.tabId,{url:URL1},{...tab});r.chrome.tabs.onUpdated.emit(j.tabId,{status:'complete'},{...tab});await tick();assert.equal((await r.job()).phase,'armed');assert.equal(r.calls.filter(c=>c[0]==='script'&&c[1].func).length,1);});
test('歌曲页事件也必须核对最新状态，不能用旧快照注入正在跳转的页面',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});const j=await r.job(),tab=r.tabs.get(j.tabId);tab.url='https://suno.com/auth/session-recovery';tab.status='loading';r.chrome.tabs.onUpdated.emit(j.tabId,{status:'complete'},{id:j.tabId,url:URL1,status:'complete'});await tick();assert.equal((await r.job()).phase,'opening');assert.equal(r.calls.filter(c=>c[0]==='script').length,0);});
test('直接歌曲链接被跳到另一首时不保存错误的歌',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});const j=await r.job();r.tabs.get(j.tabId).url=URL2;await r.load();assert.equal((await r.job()).code,'WRONG_SONG');assert.equal(r.calls.filter(c=>c[0]==='script').length,0);});
test('链接规范化拒绝外站、脚本和账号页面',()=>{for(const u of ['javascript:alert(1)','https://suno.com.evil.test/song/'+ID,'https://user:password@suno.com/song/'+ID,'https://suno.com/account'])assert.throws(()=>normalizeShareUrl(u));assert.equal(normalizeShareUrl(URL1+'?extra=ignore'),URL1);});
test('中文文件名保持可读并阻止路径穿越',()=>{const name=safeFilename('../歌名/秘密\n:?',ID);assert.ok(name.startsWith('Suno/'));assert.equal(name.split('/').length,2);assert.ok(!name.includes('..'));assert.ok(name.endsWith('.m4a'));});
test('发布代码没有网络导出或计费调用',()=>{for(const file of ['worker.js','capture.js','collector.js','content.js']){const code=fs.readFileSync(new URL('../extension/'+file,import.meta.url),'utf8');assert.doesNotMatch(code,/\bfetch\s*\(|XMLHttpRequest|\/api\/billing\/|\/convert_wav\/|\/api\/download\//);}});

test('仅在歌曲加载完毕后短暂显示任务页，播放启动后返回原页面',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});let j=await r.job();assert.equal(r.userTabs.get(1).active,true);await r.load();j=await r.job();assert.equal(r.tabs.get(j.tabId).active,true);assert.equal(r.tabs.get(j.tabId).muted,true);await r.status({phase:'capturing',bytes:10000,playbackStarted:true});assert.equal(r.userTabs.get(1).active,true);assert.equal(r.tabs.get(j.tabId).active,false);});
test('用户已切到别处时，不强行把焦点切回旧页面',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();await r.chrome.tabs.update(2,{active:true});await r.status({phase:'capturing',bytes:10000,playbackStarted:true});assert.equal(r.userTabs.get(2).active,true);assert.equal(r.userTabs.get(1).active,false);});
test('启动失败或取消也会归还页面焦点',async()=>{for(const cancel of [true,false]){const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();if(cancel)await r.rpc({type:'cancel',id:(await r.job()).id});else await r.status({phase:'error',code:'PLAYBACK_ERROR',message:'test'});assert.equal(r.userTabs.get(1).active,true);assert.equal(r.tabs.size,0);}});
test('关闭自动启动切换选项后始终保持后台',async()=>{const r=await setup({session:{},local:{sunoAutoWarmupV2:false}});await r.rpc({type:'enqueue',url:URL1});await r.load();const j=await r.job();assert.equal(r.userTabs.get(1).active,true);assert.equal(r.tabs.get(j.tabId).active,false);});

test('即使播放器启动较慢，也会在四秒上限后归还原页面',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();r.advance(4100);await r.status({phase:'armed',elapsed:4.1});assert.equal(r.userTabs.get(1).active,true);assert.equal((await r.job()).phase,'armed');});
test('原页面被用户关闭时不误判保存失败',async()=>{const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();r.userTabs.delete(1);await r.status({phase:'capturing',bytes:10000,playbackStarted:true});assert.equal((await r.job()).phase,'capturing');});

test('网页完全不再回报状态，也会独立归还焦点',async()=>{
 const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();
 r.advance(4100);await tick();
 assert.equal(r.userTabs.get(1).active,true);assert.equal(r.timers.size,0);
 assert.equal((await r.job()).warming,false);
});
test('注入脚本未返回、消息队列阻塞时，焦点计时仍然有效',async()=>{
 const r=await setup();await r.rpc({type:'enqueue',url:URL1});r.blockScript();
 await r.load(undefined,false);
 try {r.advance(4100);await tick();assert.equal(r.userTabs.get(1).active,true);}
 finally {r.releaseScripts();await tick();}
});
test('worker 在启动阶段重启后，过期的焦点期限立即处理',async()=>{
 const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();
 const warmupAt=(await r.job()).warmupAt;
 const s=await setup(r.saved,r.tabs,{now:warmupAt+6000});
 assert.equal(s.userTabs.get(1).active,true);assert.equal(s.calls.filter(c=>c[0]==='create').length,0);
});
test('用户离开后主动回来查看任务页，不会再被自动切走',async()=>{
 const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();const id=(await r.job()).tabId;
 await r.chrome.tabs.update(2,{active:true});await tick();await r.chrome.tabs.update(id,{active:true});
 r.advance(5000);await tick();assert.equal(r.tabs.get(id).active,true);
});
test('短链解析到已完成歌曲后，不再启动采集或下载',async()=>{
 const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.rpc({type:'enqueue',url:'https://suno.com/s/share123'});
 await r.load();await r.status(ready);Object.assign(r.downloads.get(1),{state:'complete',fileSize:ready.bytes});r.chrome.downloads.onChanged.emit({id:1});await tick();
 const next=await r.job();r.tabs.get(next.tabId).url=URL1;await r.load();
 const jobs=(await r.rpc({type:'list'})).result.jobs;
 assert.equal(jobs.filter(j=>j.phase==='done').length,2);assert.equal(r.downloads.size,1);assert.equal(r.tabs.size,0);
 assert.equal(r.calls.filter(c=>c[0]==='script'&&c[1].func).length,1);
 const again=await r.rpc({type:'enqueue',url:'https://suno.com/s/share123'});assert.equal(again.result.duplicate,true);assert.equal(r.tabs.size,0);
 r.downloads.get(1).exists=false;const removed=await r.rpc({type:'enqueue',url:'https://suno.com/s/share123'});assert.equal(removed.result.duplicate,false);assert.equal(removed.result.job.url,URL1);
});
test('短链先入队、长链随后入队时，解析后合并同一首任务',async()=>{
 const r=await setup();await r.rpc({type:'enqueue',url:'https://suno.com/s/share123'});const redundant=(await r.rpc({type:'enqueue',url:URL1})).result.job;
 const first=await r.job();r.tabs.get(first.tabId).url=URL1;await r.load();
 const jobs=(await r.rpc({type:'list'})).result.jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].songId,ID);
 await r.rpc({type:'cancel',id:redundant.id});assert.equal(r.tabs.size,0);assert.equal((await r.job()).phase,'cancelled');
});
test('清空会话后保留未完成队列，等待用户继续，绝不使用旧标签页 ID',async()=>{
 const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.rpc({type:'enqueue',url:URL2});
 const reusedTabs=new Map([[10,{id:10,windowId:1,url:'https://unrelated.test/',active:false}]]);
 const s=await setup({session:{},local:r.saved.local},reusedTabs);
 const recovered=(await s.rpc({type:'list'})).result;
 assert.equal(recovered.recoverableCount,2);assert.equal(s.calls.filter(c=>['create','remove','update'].includes(c[0])).length,0);
 for(const j of recovered.jobs){assert.equal(j.phase,'recoverable');assert.equal(j.tabId,undefined);assert.equal(j.nonce,undefined);}
 await s.rpc({type:'resume-pending'});assert.equal(s.calls.filter(c=>c[0]==='create').length,1);assert.ok(s.tabs.has(10));
 const jobs=(await s.rpc({type:'list'})).result.jobs;assert.equal(jobs.filter(j=>j.phase==='opening').length,1);assert.equal(jobs.filter(j=>j.phase==='queued').length,1);
 await s.rpc({type:'resume-pending'});assert.equal(s.calls.filter(c=>c[0]==='create').length,1);
});
test('再次粘贴待恢复歌曲时，恢复原任务而不新增重复记录',async()=>{
 const r=await setup();const old=(await r.rpc({type:'enqueue',url:URL1})).result.job;
 const s=await setup({session:{},local:r.saved.local});const resumed=await s.rpc({type:'enqueue',url:URL1});
 assert.equal(resumed.result.job.id,old.id);assert.equal(resumed.result.resumed,true);assert.equal((await s.rpc({type:'list'})).result.jobs.length,1);
});
test('恢复记录可以取消，不创建或关闭任何用户标签页',async()=>{
 const r=await setup();await r.rpc({type:'enqueue',url:URL1});const s=await setup({session:{},local:r.saved.local});
 await s.rpc({type:'cancel',id:(await s.job()).id});assert.equal((await s.job()).phase,'cancelled');assert.equal(s.calls.filter(c=>['create','remove'].includes(c[0])).length,0);
});
test('重启期间已经落盘的文件直接确认完成，不重复采集',async()=>{
 const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();await r.status(ready);Object.assign(r.downloads.get(1),{state:'complete',fileSize:ready.bytes});
 const s=await setup({session:{},local:r.saved.local},new Map(),{downloads:r.downloads});
 const jobs=(await s.rpc({type:'list'})).result.jobs;assert.equal(jobs[0].phase,'done');assert.equal(s.calls.filter(c=>c[0]==='create').length,0);assert.equal(s.downloads.size,1);
});
test('仍在进行的 Chrome 文件写入恢复后继续等待完成，不新建采集',async()=>{
 const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();await r.status(ready);
 const s=await setup({session:{},local:r.saved.local},new Map(),{downloads:r.downloads});await s.rpc({type:'resume-pending'});
 assert.equal((await s.job()).phase,'saving');assert.equal(s.calls.filter(c=>c[0]==='create').length,0);
 Object.assign(s.downloads.get(1),{state:'complete',fileSize:ready.bytes});s.chrome.downloads.onChanged.emit({id:1});await tick();assert.equal((await s.rpc({type:'list'})).result.jobs[0].phase,'done');
});
test('迁移备份不包含旧标签页句柄和采集口令，新安装导入后等待继续',async()=>{
 const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();const backup=(await r.rpc({type:'export-state'})).result;
 for(const key of ['tabId','returnTabId','nonce','warming'])assert.equal(backup.jobs[0][key],undefined);
 const s=await setup({session:{},local:{}},new Map(),{bootstrapState:backup});assert.equal((await s.job()).phase,'recoverable');assert.equal(s.tabs.size,0);
 await s.rpc({type:'cancel',id:(await s.job()).id});const t=await setup(s.saved,s.tabs,{bootstrapState:backup});assert.equal((await t.job()).phase,'cancelled');
});
test('存储中的非法地址被丢弃，不会导航到外站',async()=>{
 const s=await setup({session:{},local:{sunoStateV3:{version:3,jobs:[{id:crypto.randomUUID(),phase:'queued',url:'https://evil.test/song/'+ID}],history:[]}}});
 assert.equal((await s.rpc({type:'list'})).result.jobs.length,0);assert.equal(s.tabs.size,0);
});
test('用户把任务页导航到别处后，取消任务不关闭或切走该页面',async()=>{
 const r=await setup();await r.rpc({type:'enqueue',url:URL1});await r.load();const j=await r.job(),tabId=j.tabId;
 await r.chrome.tabs.update(tabId,{url:'https://example.test/draft'});r.advance(4100);await tick();
 assert.equal(r.tabs.get(tabId).active,true);await r.rpc({type:'cancel',id:j.id});assert.ok(r.tabs.has(tabId));
});
