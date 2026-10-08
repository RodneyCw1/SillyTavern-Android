// Historical workflow; current acceptance uses the version-bound scripts in ANDROID-ACCEPTANCE.md.
if (process.env.ST_RUN_HISTORICAL_TEST !== '1' || !process.env.ST_TEST_DEVICE) throw new Error('Historical test: explicitly set ST_RUN_HISTORICAL_TEST=1 and ST_TEST_DEVICE.');
import fs from 'node:fs/promises';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {once} from 'node:events';import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..'),serial=process.env.ST_TEST_DEVICE,pkg='io.sillytavern.standalone.debug';
const adb=(...args)=>execFileSync(path.join(root,'.local/android-sdk/platform-tools/adb.exe'),['-s',serial,...args],{encoding:'utf8'}).trim();
adb('forward','tcp:17620','tcp:17614');adb('reverse','tcp:17616','tcp:17616');
const token=adb('shell','run-as',pkg,'cat','files/tavern/host-token');
let calls=0;const model=http.createServer(async(req,res)=>{for await(const chunk of req){}calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'安卓内存测试'+calls+' '+('x'.repeat(1024))}}]}));}).listen(17616,'127.0.0.1');await once(model,'listening');
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:17622',defaultViewport:null}),page=(await browser.pages()).find(p=>p.url().includes('17614'));
const session=await page.createCDPSession();await session.send('Performance.enable');
async function measure(label){
 await session.send('HeapProfiler.collectGarbage');
 const heap=(await session.send('Performance.getMetrics')).metrics.find(m=>m.name==='JSHeapUsedSize').value;
 const status=await(await fetch('http://127.0.0.1:17620/api/android/native/status',{headers:{'x-android-host':token}})).json();
 const runtimePid=adb('shell','pidof',pkg+':runtime');
 const procStatus=adb('shell','cat','/proc/'+runtimePid+'/status');
 const androidProcMemory={pid:Number(runtimePid)};
 for(const match of procStatus.matchAll(/^(VmRSS|VmHWM|RssAnon|RssFile|VmSwap):\s+([0-9]+)/gm)){
  androidProcMemory[match[1]+'KiB']=Number(match[2]);
 }
 return {label,androidProcMemory,rendererJsHeap:heap,frontend:await page.evaluate(()=>STAndroid.diagnostics()),backend:status.memory};
}
const report={device:serial,android:adb('shell','getprop','ro.build.version.release'),pageSize:adb('shell','getconf','PAGESIZE'),model:'Local deterministic HTTP fixture, no keys or paid requests',samples:[]};
try{
 report.samples.push(await measure('before'));
 for(let batch=0;batch<3;batch++){
  await page.evaluate(async()=>{
   for(let i=0;i<64;i++){
    const r=await fetch('/api/backends/chat-completions/generate',{method:'POST',headers:SillyTavern.getContext().getRequestHeaders(),body:JSON.stringify({chat_completion_source:'custom',custom_url:'http://127.0.0.1:17616/v1',model:'mock',messages:[{role:'user',content:'memory fixture'}],stream:false})});
    const result=await r.json();if(!result.choices?.[0]?.message?.content?.startsWith('安卓内存测试'))throw new Error('Generation did not finish normally');
   }
  });
  await new Promise(r=>setTimeout(r,300));
  const sample=await measure('after '+((batch+1)*64)+' requests');assert.equal(sample.frontend.trackedJobs,0);assert.ok(sample.backend.cachedJobs<=64);assert.equal(sample.backend.workers,0);report.samples.push(sample);
 }
 report.modelCalls=calls;assert.equal(calls,192);
 const heaps=report.samples.slice(1).map(x=>x.rendererJsHeap);assert.ok(Math.max(...heaps)-Math.min(...heaps)<8*1024*1024,'Renderer must not retain every completed request');
 await fs.writeFile(path.join(root,'docs/memory-android.json'),JSON.stringify(report,null,2));
 await fs.writeFile(path.join(root,'docs/memory-android-processes.txt'),adb('shell','dumpsys','meminfo',pkg));
 await fs.writeFile(path.join(root,'docs/memory-android-runtime.txt'),adb('shell','dumpsys','meminfo',pkg+':runtime'));
 console.log(JSON.stringify(report,null,2));
}finally{browser.disconnect();model.closeAllConnections();model.close();}
