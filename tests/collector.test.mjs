import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const fixture=fs.readFileSync(new URL('./fixtures/complete.m4a', import.meta.url));
const integrity=fs.readFileSync(new URL('../extension/integrity.js',import.meta.url),'utf8');
const source=fs.readFileSync(new URL('../extension/collector.js',import.meta.url),'utf8');
function run({maxBytes,context={duration:213.2}}={}) {
  class SB extends EventTarget {buffered={length:1,end:()=>213.2065};appendBuffer(data){if(this.throwNext){this.throwNext=false;throw Error('QuotaExceeded');}this.dispatchEvent(new Event('updateend'));}changeType(){} }
  class MS {duration=213.2065;addSourceBuffer(){return new SB();}endOfStream(){} }
  const sandbox={MediaSource:MS,SourceBuffer:SB,Uint8Array,DataView,Blob,Number,Error};vm.createContext(sandbox);vm.runInContext(integrity+'\n'+source,sandbox);
  let ready=null;const states=[];const original=SB.prototype.appendBuffer;
  const recorder=sandbox.SunoCreateCollector({maxBytes,getContext:()=>context,onState:s=>states.push(s),onReady:(blob,result)=>{ready={blob,result};}});
  const ms=new MS(),sb=ms.addSourceBuffer('audio/mp4;codecs="opus"');
  return {recorder,ms,sb,states,SB,original,ready:()=>ready};
}
test('任意传输分块拼回原文件，逐字节不变',async()=>{const r=run();for(let p=0;p<fixture.length;p+=65521)r.sb.appendBuffer(fixture.subarray(p,p+65521));r.ms.endOfStream();assert.equal(r.recorder.snapshot().phase,'ready');assert.deepEqual(Buffer.from(await r.ready().blob.arrayBuffer()),fixture);assert.equal(r.SB.prototype.appendBuffer,r.original);});
test('使用音频文件类型，让 Chrome 保留 M4A 扩展名',()=>{const r=run();r.sb.appendBuffer(fixture);r.ms.endOfStream();assert.equal(r.ready().blob.type,'audio/x-m4a');});
test('SourceBuffer 拒绝的字节不能混入结果',()=>{const r=run();r.sb.throwNext=true;assert.throws(()=>r.sb.appendBuffer(fixture),/QuotaExceeded/);assert.equal(r.recorder.snapshot().bytes,0);});
test('网络异常结束不会下载残缺文件',()=>{const r=run();r.sb.appendBuffer(fixture.subarray(0,20000));r.ms.endOfStream('network');assert.equal(r.ready(),null);assert.equal(r.recorder.snapshot().phase,'error');});
test('取消释放钩子，后续追加不会继续收集',()=>{const r=run();r.sb.appendBuffer(fixture.subarray(0,20000));r.recorder.cancel();r.sb.appendBuffer(fixture);assert.equal(r.recorder.snapshot().phase,'cancelled');assert.equal(r.SB.prototype.appendBuffer,r.original);assert.equal(r.ready(),null);});
test('内存上限会停止采集',()=>{const r=run({maxBytes:1024});r.sb.appendBuffer(fixture.subarray(0,2000));assert.equal(r.recorder.snapshot().code,'SIZE_LIMIT');});
test('切歌和受保护媒体停止采集',()=>{for(const context of [{changed:true},{protected:true}]){const r=run({context});assert.equal(r.recorder.snapshot().phase,'error');assert.equal(r.ready(),null);}});
