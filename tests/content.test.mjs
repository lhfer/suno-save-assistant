import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const FIRST='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', SECOND='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const code=fs.readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
function page(detail=false) {
  class Element {
    constructor(tag){this.tagName=tag;this.attrs={};this.dataset={};this.listeners={};this.isConnected=true;this.textContent='';}
    get href(){return new URL(this.attrs.href||'', 'https://suno.com').href;}
    getAttribute(name){return this.attrs[name]??null;}
    setAttribute(name,value){this.attrs[name]=value;}
    addEventListener(type,fn){this.listeners[type]=fn;}
    insertAdjacentElement(_,button){this.button=button;}
    remove(){this.isConnected=false;}
  }
  const anchor=new Element(detail?'h1':'a');anchor.textContent='第一首';anchor.setAttribute('href','/song/'+FIRST);
  const location={origin:'https://suno.com',href:detail?'https://suno.com/song/'+FIRST:'https://suno.com/create'};
  const requests=[],timers=[],events={};let notify,observation;
  const document={hidden:false,documentElement:{},head:{append(){}},getElementById:()=>null,createElement:tag=>new Element(tag),
    querySelectorAll:selector=>selector==='a[href*="/song/"]'&&!detail?[anchor]:[],querySelector:selector=>selector==='h1'&&detail?anchor:null};
  const chrome={runtime:{id:'own-extension',onMessage:{addListener(){}},sendMessage:async request=>{requests.push(request);return {ok:true,result:request.type==='list'?{jobs:[]}:{duplicate:false,job:{id:'task-test',phase:'queued',songId:new URL(request.url).pathname.split('/').at(-1)}}};}},storage:{local:{set:async()=>{}}}};
  const scope={document,location,chrome,URL,Date,Map,Set,console,setInterval:()=>1,setTimeout:fn=>{timers.push(fn);return timers.length;},addEventListener:(type,fn)=>{events[type]=fn;},MutationObserver:class{constructor(fn){notify=fn;}observe(_,options){observation=options;}}};
  scope.window=scope;vm.runInNewContext(code,scope);
  return {anchor,location,requests,mutate:()=>{notify();while(timers.length)timers.shift()();},observation:()=>observation,click:()=>anchor.button.listeners.click({preventDefault(){},stopPropagation(){}})};
}
test('曲库复用同一链接节点时，保存按钮跟随新的歌曲地址',async()=>{
  const p=page();p.anchor.setAttribute('href','/song/'+SECOND);p.anchor.textContent='第二首';p.mutate();await p.click();
  const request=p.requests.find(r=>r.type==='enqueue');assert.equal(request.url,'https://suno.com/song/'+SECOND);assert.equal(request.title,'第二首');
});
test('详情页复用标题节点时，保存目标跟随当前路由',async()=>{
  const p=page(true);p.location.href='https://suno.com/song/'+SECOND;p.anchor.textContent='第二首';p.mutate();await p.click();
  assert.equal(p.requests.find(r=>r.type==='enqueue').url,p.location.href);
});
test('离开歌曲页后，不在普通页面标题旁保留旧保存按钮',()=>{
 const p=page(true),button=p.anchor.button;p.location.href='https://suno.com/create';p.mutate();assert.equal(button.isConnected,false);
});
