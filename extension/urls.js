export function songIdFromUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.hostname !== 'suno.com' || u.port || u.username || u.password) return null;
    return u.pathname.match(/^\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i)?.[1].toLowerCase() || null;
  } catch { return null; }
}
export function normalizeShareUrl(value) {
  const text = String(value || '').trim();
  let u;
  try { u = new URL(text.startsWith('suno.com/') ? `https://${text}` : text); }
  catch { throw new Error('请粘贴完整的 Suno 歌曲或分享链接。'); }
  if (u.protocol !== 'https:' || u.hostname !== 'suno.com' || u.port || u.username || u.password) throw new Error('只接受 suno.com 的歌曲链接。');
  const songId = songIdFromUrl(u.href);
  if (!songId && !/^\/s\/[A-Za-z0-9_-]{6,80}\/?$/.test(u.pathname)) throw new Error('请使用一首歌曲的 /song/ 或 /s/ 链接。');
  const result = new URL(songId ? `/song/${songId}` : u.pathname, 'https://suno.com');
  const sh = u.searchParams.get('sh');
  if (sh && /^[A-Za-z0-9_-]{1,100}$/.test(sh)) result.searchParams.set('sh', sh);
  return result.href;
}
export function safeFilename(title, songId) {
  let clean = String(title || 'Suno 歌曲').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+|[ .]+$/g, '').trim();
  if (!clean) clean = 'Suno 歌曲';
  while (new TextEncoder().encode(clean).length > 160) clean = Array.from(clean).slice(0, -1).join('');
  return `Suno/${clean}-${songId.slice(0, 8)}.m4a`;
}
