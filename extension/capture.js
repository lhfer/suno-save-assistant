(() => {
  'use strict';
  globalThis.SunoSaverV2 = {start};
  function start(config) {
    const id = location.pathname.match(/^\/song\/([0-9a-f-]{36})\/?$/i)?.[1]?.toLowerCase();
    if (location.hostname !== 'suno.com' || id !== config.songId) return {phase: 'error', code: 'WRONG_PAGE', message: '没有进入目标歌曲页。'};
    const previous = window.__SUNO_SAVER_V2_JOB__;
    if (previous?.nonce === config.nonce) return previous.snapshot();
    previous?.dispose();
    const audio = () => document.getElementById('active-audio-play');
    const first = audio();
    if (first?.currentSrc?.startsWith('blob:') && first.buffered.length) return {phase: 'error', code: 'NEEDS_RELOAD', message: '音频已经加载，需要重新准备。'};
    if (typeof MediaSource === 'undefined' || typeof SourceBuffer === 'undefined') return {phase: 'error', code: 'UNSUPPORTED_BROWSER', message: '浏览器不支持当前音频格式。'};
    const started = Date.now();
    const title = document.querySelector('h1')?.textContent?.trim() || document.title.replace(/ by .* \| Suno$/, '').trim() || 'Suno 歌曲';
    let state = {phase: 'armed', bytes: 0, chunks: 0, duration: 0, capturedSeconds: 0};
    let timer, url = null, integrity = null, collector, finished = false, lastPublish = 0, lastSeek = 0;
    let lastBytes = 0, lastByteAt = started, playRequestedAt = 0, playbackAttempts = 0, startedPlayback = false, autoplayBlocked = false;
    let previousAudio = null, oldMuted = false, oldRate = 1, oldVolume = 1, seeks = 0;
    let mode = config.mode === 'normal' ? 'normal' : 'fast';
    const playingId = () => document.querySelector('a[aria-label^="Playbar: Title for"]')?.getAttribute('href')?.match(/\/song\/([0-9a-f-]{36})/i)?.[1]?.toLowerCase();
    function snapshot() {
      const a = audio();
      return {...state, captureVersion: '0.3.0', title, songId: id, elapsed: (Date.now() - started) / 1000, mode, seeks, playbackAttempts, autoplayBlocked,
        playbackStarted: !!a?.played?.length && a.currentTime > 0 && a.readyState >= 2,
        diagnostics: {visibility: document.visibilityState, elementMuted: a?.muted, elementVolume: a?.volume, hasAudio: !!a, hasSource: !!a?.currentSrc, readyState: a?.readyState, paused: a?.paused, currentTime: a?.currentTime, playingTarget: playingId() === id, pagePlay: !!document.querySelector('button[aria-label="Play"]'), barPlay: !!document.querySelector('button[aria-label="Playbar: Play button"]')},
        progress: state.phase === 'ready' ? 100 : state.duration > 0 ? Math.min(99, Math.floor(state.capturedSeconds / state.duration * 100)) : 0,
        objectUrl: url, integrity};
    }
    function publish(force = false) {
      if (!force && Date.now() - lastPublish < 650) return;
      lastPublish = Date.now();
      window.postMessage({source: 'SUNO_SAVER_V2', nonce: config.nonce, state: snapshot()}, location.origin);
    }
    function releasePlayer() {
      clearInterval(timer);
      document.removeEventListener('encrypted', onEncrypted, true);
      const a = previousAudio;
      if (a) { a.pause(); a.playbackRate = oldRate; a.muted = oldMuted; a.volume = oldVolume; }
    }
    function stop() { if (finished) return; finished = true; releasePlayer(); }
    function cancel() { collector?.cancel(); stop(); publish(true); }
    function dispose() { cancel(); if (url) URL.revokeObjectURL(url); url = null; }
    // Suno also seeks while initializing/resynchronizing playback. A seeking
    // event cannot identify user intent. Missing audio is rejected by the final
    // fragment timeline, sample-byte and full-duration checks instead.
    function onEncrypted(event) { if (event.target === audio()) collector.fail('播放器启用了受保护媒体。', 'PROTECTED_MEDIA'); }
    function prepareAudio(a) {
      if (previousAudio !== a) { previousAudio = a; oldMuted = a.muted; oldRate = a.playbackRate; oldVolume = a.volume; }
      // The worker mutes the entire Chrome tab BEFORE navigation. Muting the
      // element as well makes Chrome suspend hidden audio before MSE opens.
      a.muted = false;
      a.volume = 1;
      try { a.playbackRate = mode === 'fast' ? 8 : 1; } catch { mode = 'normal'; a.playbackRate = 1; }
    }
    async function requestPlayback() {
      if (finished || !audio()) return;
      const a = audio(); prepareAudio(a);
      if (!playRequestedAt || (!a.currentSrc && Date.now() - playRequestedAt > 3000)) {
        const button = playingId() === id ? document.querySelector('button[aria-label="Playbar: Play button"]') : document.querySelector('button[aria-label="Play"]');
        if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
        playRequestedAt = Date.now(); playbackAttempts++; button.click();
      } else if (a.currentSrc && a.paused && !a.error && Date.now() - playRequestedAt > 1800) {
        try { await a.play(); autoplayBlocked = false; }
        catch (error) { if (error.name === 'NotAllowedError') { autoplayBlocked = true; publish(true); } }
      }
    }
    function tick() {
      if (finished) return;
      if (!collector.inspect()) return;
      const a = audio();
      if (!a) { if (Date.now() - started > 40000) collector.fail('歌曲播放器未加载，请打开任务页检查登录状态。', 'PLAYER_MISSING'); return; }
      prepareAudio(a);
      if (!a.paused) startedPlayback = true;
      if (state.bytes !== lastBytes) { lastBytes = state.bytes; lastByteAt = Date.now(); }
      if (a.error && Date.now() - playRequestedAt > 6000 && playRequestedAt) { collector.fail('Suno 播放器加载失败，请打开歌曲页确认能正常播放。', 'PLAYBACK_ERROR'); return; }
      if ((!startedPlayback || a.paused) && !autoplayBlocked) void requestPlayback();
      if (state.phase === 'capturing' && mode === 'fast' && !a.seeking && a.buffered.length && Date.now() - lastSeek > 600) {
        const end = a.buffered.end(a.buffered.length - 1);
        if (end - a.currentTime > 8 && end > 3) {
          a.currentTime = Math.min(end - 2, Number.isFinite(a.duration) ? a.duration - 0.2 : end - 2);
          lastSeek = Date.now(); seeks++;
        }
      }
      if (Date.now() - lastByteAt > (autoplayBlocked ? 90000 : 45000)) collector.fail(autoplayBlocked ? '浏览器等待一次播放操作，请打开任务页后点播放。' : '音频加载长时间没有进展，请检查网络后重试。', autoplayBlocked ? 'AUTOPLAY_BLOCKED' : 'STALLED');
      if (Date.now() - started > Math.max(180000, state.duration * 2000 + 60000)) collector.fail('保存超时，请重试。', 'TIMEOUT');
      publish();
    }
    collector = SunoCreateCollector({getContext: () => ({changed: !location.pathname.toLowerCase().includes(id) || (state.phase === 'capturing' && playingId() && playingId() !== id), protected: !!audio()?.mediaKeys, duration: playingId() === id ? audio()?.duration : 0}),
      onState(next) { state = next; if (['ready', 'error', 'cancelled'].includes(next.phase)) stop(); publish(['ready', 'error', 'cancelled', 'validating'].includes(next.phase)); },
      onReady(blob, result) { integrity = result; url = URL.createObjectURL(blob); }
    });
    const api = {nonce: config.nonce, snapshot, cancel, dispose};
    window.__SUNO_SAVER_V2_JOB__ = api;
    document.addEventListener('encrypted', onEncrypted, true);
    timer = setInterval(tick, 250);
    tick(); publish(true);
    return snapshot();
  }
})();
