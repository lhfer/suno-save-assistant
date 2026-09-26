import {normalizeShareUrl, songIdFromUrl} from './urls.js';
const $ = id => document.getElementById(id);
let current, jobs = [], busy = false, refreshing = false, renderedJobs = null;
const active = new Set(['opening','armed','capturing','validating','saving','queued']);
const labels = {queued:'排队中',opening:'打开歌曲',armed:'准备中',capturing:'正在保存',validating:'检查完整性',saving:'写入文件',done:'已保存',error:'保存失败',cancelled:'已取消',recoverable:'待继续'};
const time = value => `${Math.floor((value||0)/60)}:${String(Math.floor((value||0)%60)).padStart(2,'0')}`;
async function send(request) { const r = await chrome.runtime.sendMessage(request); if (!r?.ok) throw new Error(r?.error || '插件未能完成操作。'); return r.result; }
function error(text = '') { $('error').textContent = text; $('error').hidden = !text; }
function feedback(text = '') { $('feedback').textContent = text; $('feedback').hidden = !text; }
function element(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
function addAction(parent, text, type, job) {
  const b = element('button','',text); b.type = 'button';
  b.onclick = async () => { b.disabled = true; error(); try { await send({type,id:job.id}); await refresh(); } catch(e) { error(e.message); } finally { b.disabled = false; } };
  parent.append(b);
}
function render() {
  $('song-title').textContent = current?.title || (current ? '当前 Suno 歌曲' : '选择一首歌曲');
  $('song-hint').textContent = current ? '自动启动后切回原页面，全程静音，完成后自动保存。' : '在 Suno 歌曲旁点「保存」，或粘贴链接。';
  $('save-current').disabled = !current || busy;
  const currentJob = jobs.find(j=>j.songId && j.songId === songIdFromUrl(current?.url));
  $('save-current').textContent = busy ? '正在加入…' : currentJob?.phase === 'done' ? '已保存 · 显示文件' : currentJob?.phase === 'recoverable' ? '继续保存这首歌' : currentJob && active.has(currentJob.phase) ? '已在保存队列中' : '保存这首歌';
  const recovered = jobs.filter(j=>j.phase === 'recoverable');
  $('recovery-panel').hidden = !recovered.length;
  $('recovery-title').textContent = `上次有 ${recovered.length} 首未完成`;
  $('resume-pending').textContent = `继续保存 ${recovered.length} 首`;
  $('resume-pending').disabled = busy;
  const live = jobs.filter(j=>active.has(j.phase));
  $('task-count').textContent = live.length ? `${live.length} 首处理中` : jobs.length ? '最近任务' : '';
  const fingerprint = JSON.stringify(jobs);
  if (fingerprint === renderedJobs) return;
  renderedJobs = fingerprint;
  const list = $('task-list'); list.replaceChildren();
  if (!jobs.length) { list.append(element('p','empty','还没有任务。选好歌曲，点一次保存即可。')); return; }
  const seen = new Set(live.map(j=>j.songId || j.url));
  const recent = jobs.filter(j=>{const key=j.songId || j.url;if(active.has(j.phase)||seen.has(key))return false;seen.add(key);return true;});
  const ordered = [...live.slice().reverse(), ...recent].slice(0,8);
  for (const job of ordered) {
    const row = element('article','task');
    const head = element('div','task-head'); head.append(element('p','task-name',job.title || '正在识别歌曲…'),element('span',`phase ${job.phase}`,job.autoplayBlocked ? '等待播放' : labels[job.phase])); row.append(head);
    let note = job.message || '';
    if (job.phase === 'queued') note = job.mode === 'normal' ? '已切换兼容方式，准备重新保存。' : '前面的任务完成后自动开始。';
    if (job.phase === 'opening' || job.phase === 'armed') note = job.mode === 'normal' ? '兼容方式 · 后台静音处理' : '正在准备后台歌曲页';
    if (job.phase === 'armed' && job.elapsed >= 5) note = `等待播放器就绪 · 已等待 ${Math.floor(job.elapsed)} 秒`;
    if (job.phase === 'capturing') note = `${time(job.capturedSeconds)} / ${time(job.duration)} · ${(job.bytes/1048576).toFixed(1)} MB${job.mode==='normal'?' · 兼容方式':''}`;
    if (job.phase === 'done') note = `${time(job.duration + 0.5)} · ${(job.bytes/1048576).toFixed(1)} MB · M4A${job.finishedAt && job.startedAt ? ` · 用时 ${Math.max(1,Math.round((job.finishedAt-job.startedAt)/1000))} 秒` : ''}`;
    if (job.phase === 'done' && job.reused) note = `${time(job.duration + 0.5)} · ${(job.bytes/1048576).toFixed(1)} MB · 已存在，没有重复下载`;
    if (job.phase === 'recoverable') note = '上次任务未完成，继续后从头重新保存。';
    if (job.phase === 'validating') note = '核对片段顺序、完整时长和文件大小。';
    if (job.phase === 'saving') note = '音频检查通过，等待 Chrome 保存完成。';
    if (job.autoplayBlocked && active.has(job.phase)) note = '浏览器等待一次播放操作，请打开任务页后点播放。';
    row.append(element('p','task-note',note));
    if (active.has(job.phase) && job.phase !== 'queued') { const track = element('div','track'), fill=element('div','fill'); fill.style.width=`${job.progress||0}%`; track.append(fill); track.setAttribute('role','progressbar');track.setAttribute('aria-label',`保存 ${job.title||'歌曲'}`);track.setAttribute('aria-valuenow',String(job.progress||0));track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');row.append(track); }
    const actions = element('div','task-actions');
    if (active.has(job.phase)) { if (job.tabId) addAction(actions,'打开任务页','open-task',job); addAction(actions,'取消','cancel',job); }
    if (job.phase === 'done') addAction(actions,'在文件夹中显示','show-file',job);
    if (job.phase === 'error' || job.phase === 'cancelled') addAction(actions,'重试','retry',job);
    if (job.phase === 'recoverable') { addAction(actions,'继续保存','retry',job); addAction(actions,'取消','cancel',job); }
    row.append(actions); list.append(row);
  }
}
async function refresh() {
  if (refreshing) return; refreshing=true;
  try { jobs=(await send({type:'list'})).jobs; render(); } catch(e) { error(e.message); } finally { refreshing=false; }
}
async function queue(url,title) {
  if (busy) return; busy=true; error(); feedback();render();
  try {
    const result=await send({type:'enqueue',url:normalizeShareUrl(url),title});
    feedback(result.duplicate ? (result.job.phase==='done'?'这首歌已经保存，可在任务中显示文件。':'这首歌已经在队列中。') : result.resumed ? '已继续上次任务，将从头重新保存。' : '已加入队列，完成后自动保存。');
    if(result.duplicate&&result.job.phase==='done') await send({type:'show-file',id:result.job.id});
    $('share-url').value=''; await refresh();
  } catch(e) { error(e.message); } finally {busy=false;render();}
}
$('save-current').onclick=()=>current&&queue(current.url,current.title);
$('link-form').onsubmit=e=>{e.preventDefault();void queue($('share-url').value);};
$('share-url').addEventListener('paste',e=>{const value=e.clipboardData?.getData('text');if(!value)return;e.preventDefault();$('share-url').value=value;void queue(value);});
$('resume-pending').onclick=async()=>{busy=true;error();render();try{await send({type:'resume-pending'});feedback('已继续未完成任务，完成后自动保存。');await refresh();}catch(e){error(e.message);}finally{busy=false;render();}};
$('backup-records').onclick=async()=>{
  const button=$('backup-records');button.disabled=true;error();
  try {
    const data=await send({type:'export-state'});
    const stamp=new Date().toISOString().slice(0,19).replaceAll(':','-');
    await chrome.downloads.download({url:'data:application/json;charset=utf-8,'+encodeURIComponent(JSON.stringify(data,null,2)),filename:`Suno/任务记录-${stamp}.json`,saveAs:true});
    feedback('已交给 Chrome 保存任务记录。');
  }catch(e){error(e.message);}finally{button.disabled=false;}
};
(async()=>{try{current=await send({type:'current'});await refresh();}catch(e){error(e.message);}render();})();
const interval=setInterval(refresh,1000);window.addEventListener('pagehide',()=>clearInterval(interval));
