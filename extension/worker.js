import {songIdFromUrl, normalizeShareUrl, safeFilename} from './urls.js';
import {ACTIVE, PENDING, loadState, clearLiveHandles, markRecoverable, pruneJobs, portableState} from './state.js';
import {bootstrapState} from './bootstrap-state.js';

const RETRYABLE = new Set(['INTEGRITY_FAILED', 'BUFFER_ERROR', 'BUFFER_ABORT', 'SOURCE_REPLACED', 'STALLED', 'TIMEOUT', 'NEEDS_RELOAD']);
const FOCUS_LIMIT = 4000, ALIAS_LIFETIME = 30 * 86400000;
const focusTimers = new Map();
let database, loading, chain = Promise.resolve(), writes = Promise.resolve(), lastProgressWrite = 0;
const serial = fn => { const task = chain.then(fn); chain = task.catch(() => {}); return task; };
const safe = promise => { void promise.catch(error => console.warn('Suno Saver:', error.message)); };
async function db() {
  if (database) return database;
  loading ||= Promise.all([chrome.storage.session.get(['sunoSessionV3', 'sunoJobsV2']), chrome.storage.local.get(['sunoStateV3', 'sunoHistoryV2', 'sunoAutoWarmupV2'])]).then(async ([session, local]) => {
    const sessionToken = session.sunoSessionV3 || crypto.randomUUID();
    if (!session.sunoSessionV3) await chrome.storage.session.set({sunoSessionV3: sessionToken});
    const seed = local.sunoStateV3?.version === 3 ? local.sunoStateV3 : bootstrapState || {jobs: session.sunoJobsV2 || [], history: local.sunoHistoryV2 || []};
    database = loadState(seed, sessionToken);
    if (local.sunoAutoWarmupV2 === undefined && typeof bootstrapState?.settings?.sunoAutoWarmupV2 === 'boolean') await chrome.storage.local.set({sunoAutoWarmupV2: bootstrapState.settings.sunoAutoWarmupV2});
    return database;
  });
  return loading;
}
async function persist(progressOnly = false) {
  const data = await db();
  if (progressOnly && Date.now() - lastProgressWrite < 1000) return;
  lastProgressWrite = Date.now();
  data.jobs = pruneJobs(data.jobs);
  const snapshot = structuredClone(data);
  const write = writes.then(() => chrome.storage.local.set({sunoStateV3: snapshot}));
  writes = write.catch(() => {});
  await write;
  const count = data.jobs.filter(j => j.phase === 'queued' || ACTIVE.has(j.phase)).length;
  await chrome.action.setBadgeText({text: count ? String(count) : ''});
  await chrome.action.setBadgeBackgroundColor({color: '#C95732'});
}
async function history(job) {
  const data = await db();
  const entry = clearLiveHandles({...job});
  data.history = [entry, ...data.history.filter(j => j.songId !== job.songId)].slice(0, 30);
}
async function closeTaskTab(job) {
  await restoreFocus(job);
  const id = job.tabId; delete job.tabId;
  if (Number.isInteger(id)) {
    try {
      const tab = await chrome.tabs.get(id);
      const url = tab.url || tab.pendingUrl || '';
      const ownSong = job.songId && songIdFromUrl(url) === job.songId;
      const openingPage = url === 'about:blank' || url === job.requestedUrl || url === job.url || url.startsWith('https://suno.com/auth/');
      if (ownSong || openingPage) await chrome.tabs.remove(id);
    } catch {}
  }
}
async function restoreFocus(job) {
  const timer = focusTimers.get(job.id);
  if (timer !== undefined) clearTimeout(timer);
  focusTimers.delete(job.id);
  await chrome.alarms.clear(`suno-focus-${job.id}`);
  if (!job.warming) return;
  job.warming = false;
  try {
    const task = await chrome.tabs.get(job.tabId);
    if (job.focusAbandoned || !task.active || songIdFromUrl(task.url || '') !== job.songId || !Number.isInteger(job.returnTabId) || job.returnTabId === job.tabId) return;
    const previous = await chrome.tabs.get(job.returnTabId);
    if (previous.windowId === task.windowId) await chrome.tabs.update(previous.id, {active: true});
  } catch {}
}
function scheduleFocusReturn(job) {
  const timer = focusTimers.get(job.id);
  if (timer !== undefined) clearTimeout(timer);
  const nonce = job.nonce;
  const deadline = job.warmupAt + FOCUS_LIMIT;
  // Deliberately outside the message queue: a stuck renderer/script injection
  // must not hold the user's foreground tab hostage.
  focusTimers.set(job.id, setTimeout(() => safe((async () => {
    if (!job.warming || job.nonce !== nonce) return;
    await restoreFocus(job); await persist();
  })()), Math.max(0, deadline - Date.now())));
  safe(chrome.alarms.create(`suno-focus-${job.id}`, {when: deadline}));
}
async function warmTaskTab(job) {
  const {sunoAutoWarmupV2 = true} = await chrome.storage.local.get('sunoAutoWarmupV2');
  if (!sunoAutoWarmupV2) return;
  const task = await chrome.tabs.get(job.tabId);
  const [previous] = await chrome.tabs.query({active: true, windowId: task.windowId});
  if (previous?.id === task.id) return;
  job.returnTabId = previous?.id; job.warming = true; job.warmupAt = Date.now(); job.warmWindowId = task.windowId; job.focusAbandoned = false;
  scheduleFocusReturn(job);
  await chrome.tabs.update(task.id, {active: true});
}
async function fail(job, message, code = 'TASK_FAILED') {
  job.phase = 'error'; job.message = message; job.code = code; job.finishedAt = Date.now();
  await closeTaskTab(job); await persist(); await pump();
}
async function pump() {
  const data = await db();
  if (data.jobs.some(j => ACTIVE.has(j.phase))) return;
  const job = data.jobs.find(j => j.phase === 'queued');
  if (!job) return;
  job.phase = 'opening'; job.startedAt = Date.now(); job.lastSeenAt = Date.now();
  job.nonce = crypto.randomUUID(); job.progress = 0; job.bytes = 0;
  await persist();
  try {
    const tab = await chrome.tabs.create({url: 'about:blank', active: false});
    job.tabId = tab.id; await persist();
    await chrome.tabs.update(tab.id, {muted: true, autoDiscardable: false, url: job.url});
  } catch (error) { await fail(job, `无法打开保存任务：${error.message}`, 'TAB_FAILED'); }
}
async function enqueue(url, title = '') {
  url = normalizeShareUrl(url);
  const data = await db(), requestedUrl = url;
  const alias = data.aliases[url];
  if (alias && Date.now() - alias.at < ALIAS_LIFETIME) url = alias.url;
  const songId = songIdFromUrl(url);
  const existing = data.jobs.find(j => (songId ? j.songId === songId : j.url === url) && (ACTIVE.has(j.phase) || j.phase === 'queued'));
  if (existing) return {job: existing, duplicate: true};
  const completed = await savedSong(songId);
  if (completed) return {job: completed, duplicate: true};
  const recovered = data.jobs.find(j => j.phase === 'recoverable' && (songId ? j.songId === songId : j.url === url || j.requestedUrl === requestedUrl));
  if (recovered) { await resumeJob(recovered); await persist(); await pump(); return {job: recovered, resumed: true, duplicate: false}; }
  if (data.jobs.filter(j => PENDING.has(j.phase)).length >= 20) throw new Error('已有 20 首待处理歌曲，请先完成或取消一些任务。');
  const job = {id: crypto.randomUUID(), url, requestedUrl, songId, title: String(title).slice(0, 200), phase: 'queued', mode: 'fast', attempts: 1, progress: 0, createdAt: Date.now(), message: ''};
  data.jobs.push(job); await persist(); await pump();
  return {job, duplicate: false};
}
async function savedSong(songId, exceptId) {
  if (!songId) return null;
  const data = await db(), seen = new Set();
  for (const job of [...data.jobs, ...data.history]) {
    if (job.id === exceptId || job.songId !== songId || job.phase !== 'done' || !Number.isInteger(job.downloadId) || seen.has(job.downloadId)) continue;
    seen.add(job.downloadId);
    const [item] = await chrome.downloads.search({id: job.downloadId});
    if (item?.exists && item.state === 'complete' && (item.fileSize < 0 || item.fileSize === undefined || item.fileSize === job.bytes)) return job;
  }
  return null;
}
async function reuseSaved(job, completed) {
  for (const key of ['songId', 'title', 'bytes', 'duration', 'capturedSeconds', 'integrity', 'downloadId', 'filename', 'savedPath']) if (completed[key] !== undefined) job[key] = completed[key];
  job.phase = 'done'; job.progress = 100; job.reused = true; job.finishedAt = Date.now(); job.message = '这首歌已经保存，没有重复下载。';
  await history(job); await closeTaskTab(job); await persist(); await pump();
}
async function resumeJob(job) {
  if (job.previousPhase === 'saving' && Number.isInteger(job.downloadId)) {
    const [item] = await chrome.downloads.search({id: job.downloadId});
    if (item && ['complete', 'in_progress'].includes(item.state) && item.exists !== false && (item.state !== 'complete' || item.fileSize === job.bytes)) {
      job.phase = 'saving'; job.savingAt = Date.now(); job.lastSeenAt = Date.now(); delete job.previousPhase;
      await reconcileDownload(job); return;
    }
  }
  clearLiveHandles(job);
  for (const key of ['downloadId', 'savedPath', 'integrity', 'code', 'fallbackReason', 'finishedAt', 'savingAt', 'previousPhase', 'reused']) delete job[key];
  Object.assign(job, {phase: 'queued', mode: 'fast', attempts: 1, progress: 0, bytes: 0, chunks: 0, capturedSeconds: 0, elapsed: 0, resumedAt: Date.now(), message: ''});
}
async function bindAndStart(job, tab) {
  const id = songIdFromUrl(tab.url || '');
  if (!id || tab.status !== 'complete') return;
  if (job.songId && job.songId !== id) {
    await fail(job, '页面进入了另一首歌曲，已停止保存。请检查歌曲链接后重试。', 'WRONG_SONG'); return;
  }
  const data = await db();
  job.songId = id; job.url = normalizeShareUrl(tab.url);
  if (job.requestedUrl && !songIdFromUrl(job.requestedUrl)) {
    data.aliases[job.requestedUrl] = {url: job.url, at: Date.now()};
    const aliases = Object.entries(data.aliases).sort((a, b) => b[1].at - a[1].at).slice(0, 300);
    data.aliases = Object.fromEntries(aliases);
  }
  const completed = await savedSong(id, job.id);
  if (completed) { await reuseSaved(job, completed); return; }
  for (const other of data.jobs) {
    if (other.id !== job.id && other.songId === id && ['queued', 'recoverable'].includes(other.phase)) {
      other.phase = 'merged'; other.mergedInto = job.id; other.finishedAt = Date.now();
    }
  }
  job.phase = 'armed'; job.lastSeenAt = Date.now();
  await persist();
  try {
    await warmTaskTab(job);
    await persist();
    await chrome.scripting.executeScript({target: {tabId: job.tabId}, files: ['content.js']});
    await chrome.tabs.sendMessage(job.tabId, {type: 'bind-job', nonce: job.nonce});
    await chrome.scripting.executeScript({target: {tabId: job.tabId}, world: 'MAIN', files: ['integrity.js', 'collector.js', 'capture.js']});
    const [{result}] = await chrome.scripting.executeScript({target: {tabId: job.tabId}, world: 'MAIN', args: [{songId: id, nonce: job.nonce, mode: job.mode}], func: config => window.SunoSaverV2.start(config)});
    if (result?.phase === 'error') await receiveState(job, result);
  } catch (error) { await fail(job, `无法启动保存：${error.message}`, 'INJECTION_FAILED'); }
}
async function maybeStartJob(job) {
  if (job.phase !== 'opening') return;
  // about:blank has no URL without broad tabs permission. Completed events can
  // also be stale by the time our serialized handler runs. Read current state
  // and wait through blank, share-link and session-recovery intermediate pages.
  let tab;
  try { tab = await chrome.tabs.get(job.tabId); } catch { return; }
  await bindAndStart(job, tab);
}
async function receiveState(job, input) {
  if (!input || typeof input !== 'object' || !ACTIVE.has(job.phase) || job.phase === 'saving') return;
  const phases = new Set(['armed', 'capturing', 'validating', 'ready', 'error', 'cancelled']);
  if (!phases.has(input.phase)) return;
  job.lastSeenAt = Date.now();
  for (const k of ['bytes', 'chunks', 'duration', 'capturedSeconds', 'elapsed', 'seeks']) if (Number.isFinite(input[k]) && input[k] >= 0) job[k] = input[k];
  job.progress = Math.max(0, Math.min(99, Number(input.progress) || 0));
  if (input.title) job.title = String(input.title).slice(0, 200);
  job.autoplayBlocked = input.autoplayBlocked === true;
  if (job.warming && (input.playbackStarted || Date.now() - job.warmupAt >= FOCUS_LIMIT)) await restoreFocus(job);
  if (input.phase === 'error') {
    if (job.mode === 'fast' && job.attempts < 2 && RETRYABLE.has(input.code)) {
      job.fallbackReason = String(input.message || '加速采集未通过检查'); job.message = '正在使用兼容方式重试';
      await closeTaskTab(job); job.phase = 'queued'; job.mode = 'normal'; job.attempts++; await persist(); await pump(); return;
    }
    await fail(job, String(input.message || '保存失败，请重试。').slice(0, 400), String(input.code || 'CAPTURE_FAILED')); return;
  }
  if (input.phase === 'cancelled') { job.phase = 'cancelled'; job.finishedAt = Date.now(); await closeTaskTab(job); await persist(); await pump(); return; }
  if (input.phase === 'ready') {
    if (!/^blob:https:\/\/suno\.com\/[0-9a-f-]{36}$/i.test(input.objectUrl || '') || !input.integrity?.valid || !Number.isSafeInteger(input.bytes) || input.bytes < 1024 || input.bytes > 64 * 1024 * 1024 || !Number.isFinite(input.duration) || input.duration < 1) {
      await fail(job, '收到的音频没有通过下载检查。', 'INVALID_RESULT'); return;
    }
    job.integrity = input.integrity; job.phase = 'saving'; job.progress = 100; job.savingAt = Date.now();
    job.filename = safeFilename(job.title, job.songId); await persist();
    try {
      job.downloadId = await chrome.downloads.download({url: input.objectUrl, filename: job.filename, saveAs: false, conflictAction: 'uniquify'});
      await persist(); await reconcileDownload(job);
    } catch (error) { await fail(job, `Chrome 未能保存文件：${error.message}`, 'DOWNLOAD_FAILED'); }
    return;
  }
  job.phase = input.phase; await persist(true);
}
async function reconcileDownload(job) {
  if (!Number.isInteger(job.downloadId) || job.phase !== 'saving') return;
  const [item] = await chrome.downloads.search({id: job.downloadId});
  if (!item) return;
  if (item.state === 'interrupted') { await fail(job, `下载未完成：${item.error || '已中断'}`, 'DOWNLOAD_INTERRUPTED'); return; }
  if (item.state !== 'complete') return;
  if (item.exists === false || (item.fileSize >= 0 && item.fileSize !== job.bytes)) { await fail(job, '磁盘文件大小与音频不符，未标记为保存成功。', 'FILE_MISMATCH'); return; }
  job.phase = 'done'; job.finishedAt = Date.now(); job.message = ''; job.savedPath = item.filename;
  await history(job); await closeTaskTab(job); await persist(); await pump();
}
async function list() {
  const data = await db();
  const ids = new Set(data.jobs.map(j => j.id));
  const jobs = [...data.jobs, ...data.history.filter(j => !ids.has(j.id))].filter(j => j.phase !== 'merged').sort((a, b) => b.createdAt - a.createdAt).slice(0, 80);
  return {jobs, recoverableCount: jobs.filter(j => j.phase === 'recoverable').length};
}
async function currentSong(tabId) {
  const tab = tabId ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({active: true, currentWindow: true}))[0];
  if (!tab?.id || !tab.url?.startsWith('https://suno.com/')) return null;
  try { return await chrome.tabs.sendMessage(tab.id, {type: 'current-song'}); }
  catch { return songIdFromUrl(tab.url) ? {url: tab.url, title: (tab.title || '').replace(/ by .* \| Suno$/, '')} : null; }
}
async function action(request, sender) {
  const data = await db();
  if (request.type === 'list') return list();
  if (request.type === 'current') return currentSong(sender.tab?.id);
  if (request.type === 'enqueue') return enqueue(request.url, request.title);
  if (request.type === 'resume-pending') {
    for (const job of data.jobs.filter(j => j.phase === 'recoverable')) await resumeJob(job);
    await persist(); await pump(); return list();
  }
  if (request.type === 'export-state') return {...portableState(data), exportedAt: Date.now(), settings: await chrome.storage.local.get('sunoAutoWarmupV2')};
  if (request.type === 'capture-state') {
    const job = data.jobs.find(j => j.tabId === sender.tab?.id && j.nonce === request.nonce);
    if (job && songIdFromUrl(sender.url || '') === job.songId) await receiveState(job, request.state);
    return {};
  }
  let job = data.jobs.find(j => j.id === request.id) || data.history.find(j => j.id === request.id);
  if (job?.phase === 'merged') job = data.jobs.find(j => j.id === job.mergedInto) || job;
  if (!job) throw new Error('没有找到这个任务。');
  if (request.type === 'cancel') {
    if (job.phase === 'done') return {};
    job.phase = 'cancelled'; job.finishedAt = Date.now();
    if (Number.isInteger(job.downloadId)) { try { await chrome.downloads.cancel(job.downloadId); } catch {} }
    await closeTaskTab(job); await persist(); await pump(); return {};
  }
  if (request.type === 'retry') {
    if (ACTIVE.has(job.phase) || job.phase === 'queued') return {job, duplicate: true};
    if (job.phase === 'recoverable') { await resumeJob(job); await persist(); await pump(); return {job, resumed: true}; }
    return enqueue(job.url, job.title);
  }
  if (request.type === 'show-file' && job.phase === 'done' && Number.isInteger(job.downloadId)) { await chrome.downloads.show(job.downloadId); return {}; }
  if (request.type === 'open-task' && Number.isInteger(job.tabId)) { await chrome.tabs.update(job.tabId, {active: true}); return {}; }
  throw new Error('这个任务暂不支持该操作。');
}
function trusted(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.url?.startsWith(chrome.runtime.getURL(''))) return true;
  try { return new URL(sender.url).origin === 'https://suno.com'; } catch { return false; }
}
chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (!trusted(sender)) return;
  serial(() => action(request, sender)).then(result => reply({ok: true, result}), error => reply({ok: false, error: error.message}));
  return true;
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'complete' && !change.url) return;
  safe(serial(async () => {
    const job = (await db()).jobs.find(j => j.tabId === tabId && j.phase === 'opening');
    if (job) await maybeStartJob(job);
  }));
});
chrome.tabs.onRemoved.addListener(tabId => safe(serial(async () => {
  const job = (await db()).jobs.find(j => j.tabId === tabId && ACTIVE.has(j.phase));
  if (job) { delete job.tabId; job.phase = 'cancelled'; job.message = '任务页已关闭'; job.finishedAt = Date.now(); await persist(); await pump(); }
})));
chrome.tabs.onActivated.addListener(info => safe((async () => {
  const data = await db();
  for (const job of data.jobs) {
    if (job.warming && info.windowId === job.warmWindowId && info.tabId !== job.tabId) {
      job.focusAbandoned = true; await restoreFocus(job); await persist();
    }
  }
})()));
chrome.downloads.onChanged.addListener(delta => safe(serial(async () => {
  const job = (await db()).jobs.find(j => j.downloadId === delta.id && j.phase === 'saving');
  if (job) await reconcileDownload(job);
})));
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith('suno-focus-')) {
    safe((async () => { const job = (await db()).jobs.find(j => alarm.name === `suno-focus-${j.id}`); if (job?.warming) { await restoreFocus(job); await persist(); } })());
    return;
  }
  if (alarm.name !== 'suno-watchdog') return;
  safe(serial(async () => {
    const active = (await db()).jobs.filter(j => ACTIVE.has(j.phase));
    for (const job of active) {
      if (job.phase === 'saving') {
        await reconcileDownload(job);
        if (job.phase === 'saving' && Date.now() - (job.savingAt || job.lastSeenAt) > 180000) await fail(job, 'Chrome 长时间未完成下载，请检查浏览器下载列表后重试。', 'DOWNLOAD_TIMEOUT');
        continue;
      }
      try { await chrome.tabs.get(job.tabId); }
      catch { await fail(job, '任务页已经关闭，请重试。', 'TAB_CLOSED'); continue; }
      if (job.phase === 'opening') await maybeStartJob(job);
      if (ACTIVE.has(job.phase) && Date.now() - job.lastSeenAt > 110000) await fail(job, job.phase === 'opening' ? '歌曲页长时间未加载完成，请确认 Suno 已登录、链接可打开后重试。' : '任务长时间没有响应，请检查 Suno 登录状态后重试。', 'WATCHDOG');
    }
    await pump();
  }));
});
chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'suno-save-link') safe(serial(() => enqueue(info.linkUrl || info.pageUrl)));
});
chrome.commands.onCommand.addListener(command => {
  if (command === 'save-current') safe(serial(async () => { const song = await currentSong(); if (song) await enqueue(song.url, song.title); }));
});
async function initialize() {
  await chrome.alarms.create('suno-watchdog', {periodInMinutes: 0.5});
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({id: 'suno-save-link', title: '保存这首 Suno 歌曲', contexts: ['link'], targetUrlPatterns: ['https://suno.com/song/*', 'https://suno.com/s/*']});
  const data = await db();
  for (const job of data.jobs) {
    if (job.warming) scheduleFocusReturn(job);
    if (job.phase === 'recoverable' && job.previousPhase === 'saving' && Number.isInteger(job.downloadId)) {
      const [item] = await chrome.downloads.search({id: job.downloadId});
      if (item?.state === 'complete' && item.exists && item.fileSize === job.bytes) await resumeJob(job);
    }
  }
  await persist(); await pump();
}
chrome.runtime.onInstalled.addListener(() => safe(serial(initialize)));
safe(serial(initialize));
