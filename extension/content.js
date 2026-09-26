(() => {
  if (!globalThis.__SUNO_SAVER_DIAGNOSTICS_V2__) {
    globalThis.__SUNO_SAVER_DIAGNOSTICS_V2__ = true;
    let taskNonce = null, lastSample = 0;
    chrome.runtime.onMessage.addListener((request, sender) => {
      if (sender.id === chrome.runtime.id && request.type === 'bind-job') taskNonce = request.nonce;
    });
    window.addEventListener('message', event => {
      const payload = event.data;
      if (event.source !== window || event.origin !== location.origin || !taskNonce || payload?.source !== 'SUNO_SAVER_V2' || payload.nonce !== taskNonce) return;
      const state = payload.state;
      if (!state || (state.phase !== 'error' && Date.now() - lastSample < 2000)) return;
      lastSample = Date.now();
      const sample = {at: lastSample, songId: state.songId, phase: state.phase, mode: state.mode, elapsed: state.elapsed, bytes: state.bytes, chunks: state.chunks, playbackAttempts: state.playbackAttempts, diagnostics: state.diagnostics, code: state.code};
      const values = {sunoCaptureDiagnosticV2: sample};
      if (state.phase === 'error') values.sunoCaptureLastErrorV2 = sample;
      void chrome.storage.local.set(values).catch(() => {});
    });
  }
  if (globalThis.__SUNO_SAVER_CONTENT_V2__) return;
  globalThis.__SUNO_SAVER_CONTENT_V2__ = true;
  let nonce = null, scanTimer, knownJobs = [], refreshing = false;
  const buttons = new Map();
  const idFrom = href => { try { const u = new URL(href, location.origin); return u.origin === 'https://suno.com' ? u.pathname.match(/^\/song\/([0-9a-f-]{36})\/?$/i)?.[1]?.toLowerCase() : null; } catch { return null; } };
  async function send(request) {
    const response = await chrome.runtime.sendMessage(request);
    if (!response?.ok) throw new Error(response?.error || '插件已更新，请刷新 Suno 页面。');
    return response.result;
  }
  function currentSong() {
    const pageId = idFrom(location.href);
    if (pageId) return {url: location.href, title: document.querySelector('h1')?.textContent?.trim() || document.title.replace(/ by .* \| Suno$/, '').trim()};
    const links = [...document.querySelectorAll('a[aria-label^="Playbar: Title for"]')];
    const link = links.find(a => a.textContent.trim()) || links[0];
    return link && idFrom(link.href) ? {url: link.href, title: link.textContent.trim() || link.getAttribute('aria-label').replace('Playbar: Title for ', '')} : null;
  }
  chrome.runtime.onMessage.addListener((request, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (request.type === 'bind-job') { nonce = request.nonce; reply({ok: true}); }
    if (request.type === 'current-song') reply(currentSong());
  });
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || !nonce) return;
    const payload = event.data;
    if (payload?.source !== 'SUNO_SAVER_V2' || payload.nonce !== nonce) return;
    void send({type: 'capture-state', nonce, state: payload.state}).catch(() => {});
  });
  const style = document.createElement('style');
  style.id = 'suno-saver-v2-style';
  style.textContent = `.suno-saver-v2-button{font:600 11px/1.2 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;vertical-align:middle!important;gap:4px!important;flex-shrink:0!important;margin:0 0 0 8px!important;padding:6px 9px!important;border:1px solid #c9573260!important;border-radius:6px!important;background:#c9573219!important;color:#d67957!important;cursor:pointer!important;white-space:nowrap!important;position:relative!important;z-index:2!important}.suno-saver-v2-button:hover{background:#c9573235!important}.suno-saver-v2-button:focus-visible{outline:2px solid #e6a890!important;outline-offset:2px!important}.suno-saver-v2-button:disabled{opacity:.65!important;cursor:wait!important}.suno-saver-v2-button[data-done="true"]{color:#79ab92!important;border-color:#79ab9260!important;background:#79ab9215!important}`;
  if (!document.getElementById(style.id)) (document.head || document.documentElement).append(style);
  function paint(button, songId) {
    const job = knownJobs.find(j => j.songId === songId);
    button.dataset.done = String(job?.phase === 'done');
    const text = !job || ['cancelled', 'error'].includes(job.phase) ? '↓ 保存' : job.phase === 'done' ? '✓ 已保存' : job.phase === 'recoverable' ? '↻ 继续' : job.phase === 'queued' ? '排队中' : `${Math.floor(job.progress || 0)}%`;
    if (button.textContent !== text) button.textContent = text;
    button.title = job?.phase === 'error' ? `${job.message} 点击重试` : '后台静音处理，完成后自动保存';
  }
  function attach(anchor, songId, url, title) {
    const existing = buttons.get(anchor);
    if (existing) {
      Object.assign(existing, {songId, url, title});
      existing.button.setAttribute('aria-label', `保存歌曲 ${title}`); paint(existing.button, songId); return;
    }
    const button = document.createElement('button');
    const item = {button, songId, url, title};
    button.className = 'suno-saver-v2-button'; button.type = 'button'; button.setAttribute('aria-label', `保存歌曲 ${title}`);
    paint(button, songId);
    button.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation(); button.disabled = true;
      try {
        const result = await send({type: 'enqueue', url: item.url, title: item.title});
        knownJobs = [result.job, ...knownJobs.filter(j => j.id !== result.job.id)];
        if (result.duplicate && result.job.phase === 'done') await send({type: 'show-file', id: result.job.id});
        paint(button, item.songId);
      } catch (error) { button.textContent = '重试'; button.title = error.message; }
      finally { button.disabled = false; }
    });
    anchor.insertAdjacentElement('afterend', button); buttons.set(anchor, item);
  }
  function scan() {
    for (const [anchor, item] of buttons) if (!anchor.isConnected || !item.button.isConnected || (anchor.matches?.('a') && !idFrom(anchor.href)) || (anchor.tagName?.toLowerCase() === 'h1' && !idFrom(location.href))) { item.button.remove(); buttons.delete(anchor); }
    for (const link of document.querySelectorAll('a[href*="/song/"]')) {
      if ((link.getAttribute('aria-label') || '').startsWith('Playbar:')) continue;
      const songId = idFrom(link.href), title = link.textContent.trim();
      if (!songId || !title || title.length > 200) continue;
      attach(link, songId, link.href, title);
    }
    const pageId = idFrom(location.href), heading = document.querySelector('h1');
    if (pageId && heading) attach(heading, pageId, location.href, heading.textContent.trim());
  }
  function scheduleScan() { if (scanTimer) return; scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 350); }
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {childList: true, characterData: true, attributes: true, attributeFilter: ['href'], subtree: true});
  window.addEventListener('popstate', scheduleScan);
  async function refresh() {
    if (refreshing || document.hidden) return;
    scan();
    if (!buttons.size) return;
    refreshing = true;
    try { knownJobs = (await send({type: 'list'})).jobs; for (const {button, songId} of buttons.values()) paint(button, songId); }
    catch {} finally { refreshing = false; }
  }
  setInterval(refresh, 3000); scan(); void refresh();
})();
