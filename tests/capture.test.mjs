import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../extension/capture.js',import.meta.url),'utf8');
const songId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function setup({muted=false,volume=0.7}={}) {
  let tick,options,playingId=songId,now=10000,clicks=0;
  const handlers=new Map(),messages=[],errors=[];
  const audio={currentSrc:'',currentTime:0,duration:251.68,paused:true,muted,volume,playbackRate:1,buffered:{length:0},pause(){this.paused=true;},play:async()=>{audio.paused=false;}};
  const button={disabled:false,getAttribute:()=>null,click:()=>{clicks++;}};
  const document={hidden:true,title:'云端回声 by demo-artist | Suno',getElementById:()=>audio,
    querySelector:selector=>selector==='h1'?{textContent:'云端回声'}:selector.startsWith('a[')?{getAttribute:()=>'/song/'+playingId}:button,
    addEventListener:(type,fn)=>handlers.set(type,fn),removeEventListener:(type,fn)=>{if(handlers.get(type)===fn)handlers.delete(type);}};
  const sandbox={document,location:{hostname:'suno.com',pathname:'/song/'+songId,origin:'https://suno.com'},MediaSource:function(){},SourceBuffer:function(){},Date:{now:()=>now},Number,URL,
    setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{},postMessage:message=>messages.push(message),
    SunoCreateCollector:o=>{options=o;return {inspect:()=>{if(o.getContext().changed){errors.push('SONG_CHANGED');return false;}return true;},fail:(message,code)=>errors.push(code),cancel:()=>{}};}};
  sandbox.window=sandbox;vm.runInNewContext(source,sandbox);
  const api=sandbox.SunoSaverV2.start({songId,nonce:'test',mode:'fast'});
  return {audio,api,button,finish:()=>options.onState({phase:'error',message:'test end'}),clicks:()=>clicks,advance:ms=>{now+=ms;},tick:()=>tick(),capturing:()=>options.onState({phase:'capturing',bytes:10000,chunks:2,duration:251.68,capturedSeconds:20}),seek:()=>handlers.get('seeking')?.({target:audio,isTrusted:true}),changeSong:()=>{playingId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';},errors,messages};
}
test('播放器自行校准进度的 seeking 事件不应误报用户拖动',()=>{const r=setup();r.capturing();r.audio.currentTime=0.0065;r.seek();assert.deepEqual(r.errors,[]);});
test('由标签页静音，播放器保持正常音量和加速以避免后台挂起',()=>{const r=setup();r.capturing();r.audio.buffered={length:1,end:()=>20};r.tick();assert.equal(r.audio.muted,false);assert.equal(r.audio.volume,1);assert.equal(r.audio.playbackRate,8);assert.equal(r.audio.currentTime,18);r.seek();assert.deepEqual(r.errors,[]);});
test('忽略进度事件不会忽略切换到另一首歌',()=>{const r=setup();r.capturing();r.changeSong();r.tick();assert.deepEqual(r.errors,['SONG_CHANGED']);});
test('页面尚未处理首次播放点击时会自动再次尝试',()=>{const r=setup();assert.equal(r.clicks(),1);r.advance(3100);r.tick();assert.equal(r.clicks(),2);r.audio.currentSrc='blob:ready';r.audio.paused=false;r.advance(3100);r.tick();assert.equal(r.clicks(),2);});
test('按钮暂不可用时等待就绪，不消耗播放重试',()=>{const r=setup();r.button.disabled=true;r.advance(3100);r.tick();assert.equal(r.clicks(),1);r.button.disabled=false;r.advance(3100);r.tick();assert.equal(r.clicks(),2);});
test('结束后恢复播放器原来的静音、音量和速度',()=>{const r=setup({muted:true,volume:0.3});assert.equal(r.audio.muted,false);assert.equal(r.audio.volume,1);r.finish();assert.equal(r.audio.muted,true);assert.equal(r.audio.volume,0.3);assert.equal(r.audio.playbackRate,1);assert.equal(r.audio.paused,true);});
