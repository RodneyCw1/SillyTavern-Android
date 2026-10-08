// Historical workflow; current acceptance uses the version-bound scripts in ANDROID-ACCEPTANCE.md.
if (process.env.ST_RUN_HISTORICAL_TEST !== '1' || !process.env.ST_TEST_DEVICE) throw new Error('Historical test: explicitly set ST_RUN_HISTORICAL_TEST=1 and ST_TEST_DEVICE.');
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Run only on this project's dedicated, rooted test emulator. No real user device.
const root=path.resolve(import.meta.dirname,'..'),serial=process.env.ST_TEST_DEVICE,pkg='io.sillytavern.standalone';
const home='/data/user/0/'+pkg+'/files/tavern',helper='JS-Slash-Runner';
const adb=(...args)=>execFileSync(path.join(root,'.local/android-sdk/platform-tools/adb.exe'),['-s',serial,...args],{encoding:'utf8',timeout:180000}).trim();
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const read=file=>adb('shell','cat',quote(home+'/'+file));
const hash=file=>adb('shell','sha256sum',quote(file)).split(/\s+/)[0];
const version=()=>adb('shell','dumpsys','package',pkg).match(/versionName=([^\s]+)/)?.[1];
const digestFolder=folder=>adb('shell','find '+quote(folder)+" -type f -exec sha256sum '{}' ';'").split(/\r?\n/).filter(Boolean).sort();
const report={testedAt:new Date().toISOString(),device:serial,package:pkg,android:adb('shell','getprop','ro.build.version.release'),pageSize:Number(adb('shell','getconf','PAGESIZE')),checks:[]};
adb('shell','am','force-stop',pkg+'.debug');
adb('shell','am','force-stop',pkg);
const beforeVersion=version(),beforeFiles=digestFolder(home+'/data/default-user'),identity=hash(home+'/host-token');
assert.equal(beforeVersion,'1.1.0','This upgrade fixture starts with 1.1.0');
adb('install','-r',path.join(root,'releases/SillyTavern-Standalone-1.1.1-release.apk'));
assert.equal(version(),'1.1.1');
assert.deepEqual(digestFolder(home+'/data/default-user'),beforeFiles);
assert.equal(hash(home+'/host-token'),identity);
report.upgrade={from:beforeVersion,to:version(),personalFilesChecked:beforeFiles.length,changed:0,hostIdentityPreserved:true};
report.checks.push('Same-signature cover installation preserves all existing personal files and host identity before launch');
console.log(JSON.stringify({upgrade:report.upgrade}));
adb('forward','tcp:17624','tcp:17614');
adb('shell','am','start','-n',pkg+'/io.sillytavern.standalone.MainActivity');
const token=read('host-token');let cookie='st_android_auth='+token,csrf;
async function request(url,body,native=false,timeout=180000){
 const response=await fetch('http://127.0.0.1:17624'+url,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json',...(csrf?{'x-csrf-token':csrf}:{}),...(native?{'x-android-host':token}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeout)});
 for(const set of response.headers.getSetCookie())cookie+='; '+set.split(';')[0];
 return response;
}
let ready=false,lastError;
for(let i=0;i<120;i++){
 try{ready=(await (await request('/api/android/native/status',undefined,true,5000)).json()).ready;if(ready)break;}catch(e){lastError=e.message;}
 await new Promise(r=>setTimeout(r,1000));
}
assert.ok(ready,'APK startup: '+lastError);
csrf=(await(await request('/csrf-token')).json()).token;
report.runtime=JSON.parse(read('runtime-checks.json'));
report.core=(await(await request('/version')).json()).pkgVersion;
assert.equal(report.core,'1.19.0');assert.equal(report.runtime.node,'v22.23.2');assert.equal(report.runtime.wasm,true);
const metadata=JSON.parse(await fs.readFile(path.join(root,'docs/runtime-version.json'),'utf8'));
const sourceHash=crypto.createHash('sha256').update(await fs.readFile(path.join(root,'server/android/extensions.js'))).digest('hex');
assert.equal(hash(home+'/runtimes/'+metadata.runtimeSha256+'/android/extensions.js'),sourceHash);
report.deployedExtensionsSha256=sourceHash;
report.checks.push('Release APK starts the expected core and Node/WASM; deployed extension backend matches repaired source byte-for-byte');
console.log('APK startup and repaired source deployment passed');
const inputUrl='https://gitlab.com/novi028/JS-Slash-Runner',options={extensionName:helper,global:true};
const globalFolder=home+'/data/_global/extensions/'+helper;
adb('shell','test','!','-e',quote(globalFolder));
const localBefore=digestFolder(home+'/data/default-user/extensions/'+helper);
let created=false;
async function json(endpoint,body){
 const response=await request('/api/extensions/'+endpoint,body),text=await response.text();
 report.operations??=[];report.operations.push({endpoint,status:response.status});
 assert.equal(response.status,200,endpoint+': '+text);return JSON.parse(text);
}
try{
 report.inputUrl=inputUrl;
 report.installed=await json('install',{url:inputUrl,global:true});created=true;delete report.installed.extensionPath;
 const installedOrigin=JSON.parse(read('data/_global/extensions/'+helper+'/.android-origin.json'));
 assert.equal(installedOrigin.url,inputUrl+'.git');
 report.commit=installedOrigin.commit;
 report.checks.push('The exact URL from the user installs successfully through the signed APK original HTTP API');
 const installed=await json('version',options);assert.equal(installed.isUpToDate,true);
 const branches=await json('branches',options);assert.ok(branches.some(b=>b.name==='origin/main'));
 const invalid=await request('/api/extensions/switch',{...options,branch:'origin/does-not-exist-422-fixture'});
 assert.ok(invalid.status>=400);
 assert.equal(JSON.parse(read('data/_global/extensions/'+helper+'/.android-origin.json')).commit,report.commit);
 report.checks.push('Version and branch listing work; a failed branch switch preserves the installed version');
 await json('update',options);
 const duplicate=await request('/api/extensions/install',{url:inputUrl,global:true});assert.equal(duplicate.status,409);
 report.checks.push('Staged update succeeds and duplicate installation retains HTTP 409 protection');
 report.passed=true;
}catch(error){
 report.passed=false;report.failure=error.message;process.exitCode=1;
}finally{
 if(created){
  const deleted=await request('/api/extensions/delete',options);assert.equal(deleted.status,200,await deleted.text());
  adb('shell','test','!','-e',quote(globalFolder));
 }
 assert.deepEqual(digestFolder(home+'/data/default-user/extensions/'+helper),localBefore);
 report.testPluginRemoved=created;report.originalUserPluginUnchanged=true;
 adb('forward','--remove','tcp:17624');
 await fs.writeFile(path.join(root,'docs/gitlab-apk-1.1.1.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}
