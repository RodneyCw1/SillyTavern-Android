import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..'),folder=path.join(root,'.local/desktop-data/generation-results');
const baseline=fs.readFileSync(path.join(root,'tests/fixtures/android-adapter-1.0.0.js'),'utf8');
const current=await fsp.readFile(path.join(root,'server/public/scripts/android-standalone.js'),'utf8');
const jobs=[];const started=Date.now()+100000;
for(let i=0;i<80;i++){
 const id=crypto.randomUUID(),raw=JSON.stringify({choices:[{message:{content:'memory-fixture-'+i+' '+('汉'.repeat(175000))}}]});
 const job={id,owner:'default-user',endpoint:'/api/backends/chat-completions/generate',createdAt:started+i,finishedAt:started+i,state:'complete',status:200,contentType:'application/json',bytes:Buffer.byteLength(raw),context:{name:'RAM fixture '+i,type:'plugin'},acknowledged:false};
 jobs.push(job);await fsp.writeFile(path.join(folder,id+'.json'),JSON.stringify(job));await fsp.writeFile(path.join(folder,id+'.response'),raw);
}
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--no-first-run'],userDataDir:path.join(root,'.local/memory-browser')});
const report={fixture:{jobs:80,responseBytesEach:jobs[0].bytes},environment:'Desktop Chrome JS heap, isolated Android adapter fixture; not total Android RAM',runs:[]};
try{
 await browser.setCookie({name:'st_android_auth',value:fs.readFileSync(path.join(root,'.local/desktop-data/session-token'),'utf8'),domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Strict'});
 for(const [version,source] of [['1.0.0',baseline],['1.1.0',current]]){
  const page=await browser.newPage();page.on('console',m=>console.log('BROWSER',m.type(),m.text().slice(0,150)));page.on('pageerror',e=>console.log('PAGEERROR',e.message));await page.setRequestInterception(true);let contentRequests=0,previewRequests=0;
  page.on('request',request=>{
   const url=new URL(request.url());
   if(url.pathname==='/')return request.respond({status:200,contentType:'text/html',body:'<!doctype html><html><body><script>window.SillyTavern={getContext:()=>({eventSource:{on(){}},eventTypes:{}})};<\/script></body></html>'});
   if(url.pathname==='/api/android/jobs'&&version==='1.0.0')return request.respond({status:200,contentType:'application/json',body:JSON.stringify(jobs)});
   if(url.pathname.endsWith('/content'))contentRequests++;
   if(url.pathname.endsWith('/preview'))previewRequests++;
   request.continue();
  });
  await page.goto('http://127.0.0.1:17614/');await page.addScriptTag({content:source});
  const session=await page.createCDPSession();await session.send('Performance.enable');
  async function heap(){await session.send('HeapProfiler.collectGarbage');return (await session.send('Performance.getMetrics')).metrics.find(m=>m.name==='JSHeapUsedSize').value;}
  const before=await heap();await page.evaluate(()=>STAndroid.showRecovery());const opened=await heap();
  const run={version,before,opened,openDelta:opened-before,initialContentRequests:contentRequests,rows:await page.$$eval('#st-android-recovery section',e=>e.length)};
  if(version==='1.1.0'){
   assert.equal(contentRequests,0);assert.equal(run.rows,20);
   await page.evaluate(()=>document.querySelector('#st-android-recovery section button').click());
   await (await page.waitForSelector('#st-android-recovery textarea')).dispose();
   run.previewHeap=await heap();assert.equal(await page.$$eval('#st-android-recovery textarea',e=>e.length),1);
   const cycles=[];
   for(let n=0;n<50;n++){
    await page.evaluate(()=>document.querySelector('#st-android-recovery').close());await page.waitForFunction(()=>!document.querySelector('#st-android-recovery'));
    await page.evaluate(()=>STAndroid.showRecovery());await page.evaluate(()=>document.querySelector('#st-android-recovery section button').click());await (await page.waitForSelector('#st-android-recovery textarea')).dispose();
    if(n%10===9){ await new Promise(r=>setTimeout(r,100)); cycles.push(await heap()); console.log('cycle',n+1,cycles.at(-1),await session.send('Memory.getDOMCounters')); }
   }
   run.repeatedOpenHeap=cycles;assert.ok(Math.max(...cycles)-Math.min(...cycles)<512*1024,'Repeated opens must stabilize after warm-up');
  }
  await page.evaluate(()=>document.querySelector('#st-android-recovery').close());
  if(version==='1.1.0')await page.waitForFunction(()=>!document.querySelector('#st-android-recovery'));
  run.afterClose=await heap();run.remainingTextareas=await page.$$eval('textarea',e=>e.length);run.previewRequests=previewRequests;
  report.runs.push(run);await page.close();
 }
 assert.ok(report.runs[1].openDelta<report.runs[0].openDelta*0.2);
 assert.equal(report.runs[1].remainingTextareas,0);
 await fsp.writeFile(path.join(root,'docs/memory-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
 await browser.close();
 for(const job of jobs){await fsp.rm(path.join(folder,job.id+'.json'),{force:true});await fsp.rm(path.join(folder,job.id+'.response'),{force:true});}
}
