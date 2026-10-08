import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv[2]==='--child'){
 const {JobStore}=await import(pathToFileURL(process.argv[3]).href);
 global.gc();const before=process.memoryUsage().heapUsed;
 const store=new JobStore(process.argv[4]);await store.initialize();
 for(const name of (await fsp.readdir(process.argv[4])).filter(n=>n.endsWith('.json')))if(store.get)await store.get(name.slice(0,-5));
 global.gc();const after=process.memoryUsage().heapUsed;
 console.log(JSON.stringify({before,after,heapDelta:after-before,cachedJobs:store.jobs.size}));process.exit();
}
const dir=await fsp.mkdtemp(path.join(root,'.local/tests/store-profile-'));
try{
 for(let i=0;i<1000;i++){
  const id=crypto.randomUUID();await fsp.writeFile(path.join(dir,id+'.json'),JSON.stringify({id,owner:'default-user',state:'complete',bytes:0,createdAt:i+1,finishedAt:i+1,context:{name:'memory-'+i,previousText:String(i).padEnd(32000,'汉')}}));
  await fsp.writeFile(path.join(dir,id+'.response'),'');
 }
 const measure=file=>JSON.parse(execFileSync(process.env.ST_TEST_NODE || process.execPath,['--expose-gc',fileURLToPath(import.meta.url),'--child',path.join(root,file),dir],{encoding:'utf8',maxBuffer:1024*1024}));
 const report={environment:'Node.js '+execFileSync(process.env.ST_TEST_NODE || process.execPath,['--version'],{encoding:'utf8'}).trim()+' on Windows; JavaScript heap only, not total Android RSS',fixture:{jobs:1000,contextCharacters:32000},baseline:measure('tests/fixtures/android-jobs-1.0.0.mjs'),updated:measure('server/android/jobs.js')};
 assert.equal(report.baseline.cachedJobs,1000);assert.ok(report.updated.cachedJobs<=64);assert.ok(report.updated.heapDelta<report.baseline.heapDelta*0.2);
 await fsp.writeFile(path.join(root,'docs/memory-store.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await fsp.rm(dir,{recursive:true,force:true});}
