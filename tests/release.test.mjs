import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { identity,shouldPromote,publishRelease } from '../scripts/release.mjs';
test('CI versions increase numerically and reruns use the same identity',()=>{
    assert.deepEqual(identity(1),{versionName:'1.1.5+build.1',versionCode:1001});
    assert.deepEqual(identity(1),identity(1));assert.equal(identity(2).versionCode,1002);
    for(const n of [0,-1,NaN,1.5,2100000000])assert.throws(()=>identity(n));
    assert.equal(shouldPromote(1001,{versionCode:1002}),false);assert.equal(shouldPromote(1003,{versionCode:1002}),true);
});
test('release rerun does not overwrite published assets or duplicate its announcement',async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'st-release-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    const apk=path.join(dir,'app.apk');await fs.writeFile(apk,'synthetic APK');
    const info={...identity(1),commit:'a'.repeat(40),notes:'Example'};
    const state={release:null,issues:[],uploads:0,published:0};
    const github={
        async upload(tag,files){state.uploads++;state.release.assets=await Promise.all(files.map(async file=>{const bytes=await fs.readFile(file);return {name:path.basename(file),state:'uploaded',size:bytes.length,digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex'),browser_download_url:'https://example.test/app.apk'};}));},
        async api(route,method='GET',body){
            if(route.includes('/git/ref/tags/'))return {object:{sha:info.commit}};
            if(route.includes('/issues?'))return state.issues;
            if(route.endsWith('/issues')&&method==='POST'){state.issues.push(body);return body;}
            if(route.endsWith('/labels'))return {};
            if(route.endsWith('/releases/latest')){const error=Error('missing');error.status=404;throw error;}
            if(method==='POST'&&route.endsWith('/releases'))return state.release={id:1,draft:true,assets:[],html_url:'https://example.test/release'};
            if(method==='PATCH'){state.published++;Object.assign(state.release,body);return state.release;}
            if(!state.release){const error=Error('missing');error.status=404;throw error;}
            return state.release;
        },
    };
    await publishRelease(info,[apk],github);await publishRelease(info,[apk],github);
    assert.equal(state.uploads,1);assert.equal(state.published,1);assert.equal(state.issues.length,1);
    assert.match(state.issues[0].body,/点击“⋮”应用控制菜单，再选择“更新”/);
    state.release.draft=true;state.release.assets=[];
    const broken={...github,upload:async()=>{}};
    await assert.rejects(publishRelease(info,[apk],broken),/verification failed/);
    assert.equal(state.published,1);
});
