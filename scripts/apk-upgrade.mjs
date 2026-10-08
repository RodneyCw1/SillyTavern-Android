// Historical workflow; current acceptance uses the version-bound scripts in ANDROID-ACCEPTANCE.md.
if (process.env.ST_RUN_HISTORICAL_TEST !== '1' || !process.env.ST_TEST_DEVICE) throw new Error('Historical test: explicitly set ST_RUN_HISTORICAL_TEST=1 and ST_TEST_DEVICE.');
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),serial=process.env.ST_TEST_DEVICE,pkg='io.sillytavern.standalone';
const adb=(...args)=>execFileSync(path.join(root,'.local/android-sdk/platform-tools/adb.exe'),['-s',serial,...args],{encoding:'utf8',timeout:120000}).trim();
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const home='/data/user/0/'+pkg+'/files/tavern';
const snapshot=path.join(root,'.local/upstream-update/apk-before.json');
const version=()=>adb('shell','dumpsys','package',pkg).match(/versionName=([^\s]+)/)?.[1];
const hash=file=>adb('shell','sha256sum',quote(file)).split(/\s+/)[0];
if(process.argv[2]==='before'){
 adb('shell','am','force-stop',pkg);
 const files=adb('shell','find',home+'/data/default-user','-type','f').split(/\r?\n/).filter(Boolean);
 files.push(home+'/host-token');
 const hashes=Object.fromEntries(files.map(f=>[f,hash(f)]));
 await fs.writeFile(snapshot,JSON.stringify({version:version(),hashes},null,2));
 console.log(JSON.stringify({beforeVersion:version(),files:files.length}));
}else{
 const before=JSON.parse(await fs.readFile(snapshot,'utf8'));
 adb('install','-r',path.join(root,'releases/SillyTavern-Standalone-1.1.0-release.apk'));
 assert.equal(version(),'1.1.0');
 const changed=Object.entries(before.hashes).filter(([f,h])=>hash(f)!==h).map(([f])=>f);
 assert.deepEqual(changed,[]);
 const report={device:serial,from:before.version,to:version(),filesChecked:Object.keys(before.hashes).length,changed,check:'Same-signature APK installation preserves existing personal files and host identity before first upgraded launch'};
 await fs.writeFile(path.join(root,'docs/apk-upgrade-1.1.0.json'),JSON.stringify(report,null,2));
 console.log(report);
}
