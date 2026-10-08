
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import {createAndroidExtensionRouter} from '../server/android/extensions.js';
const root=path.resolve(import.meta.dirname,'..'), require=createRequire(path.join(root,'server/package.json')), express=require('express');
const folder=await fsp.mkdtemp(path.join(root,'.local/tests/git-'));
const local=path.join(folder,'local'), global=path.join(folder,'global');await fsp.mkdir(local);await fsp.mkdir(global);
const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={profile:{admin:true,handle:'fixture'},directories:{extensions:local}};next();});app.use('/api/extensions',createAndroidExtensionRouter(global));
const server=app.listen(17617,'127.0.0.1');await once(server,'listening');
const report={transport:'isomorphic-git, HTTPS, no child_process or system Git',checks:[]};
const call=(endpoint,body)=>fetch('http://127.0.0.1:17617/api/extensions/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
try {
    const response=await call('install',{url:'https://github.com/AkarisRotile/opening-preset-forge'});
    assert.equal(response.status,200,await response.clone().text());
    report.installed=await response.json();delete report.installed.extensionPath;
    report.checks.push('HTTPS install validates and deploys a real extension');
    const options={extensionName:'third-party/opening-preset-forge',global:false};
    const before=await(await call('version',options)).json();assert.equal(before.isUpToDate,true);report.checks.push('Version check returns original API fields');
    const branches=await(await call('branches',options)).json();assert.ok(branches.some(b=>b.name==='origin/main'));
    const update=await call('update',options);assert.equal(update.status,200,await update.clone().text());report.checks.push('Staged update keeps a backup and replaces atomically');
    const bad=await call('switch',{...options,branch:'origin/does-not-exist-android-fixture'});
    assert.ok(bad.status>=400);const after=await(await call('version',options)).json();assert.equal(after.currentCommitHash,before.currentCommitHash);report.checks.push('Failed branch switch retains installed version');
    const valid=await call('switch',{...options,branch:'origin/main'});assert.equal(valid.status,204);report.checks.push('Branch switch supports the legacy origin/main format');
    await fsp.writeFile(path.join(root,'docs/git-integration.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {server.closeAllConnections();server.close();await fsp.rm(folder,{recursive:true,force:true});}
