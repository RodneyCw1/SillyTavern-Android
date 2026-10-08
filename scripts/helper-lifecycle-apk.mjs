// Historical workflow; current acceptance uses the version-bound scripts in ANDROID-ACCEPTANCE.md.
if (process.env.ST_RUN_HISTORICAL_TEST !== '1' || !process.env.ST_TEST_DEVICE) throw new Error('Historical test: explicitly set ST_RUN_HISTORICAL_TEST=1 and ST_TEST_DEVICE.');
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),serial=process.env.ST_TEST_DEVICE,pkg='io.sillytavern.standalone';
const home='/data/user/0/'+pkg+'/files/tavern',base='/scripts/extensions/third-party/JS-Slash-Runner/';
const adb=(...args)=>execFileSync(path.join(root,'.local/android-sdk/platform-tools/adb.exe'),['-s',serial,...args],{encoding:'utf8',timeout:180000}).trim();
const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
const read=file=>adb('shell','cat',q(home+'/'+file));
const hash=file=>adb('shell','sha256sum',q(file)).split(/\s+/)[0];
const version=()=>adb('shell','dumpsys','package',pkg).match(/versionName=([^\s]+)/)?.[1];
const digest=()=>adb('shell',"find "+q(home+'/data/default-user')+" -type f -exec sha256sum '{}' ';'").split(/\r?\n/).filter(Boolean).sort();
const mode=process.argv[2];
assert.ok(['before','after'].includes(mode));
adb('shell','am','force-stop',pkg+'.debug');adb('shell','am','force-stop',pkg);
const report={testedAt:new Date().toISOString(),mode,device:serial,checks:[]};
if(mode==='after'){
 const files=digest(),identity=hash(home+'/host-token');report.from=version();
 assert.equal(report.from,'1.1.1');
 adb('install','-r',path.join(root,'releases/SillyTavern-Standalone-1.1.2-release.apk'));
 assert.equal(version(),'1.1.2');assert.deepEqual(digest(),files);assert.equal(hash(home+'/host-token'),identity);
 report.upgrade={filesPreserved:files.length,hostIdentityPreserved:true};
}
adb('forward','tcp:17624','tcp:17614');
let cookie='st_android_auth='+read('host-token'),csrf;
async function call(url,body,timeout=180000){
 const res=await fetch('http://127.0.0.1:17624'+url,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json',...(csrf?{'x-csrf-token':csrf}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeout)});
 for(const set of res.headers.getSetCookie())cookie+='; '+set.split(';')[0];return res;
}
async function start(){
 adb('shell','am','start','-n',pkg+'/io.sillytavern.standalone.MainActivity');
 for(let i=0;i<120;i++){
  try{const res=await call('/csrf-token',undefined,5000);if(res.ok){csrf=(await res.json()).token;return;}}catch{}
  await new Promise(r=>setTimeout(r,1000));
 }
 throw new Error('APK did not start');
}
async function api(endpoint,body){const res=await call('/api/extensions/'+endpoint,body);assert.equal(res.status,200,await res.clone().text());return res;}
const options={extensionName:'JS-Slash-Runner',global:false};
const url='https://gitlab.com/novi028/JS-Slash-Runner';
async function actual(){
 const manifest=await (await call(base+'manifest.json')).json();
 const disk=JSON.parse(read('data/default-user/extensions/JS-Slash-Runner/manifest.json'));
 const servedHash=crypto.createHash('sha256').update(Buffer.from(await (await call(base+'dist/index.js')).arrayBuffer())).digest('hex');
 const diskHash=hash(home+'/data/default-user/extensions/JS-Slash-Runner/dist/index.js');
 const status=await (await api('version',options)).json();
 return {displayVersion:manifest.version,installedVersion:disk.version,servedHash,diskHash,isUpToDate:status.isUpToDate,remoteUrl:status.remoteUrl};
}
try{
 await start();report.appVersion=version();
 if(mode==='before'){
  assert.equal(version(),'1.1.1');
  await api('delete',options);
  report.afterUninstall={manifestStatus:(await call(base+'manifest.json')).status,scriptStatus:(await call(base+'dist/index.js')).status};
  await api('install',{url,global:false});
  report.reinstalled=await actual();
  assert.equal(report.reinstalled.displayVersion,'4.9.5');
  assert.equal(report.reinstalled.installedVersion,'4.11.2');
  assert.equal(report.reinstalled.isUpToDate,true);
  assert.notEqual(report.reinstalled.servedHash,report.reinstalled.diskHash);
  report.checks.push('Reproduced: uninstall still serves bundled files; reinstall stores 4.11.2 and reports up to date while serving 4.9.5');
 }else{
  report.afterUpgrade=await actual();
  assert.equal(report.afterUpgrade.displayVersion,'4.11.2');
  assert.equal(report.afterUpgrade.servedHash,report.afterUpgrade.diskHash);
  report.checks.push('Cover upgrade serves the installed 4.11.2 manifest and exact JavaScript bytes');
  await api('delete',options);
  for(const file of ['manifest.json','dist/index.js','lib/iframe_client.js'])assert.equal((await call(base+file)).status,404);
  adb('shell','am','force-stop',pkg);await start();
  assert.equal((await call(base+'manifest.json')).status,404);
  const discover=await (await call('/api/extensions/discover')).json();
  assert.ok(!discover.some(e=>e.name==='third-party/JS-Slash-Runner'));
  report.checks.push('Uninstall returns 404 for manifest/script and stays uninstalled across a full app restart');
  await api('install',{url,global:false});report.reinstalled=await actual();
  assert.equal(report.reinstalled.displayVersion,'4.11.2');assert.equal(report.reinstalled.installedVersion,'4.11.2');
  assert.equal(report.reinstalled.servedHash,report.reinstalled.diskHash);assert.equal(report.reinstalled.isUpToDate,true);
  await api('update',options);
  adb('shell','am','force-stop',pkg);await start();
  report.afterUpdateAndRestart=await actual();
  assert.equal(report.afterUpdateAndRestart.displayVersion,'4.11.2');
  assert.equal(report.afterUpdateAndRestart.servedHash,report.afterUpdateAndRestart.diskHash);
  report.checks.push('Reinstall, update and full restart consistently load the real 4.11.2 files');
  // Global-only installation must use the same resource route and not a bundled copy.
  await api('delete',options);
  await api('install',{url,global:true});
  assert.equal((await(await call(base+'manifest.json')).json()).version,'4.11.2');
  const globalHash=hash(home+'/data/_global/extensions/JS-Slash-Runner/dist/index.js');
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await(await call(base+'dist/index.js')).arrayBuffer())).digest('hex'),globalHash);
  await api('delete',{...options,global:true});
  assert.equal((await call(base+'manifest.json')).status,404);
  await api('install',{url,global:false});
  report.checks.push('Global-only install serves its actual files and uninstall does not expose a bundled fallback');
 }
 report.passed=true;
}finally{
 await fs.writeFile(path.join(root,'docs/helper-lifecycle-'+mode+'-1.1.2.json'),JSON.stringify(report,null,2));
 adb('forward','--remove','tcp:17624');
 console.log(JSON.stringify(report,null,2));
}
