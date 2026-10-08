// Historical workflow; current acceptance uses the version-bound scripts in ANDROID-ACCEPTANCE.md.
if (process.env.ST_RUN_HISTORICAL_TEST !== '1' || !process.env.ST_TEST_DEVICE) throw new Error('Historical test: explicitly set ST_RUN_HISTORICAL_TEST=1 and ST_TEST_DEVICE.');
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..'),serial=process.env.ST_TEST_DEVICE,pkg='io.sillytavern.standalone.debug';
const adb=(...args)=>execFileSync(path.join(root,'.local/android-sdk/platform-tools/adb.exe'),['-s',serial,...args],{encoding:'utf8',timeout:120000}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){let last;for(let i=0;i<90;i++){try{const v=await fn();if(v)return v;}catch(e){last=e;}await sleep(1000);}throw last||new Error('Timed out');}
adb('shell','am','force-stop','io.sillytavern.standalone');
adb('install','-r',path.join(root,'releases/SillyTavern-Standalone-1.1.0-debug.apk'));
adb('shell','am','start','-n',pkg+'/io.sillytavern.standalone.MainActivity');
adb('shell','input','keyevent','KEYCODE_WAKEUP');adb('shell','wm','dismiss-keyguard');
adb('forward','tcp:17620','tcp:17614');
const token=adb('shell','run-as',pkg,'cat','files/tavern/host-token');
const status=async()=>await(await fetch('http://127.0.0.1:17620/api/android/native/status',{headers:{'x-android-host':token},signal:AbortSignal.timeout(3000)})).json();
await until(async()=>(await status()).ready);
const mainPid=adb('shell','pidof',pkg),runtimePid=adb('shell','pidof',pkg+':runtime');
adb('forward','tcp:17622','localabstract:webview_devtools_remote_'+mainPid);
await until(async()=> (await fetch('http://127.0.0.1:17622/json/list')).ok);
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:17622',defaultViewport:null,protocolTimeout:5000});
const page=await until(async()=> (await browser.pages()).find(p=>p.url().includes('17614')));
await page.waitForFunction(()=>window.STAndroid,{timeout:90000});
const client=await page.createCDPSession();
try{await client.send('Page.crash');}catch{} // Deliberately terminate the renderer, never the host process.
await sleep(1000);
assert.equal(adb('shell','pidof',pkg),mainPid);
assert.equal(adb('shell','pidof',pkg+':runtime'),runtimePid);
assert.equal((await status()).ready,true);
adb('shell','uiautomator','dump','/sdcard/st-renderer-recovery.xml');
const xml=adb('shell','cat','/sdcard/st-renderer-recovery.xml');
const entry=xml.match(/<node[^>]*text="页面进程已停止[^>]*>/)?.[0];assert.ok(entry,'Renderer recovery message must be visible');
const b=entry.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);assert.ok(b);
adb('shell','input','tap',String(Math.floor((+b[1]+ +b[3])/2)),String(Math.floor((+b[2]+ +b[4])/2)));
browser.disconnect();
const reconnected=await puppeteer.connect({browserURL:'http://127.0.0.1:17622',defaultViewport:null});
try{
 const restored=await until(async()=> (await reconnected.pages()).find(p=>p.url().includes('17614')));
 await restored.waitForFunction(()=>window.STAndroid && window.SillyTavern?.getContext,{timeout:90000});
 assert.equal(adb('shell','pidof',pkg),mainPid);assert.equal(adb('shell','pidof',pkg+':runtime'),runtimePid);
 const report={device:serial,appVersion:'1.1.0',trigger:'DevTools Page.crash: controlled renderer termination',mainProcessSurvived:true,runtimeProcessSurvived:true,nativeRecoveryMessage:true,pageReopened:true,limitation:'Does not catch a native crash in the host process WebView library.'};
 await fs.writeFile(path.join(root,'docs/renderer-recovery-android.json'),JSON.stringify(report,null,2));console.log(report);
}finally{reconnected.disconnect();}
