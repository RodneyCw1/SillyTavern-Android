// Historical workflow; current acceptance uses the version-bound scripts in ANDROID-ACCEPTANCE.md.
if (process.env.ST_RUN_HISTORICAL_TEST !== '1' || !process.env.ST_TEST_DEVICE) throw new Error('Historical test: explicitly set ST_RUN_HISTORICAL_TEST=1 and ST_TEST_DEVICE.');
import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';import {pipeline} from 'node:stream/promises';
const root=path.resolve(import.meta.dirname,'..'),serial=process.env.ST_TEST_DEVICE,pkg='io.sillytavern.standalone',home='/data/user/0/'+pkg+'/files/tavern';
const adb=(...args)=>execFileSync(path.join(root,'.local/android-sdk/platform-tools/adb.exe'),['-s',serial,...args],{encoding:'utf8',timeout:120000}).trim();
const archiver=createRequire(path.join(root,'server/package.json'))('archiver');
const token=adb('shell','cat',home+'/host-token');
adb('forward','tcp:17620','tcp:17614');
async function request(endpoint){return fetch('http://127.0.0.1:17620/api/android/native/'+endpoint,{method:endpoint==='import'?'POST':'GET',headers:{'x-android-host':token},signal:AbortSignal.timeout(120000)});}
async function ready(){for(let i=0;i<90;i++){try{if((await(await request('status')).json()).ready)return;}catch{}await new Promise(r=>setTimeout(r,1000));}throw new Error('Startup timed out');}
const report={device:serial,package:pkg,checks:[]};
await ready();
const oldSettings=adb('shell','cat',home+'/data/default-user/settings.json');
const beforePlugin=adb('shell','sha256sum',home+'/data/default-user/extensions/JS-Slash-Runner/dist/index.js').split(' ')[0];
const local=path.join(root,'.local/native-migration.zip');
async function makeZip(corrupt){
 const z=archiver('zip');const done=pipeline(z,fs.createWriteStream(local));const files=[];
 const contents={'settings.json':JSON.stringify({androidMigrationFixture:'中文😀'}),'chats/迁移角色/大聊天.jsonl':[{user_name:'用户',character_name:'迁移角色',create_date:'2026-09-10T00:00:00.000Z',chat_metadata:{fixture_version:'1.14.0'}},...Array.from({length:5000},(_,i)=>({name:'测试',mes:'大聊天中文😀 '+i,is_user:i%2===0,is_system:false,send_date:'2026-09-10T00:00:00.000Z',extra:{}}))].map(row=>JSON.stringify(row)).join('\n')};
 for(const [name,content]of Object.entries(contents)){const b=Buffer.from(content);files.push({path:name,size:b.length,sha256:corrupt?'0'.repeat(64):crypto.createHash('sha256').update(b).digest('hex')});z.append(b,{name:'user/'+name});}
 z.append(JSON.stringify({format:'sillytavern-android-migration',version:1,files}),{name:'manifest.json'});await z.finalize();await done;
 adb('shell','mkdir','-p',home+'/imports');adb('push',local,home+'/imports/incoming.zip');
}
await makeZip(true);let response=await request('import');assert.equal(response.status,400);assert.equal(adb('shell','cat',home+'/data/default-user/settings.json'),oldSettings);report.checks.push('Corrupt ZIP rejected on Android; current settings unchanged');
await makeZip(false);response=await request('import');assert.equal(response.status,200,await response.clone().text());const imported=await response.json();assert.ok(imported.backup);report.backup=imported.backup;
assert.equal(JSON.parse(adb('shell','cat',home+'/data/default-user/settings.json')).androidMigrationFixture,'中文😀');
assert.equal(adb('shell','sha256sum',home+'/data/default-user/extensions/JS-Slash-Runner/dist/index.js').split(' ')[0],beforePlugin);
assert.equal(adb('shell','cat',JSON.stringify(home+'/data/default-user/chats/迁移角色/大聊天.jsonl')).split('\n').length,5001);
report.checks.push('Valid native import creates backup, preserves Helper 4.9.5, and writes Chinese 5000-message chat');
adb('shell','am','force-stop',pkg);adb('install','-r',path.join(root,'releases/SillyTavern-Standalone-1.1.0-release.apk'));adb('shell','am','start','-n',pkg+'/io.sillytavern.standalone.MainActivity');
await ready();assert.equal(JSON.parse(adb('shell','cat',home+'/data/default-user/settings.json')).androidMigrationFixture,'中文😀');assert.equal(adb('shell','cat',home+'/host-token'),token);
report.checks.push('Same-signature APK replacement retains migrated data and host identity');
let cookie='st_android_auth='+token;
const csrfResponse=await fetch('http://127.0.0.1:17620/csrf-token',{headers:{cookie}});
for(const set of csrfResponse.headers.getSetCookie())cookie+='; '+set.split(';')[0];
const csrf=(await csrfResponse.json()).token;
const chatResponse=await fetch('http://127.0.0.1:17620/api/chats/get',{method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify({ch_name:'迁移角色',avatar_url:'迁移角色.png',file_name:'大聊天'})});
assert.equal(chatResponse.status,200);
const chat=await chatResponse.json();assert.equal(chat.length,5001);
assert.equal(chat[0].chat_metadata.fixture_version,'1.14.0');
assert.equal(chat[1].mes,'大聊天中文😀 0');assert.equal(chat.at(-1).mes,'大聊天中文😀 4999');
report.checks.push('SillyTavern 1.19 reads the imported 1.14-format header and all 5000 Chinese messages through the original chat API');

await fsp.writeFile(path.join(root,'docs/android-migration-upgrade.json'),JSON.stringify(report,null,2));console.log(report);
