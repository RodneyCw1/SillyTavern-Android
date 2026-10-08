import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sha256} from '../server/android/files.js';
const root=path.resolve(import.meta.dirname,'..');
const elf=path.join(root,'.local/android-sdk/ndk/28.2.13676358/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-readelf.exe');
const report={...JSON.parse(await fsp.readFile(path.join(root,'docs/node-source.json'),'utf8')),libraries:[]};
for(const abi of ['arm64-v8a','x86_64']){
    const folder=path.join(root,'android/app/build/intermediates/merged_native_libs/release/mergeReleaseNativeLibs/out/lib',abi);
    for(const name of await fsp.readdir(folder)){
        if(!name.endsWith('.so'))continue;
        const file=path.join(folder,name);const headers=execFileSync(elf,['-lW',file],{encoding:'utf8'});
        const loads=headers.split(/\r?\n/).filter(l=>/^\s*LOAD\s/.test(l));
        if(!loads.length||loads.some(l=>parseInt(l.trim().split(/\s+/).at(-1),16)<16384))throw new Error('ELF is not 16 KB aligned: '+file);
        report.libraries.push({abi,name,sha256:await sha256(file),loadAlignments:loads.map(l=>l.trim().split(/\s+/).at(-1))});
    }
}
await fsp.writeFile(path.join(root,'docs/native-verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
