import {normalizeShareUrl, songIdFromUrl} from './urls.js';

export const ACTIVE = new Set(['opening', 'armed', 'capturing', 'validating', 'saving']);
export const PENDING = new Set([...ACTIVE, 'queued', 'recoverable']);
const PHASES = new Set([...PENDING, 'done', 'error', 'cancelled', 'merged']);
const NUMBER_FIELDS = ['createdAt', 'startedAt', 'finishedAt', 'lastSeenAt', 'savingAt', 'resumedAt', 'bytes', 'chunks', 'duration', 'capturedSeconds', 'elapsed', 'seeks', 'progress'];
const STRING_FIELDS = ['message', 'code', 'fallbackReason', 'filename', 'savedPath', 'mergedInto', 'previousPhase'];

export function clearLiveHandles(job) {
  for (const key of ['tabId', 'nonce', 'objectUrl', 'returnTabId', 'warming', 'warmupAt', 'warmWindowId', 'focusAbandoned']) delete job[key];
  return job;
}

export function markRecoverable(job) {
  if (job.phase !== 'recoverable') job.previousPhase = job.phase;
  clearLiveHandles(job);
  job.phase = 'recoverable'; job.progress = 0; job.autoplayBlocked = false;
  job.message = '上次任务未完成，继续后会从头重新保存。';
  return job;
}

export function cleanJob(raw, live = false) {
  if (!raw || typeof raw !== 'object' || !PHASES.has(raw.phase)) return null;
  let url;
  try { url = normalizeShareUrl(raw.url); } catch { return null; }
  const id = typeof raw.id === 'string' && /^[a-z0-9-]{8,100}$/i.test(raw.id) ? raw.id : crypto.randomUUID();
  const declaredId = typeof raw.songId === 'string' ? songIdFromUrl(`https://suno.com/song/${raw.songId}`) : null;
  const job = {id, url, songId: songIdFromUrl(url) || declaredId, phase: raw.phase, title: String(raw.title || '').slice(0, 200), createdAt: Date.now(), mode: raw.mode === 'normal' ? 'normal' : 'fast', attempts: raw.attempts === 2 ? 2 : 1, progress: 0};
  try { job.requestedUrl = normalizeShareUrl(raw.requestedUrl || raw.url); } catch { job.requestedUrl = url; }
  for (const key of NUMBER_FIELDS) if (Number.isFinite(raw[key]) && raw[key] >= 0) job[key] = raw[key];
  for (const key of STRING_FIELDS) if (typeof raw[key] === 'string') job[key] = raw[key].slice(0, 1000);
  if (Number.isSafeInteger(raw.downloadId) && raw.downloadId >= 0) job.downloadId = raw.downloadId;
  if (raw.integrity?.valid === true) {
    job.integrity = {valid: true};
    for (const key of ['duration', 'expectedDuration', 'fragments', 'samples', 'payloadBytes', 'bytes', 'timescale', 'removedInitBoxes']) {
      if (Number.isFinite(raw.integrity[key]) && raw.integrity[key] >= 0) job.integrity[key] = raw.integrity[key];
    }
  }
  if (raw.reused === true) job.reused = true;
  if (job.phase === 'done' && !Number.isInteger(job.downloadId)) { job.phase = 'error'; job.message = '旧记录缺少下载信息，请重新保存。'; }
  if (live) {
    for (const key of ['tabId', 'returnTabId', 'warmWindowId']) if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) job[key] = raw[key];
    for (const key of ['warming', 'focusAbandoned', 'autoplayBlocked']) job[key] = raw[key] === true;
    if (Number.isFinite(raw.warmupAt)) job.warmupAt = raw.warmupAt;
    if (typeof raw.nonce === 'string' && /^[a-z0-9-]{8,100}$/i.test(raw.nonce)) job.nonce = raw.nonce;
  }
  return job;
}

export function loadState(raw = {}, sessionToken) {
  const sameSession = raw?.version === 3 && raw.sessionToken === sessionToken;
  const readJobs = values => (Array.isArray(values) ? values : []).slice(-200).map(j => cleanJob(j, sameSession)).filter(Boolean);
  const jobs = readJobs(raw.jobs);
  for (const job of jobs) {
    if ((ACTIVE.has(job.phase) || job.phase === 'queued') && !sameSession) markRecoverable(job);
    else if (ACTIVE.has(job.phase) && job.phase !== 'saving' && (!Number.isInteger(job.tabId) || !job.nonce)) markRecoverable(job);
  }
  const aliases = Object.create(null);
  for (const [key, value] of Object.entries(raw.aliases || {}).slice(-300)) {
    try {
      const share = normalizeShareUrl(key), target = normalizeShareUrl(value.url);
      if (!songIdFromUrl(share) && songIdFromUrl(target) && Number.isFinite(value.at)) aliases[share] = {url: target, at: value.at};
    } catch {}
  }
  return {version: 3, sessionToken, jobs, history: readJobs(raw.history).filter(j => j.phase === 'done').map(clearLiveHandles).slice(0, 30), aliases};
}

export function pruneJobs(jobs) {
  const pending = jobs.filter(j => PENDING.has(j.phase));
  const terminal = jobs.filter(j => !PENDING.has(j.phase)).sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt)).slice(0, 40);
  return [...pending, ...terminal].sort((a, b) => a.createdAt - b.createdAt);
}

export function portableState(data) {
  return {version: 3, jobs: data.jobs.map(j => cleanJob(j)).filter(Boolean), history: data.history.map(j => cleanJob(j)).filter(Boolean), aliases: data.aliases};
}
