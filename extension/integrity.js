/* Verifies the complete, single-track fragmented MP4 produced by the player. */
(() => {
  'use strict';
  function validateMp4(input, expectedDuration) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fail = message => { throw new Error(message); };
    const u32 = p => { if (p < 0 || p + 4 > bytes.length) fail('音频结构不完整'); return view.getUint32(p); };
    const u64 = p => { const n = u32(p) * 4294967296 + u32(p + 4); if (!Number.isSafeInteger(n)) fail('音频时间戳超出范围'); return n; };
    const str = (p, n = 4) => String.fromCharCode(...bytes.subarray(p, p + n));
    function boxes(start, end) {
      const result = [];
      for (let pos = start; pos < end;) {
        if (pos + 8 > end) fail('音频文件末尾被截断');
        let size = u32(pos), header = 8;
        if (size === 1) { size = u64(pos + 8); header = 16; }
        if (size === 0) size = end - pos;
        if (size < header || pos + size > end) fail('音频片段长度不完整');
        result.push({type: str(pos + 4), start: pos, data: pos + header, end: pos + size, size});
        pos += size;
      }
      return result;
    }
    const children = box => boxes(box.data, box.end);
    function one(list, type) {
      const found = list.filter(b => b.type === type);
      if (found.length !== 1) fail(`音频结构异常：${type}`);
      return found[0];
    }
    function check(box, p, n) { if (p < box.data || p + n > box.end) fail(`音频结构不完整：${box.type}`); }
    const top = boxes(0, bytes.length);
    if (top[0]?.type !== 'ftyp' || top.filter(b => b.type === 'ftyp').length !== 1) fail('音频缺少文件头或包含重复文件头');
    const moov = one(top, 'moov'), moovChildren = children(moov);
    const traks = moovChildren.filter(b => b.type === 'trak');
    if (traks.length !== 1) fail('只支持单音轨歌曲');
    const trak = children(traks[0]);
    const tkhd = one(trak, 'tkhd');
    const trackId = u32(tkhd.data + (bytes[tkhd.data] === 1 ? 20 : 12));
    const mdia = children(one(trak, 'mdia'));
    const mdhd = one(mdia, 'mdhd');
    const timescale = u32(mdhd.data + (bytes[mdhd.data] === 1 ? 20 : 12));
    if (!timescale || str(one(mdia, 'hdlr').data + 8) !== 'soun') fail('文件不是有效音频');
    let trexDuration = 0, trexSize = 0;
    const mvex = moovChildren.find(b => b.type === 'mvex');
    if (mvex) {
      const trex = children(mvex).find(b => b.type === 'trex' && u32(b.data + 4) === trackId);
      if (trex) { trexDuration = u32(trex.data + 12); trexSize = u32(trex.data + 16); }
    }
    let expectedTick = 0, fragments = 0, samples = 0, sequence = null, payloadBytes = 0;
    for (let index = 0; index < top.length; index++) {
      const moof = top[index];
      if (moof.type !== 'moof') continue;
      if (moof.start < moov.end) fail('音频初始化片段顺序异常');
      const mdat = top[index + 1];
      if (!mdat || mdat.type !== 'mdat') fail('音频片段缺少数据');
      const sub = children(moof), mfhd = one(sub, 'mfhd');
      const seq = u32(mfhd.data + 4);
      if (sequence !== null && seq !== ((sequence + 1) >>> 0)) fail('音频片段重复或缺失');
      sequence = seq;
      const traf = children(one(sub, 'traf'));
      const tfhd = one(traf, 'tfhd'), flags = u32(tfhd.data) & 0xffffff;
      if (u32(tfhd.data + 4) !== trackId) fail('音轨发生变化');
      let cursor = tfhd.data + 8, baseOffset = moof.start;
      if (flags & 1) { baseOffset = u64(cursor); cursor += 8; }
      if (flags & 2) cursor += 4;
      let defaultDuration = trexDuration, defaultSize = trexSize;
      if (flags & 8) { defaultDuration = u32(cursor); cursor += 4; }
      if (flags & 16) { defaultSize = u32(cursor); cursor += 4; }
      if (flags & 32) cursor += 4;
      check(tfhd, tfhd.data, cursor - tfhd.data);
      const tfdt = one(traf, 'tfdt');
      const startTick = bytes[tfdt.data] === 1 ? u64(tfdt.data + 4) : u32(tfdt.data + 4);
      if (startTick !== expectedTick) fail(startTick < expectedTick ? '音频时间线包含重复片段' : '音频时间线缺少片段');
      const runs = traf.filter(b => b.type === 'trun');
      if (!runs.length) fail('音频片段缺少采样信息');
      let fragmentBytes = 0, runEnd = mdat.data;
      for (const run of runs) {
        const rf = u32(run.data) & 0xffffff, count = u32(run.data + 4);
        if (!count || count > 1000000) fail('音频采样数量异常');
        let p = run.data + 8, dataStart = runEnd;
        if (rf & 1) { dataStart = baseOffset + view.getInt32(p); p += 4; }
        if (rf & 4) p += 4;
        let runBytes = 0;
        for (let j = 0; j < count; j++) {
          let duration = defaultDuration, size = defaultSize;
          if (rf & 0x100) { check(run, p, 4); duration = u32(p); p += 4; }
          if (rf & 0x200) { check(run, p, 4); size = u32(p); p += 4; }
          if (rf & 0x400) p += 4;
          if (rf & 0x800) p += 4;
          if (!duration || !size) fail('音频采样缺少时长或字节数');
          expectedTick += duration;
          runBytes += size;
        }
        check(run, run.data, p - run.data);
        if (p !== run.end || dataStart !== runEnd || dataStart + runBytes > mdat.end) fail('音频采样数据不连续或不完整');
        runEnd = dataStart + runBytes;
        fragmentBytes += runBytes;
        samples += count;
      }
      if (fragmentBytes !== mdat.end - mdat.data) fail('音频片段字节数量不符');
      payloadBytes += fragmentBytes;
      fragments++;
    }
    if (!fragments || top.filter(b => b.type === 'mdat').length !== fragments) fail('音频片段数量不完整');
    const duration = expectedTick / timescale;
    if (!Number.isFinite(expectedDuration) || expectedDuration < 1) fail('无法确认歌曲完整时长');
    if (Math.abs(duration - expectedDuration) > 0.35) fail('音频时长与歌曲不一致');
    return {valid: true, duration, expectedDuration, fragments, samples, payloadBytes, bytes: bytes.length, timescale};
  }
  function normalizeMp4(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kept = [], initial = new Map();
    let total = 0, removedInitBoxes = 0;
    for (let pos = 0; pos < bytes.length;) {
      if (pos + 8 > bytes.length) throw new Error('音频文件末尾被截断');
      let size = view.getUint32(pos), header = 8;
      if (size === 1) {
        if (pos + 16 > bytes.length) throw new Error('音频片段长度不完整');
        size = view.getUint32(pos + 8) * 4294967296 + view.getUint32(pos + 12); header = 16;
      }
      if (size === 0) size = bytes.length - pos;
      if (!Number.isSafeInteger(size) || size < header || pos + size > bytes.length) throw new Error('音频片段长度不完整');
      const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
      const part = bytes.subarray(pos, pos + size);
      let duplicate = false;
      if (type === 'ftyp' || type === 'moov') {
        const first = initial.get(type);
        if (first) {
          if (first.length !== part.length || !first.every((value, i) => value === part[i])) throw new Error('播放器重新初始化了不同的音轨');
          duplicate = true; removedInitBoxes++;
        } else initial.set(type, part);
      }
      if (!duplicate) { kept.push(part); total += part.length; }
      pos += size;
    }
    if (!removedInitBoxes) return {data: bytes, removedInitBoxes: 0};
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of kept) { result.set(part, offset); offset += part.length; }
    return {data: result, removedInitBoxes};
  }
  globalThis.SunoIntegrity = {validateMp4, normalizeMp4};
})();
