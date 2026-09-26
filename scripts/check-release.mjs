import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'extension/manifest.json')));
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
assert.equal(pkg.version,manifest.version);
assert.deepEqual(manifest.host_permissions,['https://suno.com/*']);
assert.deepEqual([...manifest.permissions].sort(),['activeTab','alarms','contextMenus','downloads','scripting','storage']);
assert.match(fs.readFileSync(path.join(root,'extension/bootstrap-state.js'),'utf8'),/export const bootstrapState = null;/);
const excluded=new Set(['.git','node_modules','dist','.hyperframes','renders']);
const textTypes=new Set(['.js','.mjs','.json','.md','.html','.css','.yml','.yaml','.py','.svg']);
let checked=0;
function visit(directory){
  for(const item of fs.readdirSync(directory,{withFileTypes:true})){
    if(excluded.has(item.name))continue;
    const file=path.join(directory,item.name);
    if(item.isDirectory()){visit(file);continue;}
    if(item.name==='.env'||item.name.startsWith('.env.'))throw Error('Environment file in release');
    if(!textTypes.has(path.extname(file)))continue;
    const text=fs.readFileSync(file,'utf8');
    assert.doesNotMatch(text,/\/(?:Users|home)\/[A-Za-z0-9_-]+\//,`${path.relative(root,file)} contains a personal home path`);
    assert.doesNotMatch(text,/-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/,`${item.name} contains private key material`);
    assert.doesNotMatch(text,/(?:ghp|gho)_[A-Za-z0-9]{25,}/,`${item.name} contains a credential`);
    if(['.js','.mjs'].includes(path.extname(file)))execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
    checked++;
  }
}
visit(root);
console.log(`Release checks passed: ${checked} text files; version ${manifest.version}; no private bootstrap data.`);
