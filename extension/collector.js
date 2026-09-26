(() => {
  'use strict';
  globalThis.SunoCreateCollector = function (options) {
    const MS = options.MediaSource || MediaSource;
    const SB = options.SourceBuffer || SourceBuffer;
    const native = {add: MS.prototype.addSourceBuffer, append: SB.prototype.appendBuffer, end: MS.prototype.endOfStream, change: SB.prototype.changeType};
    const limit = options.maxBytes || 64 * 1024 * 1024;
    let source = null, buffer = null, mime = '', parts = [], bytes = 0, chunks = 0;
    let phase = 'armed', duration = 0, capturedSeconds = 0, message = '', code = '';
    const listeners = [];
    const active = () => phase === 'armed' || phase === 'capturing';
    const snapshot = () => ({phase, bytes, chunks, duration, capturedSeconds, mime, message, code});
    function publish() { try { options.onState?.(snapshot()); } catch {} }
    function restore() {
      if (MS.prototype.addSourceBuffer === add) MS.prototype.addSourceBuffer = native.add;
      if (SB.prototype.appendBuffer === append) SB.prototype.appendBuffer = native.append;
      if (MS.prototype.endOfStream === end) MS.prototype.endOfStream = native.end;
      if (SB.prototype.changeType === change) SB.prototype.changeType = native.change;
      listeners.splice(0).forEach(off => off());
    }
    function fail(reason, reasonCode = 'CAPTURE_FAILED') {
      if (!active() && phase !== 'validating') return;
      phase = 'error'; message = reason; code = reasonCode;
      restore(); parts = []; publish();
    }
    function inspect() {
      if (!active()) return false;
      const context = options.getContext?.() || {};
      if (context.changed) { fail('歌曲发生变化，已停止本次保存。', 'SONG_CHANGED'); return false; }
      if (context.protected) { fail('播放器启用了受保护媒体，无法使用此保存方式。', 'PROTECTED_MEDIA'); return false; }
      if (Number.isFinite(context.duration) && context.duration > 1) duration = Math.max(duration, context.duration);
      return true;
    }
    function listen(target, event, handler) { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); }
    function add(type) {
      const sb = native.add.call(this, type);
      if (!inspect() || !String(type).toLowerCase().startsWith('audio/')) return sb;
      if (source) { fail('播放器重新创建了音轨，请重试。', 'SOURCE_REPLACED'); return sb; }
      if (!/^audio\/mp4(?:;|$)/i.test(type)) { fail('当前播放格式暂不支持完整性校验。', 'UNSUPPORTED_FORMAT'); return sb; }
      source = this; buffer = sb; mime = type;
      listen(sb, 'error', () => fail('播放器报告音频加载错误。', 'BUFFER_ERROR'));
      listen(sb, 'abort', () => fail('播放器中断了当前音频流。', 'BUFFER_ABORT'));
      listen(sb, 'updateend', () => {
        if (!inspect()) return;
        try {
          if (sb.buffered.length) capturedSeconds = Math.max(capturedSeconds, sb.buffered.end(sb.buffered.length - 1));
          if (Number.isFinite(source.duration) && source.duration > 1) duration = Math.max(duration, source.duration);
        } catch {}
        publish();
      });
      return sb;
    }
    function append(data) {
      let copy = null;
      if (this === buffer && inspect()) {
        if (bytes + data.byteLength > limit) fail('音频超过 64 MiB，已停止保存。', 'SIZE_LIMIT');
        else copy = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data).slice();
      }
      const result = native.append.call(this, data);
      if (copy && active()) { parts.push(copy); bytes += copy.length; chunks++; phase = 'capturing'; publish(); }
      return result;
    }
    function end(...args) {
      const result = native.end.apply(this, args);
      if (this !== source || !inspect()) return result;
      if (args[0] !== undefined) { fail('播放器未正常结束音频流。', 'STREAM_ERROR'); return result; }
      if (Number.isFinite(this.duration) && this.duration > 1) duration = Math.max(duration, this.duration);
      phase = 'validating'; restore(); publish();
      try {
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (const part of parts) { data.set(part, offset); offset += part.length; }
        parts = [];
        const normalized = SunoIntegrity.normalizeMp4(data);
        const integrity = {...SunoIntegrity.validateMp4(normalized.data, duration), removedInitBoxes: normalized.removedInitBoxes};
        bytes = normalized.data.length;
        phase = 'ready'; capturedSeconds = integrity.duration;
        // Chrome otherwise rewrites the requested .m4a filename to .mp4.
        options.onReady?.(new Blob([normalized.data], {type: 'audio/x-m4a'}), integrity);
        publish();
      } catch (error) { fail(`完整性校验未通过：${error.message}`, 'INTEGRITY_FAILED'); }
      return result;
    }
    function change(...args) { const result = native.change.apply(this, args); if (this === buffer) fail('音频编码发生变化。', 'FORMAT_CHANGED'); return result; }
    function cancel() { if (!active() && phase !== 'validating') return; restore(); parts = []; phase = 'cancelled'; publish(); }
    MS.prototype.addSourceBuffer = add;
    SB.prototype.appendBuffer = append;
    MS.prototype.endOfStream = end;
    if (native.change) SB.prototype.changeType = change;
    return {snapshot, inspect, fail, cancel};
  };
})();
