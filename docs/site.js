(() => {
  const $ = id => document.getElementById(id);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let state = 'idle', progress = 0, timer, phaseIndex = -1;
  const stages = [
    {at: 0, label: '打开歌曲', note: '正在准备静音任务页', step: 0},
    {at: 18, label: '正在保存', note: '已返回原页面 · 后台处理', step: 1},
    {at: 82, label: '检查完整性', note: '核对片段顺序、时长和文件大小', step: 2},
    {at: 100, label: '已保存', note: '3:28 · M4A · 演示文件', step: 3}
  ];
  function stop() { clearInterval(timer); timer = undefined; document.body.classList.remove('is-running'); }
  function announce(message) { $('demo-status').textContent = message; }
  function highlight(step) { document.querySelectorAll('[data-step]').forEach(item => item.classList.toggle('active', Number(item.dataset.step) <= step)); }
  function render() {
    $('task').hidden = state === 'idle';
    $('empty-task').hidden = state !== 'idle';
    $('recovery').hidden = state !== 'recoverable';
    $('save-song').disabled = state === 'running';
    $('save-song').textContent = state === 'done' ? '已保存 · 再次提交' : state === 'recoverable' ? '继续保存这首歌' : state === 'running' ? '已在保存队列中' : '保存这首歌';
    $('task-count').textContent = state === 'running' ? '1 首处理中' : state === 'recoverable' ? '1 首待继续' : state === 'idle' ? '等待开始' : '最近任务';
    $('cancel').hidden = !['running','recoverable'].includes(state);
    $('progress').hidden = state !== 'running';
    $('progress').setAttribute('aria-valuenow', String(progress));
    $('progress-fill').style.transform = `scaleX(${progress/100})`;
    $('phase').classList.toggle('done', state === 'done');
    if (state === 'recoverable') { $('phase').textContent = '待继续'; $('task-note').textContent = '上次任务未完成，继续后从头处理。'; return; }
    if (state === 'cancelled') { $('phase').textContent = '已取消'; $('task-note').textContent = '演示任务已停止，没有生成文件。'; return; }
    const index = stages.findLastIndex(stage => progress >= stage.at);
    const stage = stages[Math.max(0,index)];
    $('phase').textContent = stage.label;
    $('task-note').textContent = stage.note;
    highlight(state === 'idle' ? -1 : stage.step);
    if (index !== phaseIndex && state === 'running') { phaseIndex = index; announce(`${stage.label} · 模拟流程，时间已压缩。`); }
  }
  function finish() { stop(); state = 'done'; progress = 100; render(); announce('演示完成。真实扩展会自动下载，此页面不会生成音频。'); }
  function run() {
    if (state === 'running') { announce('同一首歌已在队列中，没有新增任务。'); return; }
    if (state === 'done') { announce('这首歌已经保存，本次没有重复添加任务。'); return; }
    stop(); state = 'running'; progress = 0; phaseIndex = -1;
    document.body.classList.add('is-running'); render();
    if (reduced.matches) { finish(); return; }
    timer = setInterval(() => {
      if (document.hidden) return;
      progress = Math.min(100, progress + 2);
      if (progress === 100) finish(); else render();
    }, 90);
  }
  function reset() { stop(); state = 'idle'; progress = 0; phaseIndex = -1; $('demo-url').value = ''; render(); announce('这是流程演示，不会下载真实音频。'); }
  function example() { if (state === 'done' || state === 'cancelled') reset(); $('demo-url').value = 'https://suno.com/song/demo'; run(); }
  $('save-song').addEventListener('click',run);
  $('resume').addEventListener('click',run);
  $('hero-demo').addEventListener('click',() => { example(); if (innerWidth < 701) $('demo').scrollIntoView({behavior:reduced.matches?'instant':'smooth',block:'start'}); });
  $('link-form').addEventListener('submit',event => { event.preventDefault(); if (!$('demo-url').value.trim()) $('demo-url').value = 'https://suno.com/song/demo'; run(); });
  $('demo-url').addEventListener('paste',() => setTimeout(run,0));
  $('try-recovery').addEventListener('click',() => { stop(); state = 'recoverable'; progress = 0; render(); highlight(0); announce('已模拟一次中断。点击「继续保存」体验恢复。'); });
  $('try-duplicate').addEventListener('click',() => { if (state === 'idle' || state === 'cancelled' || state === 'recoverable') { stop(); state = 'done'; progress = 100; render(); } announce(state === 'running' ? '同一首歌已经在队列中，没有新增任务。' : '短链和长链属于同一首歌，复用已有文件。'); });
  $('cancel').addEventListener('click',() => { stop(); state = 'cancelled'; render(); highlight(-1); announce('任务已取消。可以重新开始演示。'); });
  $('reset-demo').addEventListener('click',reset);
  reduced.addEventListener('change',() => { if (reduced.matches && state === 'running') finish(); });
  addEventListener('pagehide',stop);
  render();
})();
