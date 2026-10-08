import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { seedExtensions } from '../server/android/seed-extensions.js';
const root=path.resolve(import.meta.dirname,'..');
test('public upgrade never seeds, replaces or removes existing user extensions',async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'st-public-upgrade-'));
    t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    const content={
        'default-user/extensions/JS-Slash-Runner/manifest.json':'{"version":"user-version"}',
        'default-user/extensions/JS-Slash-Runner/.git/HEAD':'user branch',
        'default-user/characters/card.png':'synthetic card',
        'default-user/worlds/world.json':'{"entries":{"1":{"content":"user world"}}}',
        'default-user/chats/chat.jsonl':'{"mes":"user chat"}\n',
        'default-user/secrets.json':'{"synthetic":"keep"}',
        'default-user/settings.json':'{"extensions":{}}',
        '_global/extensions/custom/manifest.json':'{"version":"custom"}',
        '_global/bundled-extensions.json':'["JS-Slash-Runner"]',
    };
    for(const [rel,value]of Object.entries(content)){
        const file=path.join(dir,rel);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value);
    }
    await seedExtensions(dir);await seedExtensions(dir);
    for(const [rel,value]of Object.entries(content))assert.equal(await fs.readFile(path.join(dir,rel),'utf8'),value);
    const fresh=path.join(dir,'fresh');await seedExtensions(fresh);await assert.rejects(fs.stat(fresh),{code:'ENOENT'});
});
test('fresh default content includes no character cards, worlds or character sprites',async()=>{
    const index=JSON.parse(await fs.readFile(path.join(root,'server/default/content/index.json'),'utf8'));
    assert.equal(index.some(x=>['character','world','sprites'].includes(x.type)),false);
    await assert.rejects(fs.stat(path.join(root,'server/android/bundled-extensions')),{code:'ENOENT'});
});
async function lifecycleFixture(){
    const source=await fs.readFile(path.join(root,'server/public/scripts/android-standalone.js'),'utf8');
    const begin=source.indexOf('    async function flushSaves()');
    const end=source.indexOf("    document.addEventListener('click'",begin);
    const calls=[],alerts=[],pendingSaves=new Set(),active=new Map();
    const context=vm.createContext({Promise,pendingSaves,active,console,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail}},
        window:{dispatchEvent(){}},getContext:()=>({saveSettingsDebounced:{flush:()=>Promise.resolve()},saveMetadataDebounced:{flush:()=>Promise.resolve()}}),
        host:async(method,data)=>{calls.push({method,data});return true},alert:x=>alerts.push(x),
        showRecovery(){},back(){},exportBlob(){},hostCalls:new Map(),
    });
    vm.runInContext(source.substring(begin,end),context);
    return {context,calls,alerts,pendingSaves,active};
}
async function settle(){for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));}
test('update installation waits for all pending saves and returns only its native nonce',async()=>{
    const f=await lifecycleFixture();let release;
    const pending=new Promise(resolve=>{release=resolve});
    f.pendingSaves.add(pending);
    assert.equal(vm.runInContext("prepareUpdateInstall('nonce-1')",f.context),true);
    await settle();assert.equal(f.calls.length,0);
    f.pendingSaves.delete(pending);release();await settle();
    assert.equal(f.calls[0].method,'runtime.update-ready');assert.equal(f.calls[0].data.nonce,'nonce-1');
});
test('failed saves and active generation prevent installation',async()=>{
    const f=await lifecycleFixture();let reject;
    const pending=new Promise((_,r)=>{reject=r});f.pendingSaves.add(pending);
    vm.runInContext("prepareUpdateInstall('nonce-2')",f.context);await settle();reject(Error('save failure'));await settle();
    assert.equal(f.calls.some(x=>x.method==='runtime.update-ready'),false);
    assert.equal(f.calls[0].method,'runtime.save-failed');
    const busy=await lifecycleFixture();busy.active.set('job',{});
    vm.runInContext("prepareUpdateInstall('nonce-3')",busy.context);await settle();
    assert.equal(busy.calls[0].method,'runtime.save-failed');
});
