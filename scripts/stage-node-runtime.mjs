import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
const root=path.resolve(import.meta.dirname,'..');
const source=JSON.parse(await fs.readFile(path.join(root,'docs/node-source.json'),'utf8'));
const stage=path.join(root,'.local/runtime-bundle');
const headers=path.resolve(process.argv[2]||'');
const license=path.resolve(process.argv[3]||'');
if(!process.argv[2]||!process.argv[3])throw Error('Usage: stage-node-runtime.mjs INSTALLED_NODE_HEADERS NODE_LICENSE');
const version=await fs.readFile(path.join(headers,'node_version.h'),'utf8');
for(const [i,part]of source.version.split('.').entries()){
 const macro=['MAJOR','MINOR','PATCH'][i];
 if(!new RegExp('#define NODE_'+macro+'_VERSION\\s+'+part+'(?:\\s|$)').test(version))throw Error('Installed headers do not match pinned Node version');
}
await fs.mkdir(path.join(stage,'headers'),{recursive:true});
await fs.cp(headers,path.join(stage,'headers'),{recursive:true});
await fs.mkdir(path.join(stage,'libraries'),{recursive:true});
await fs.copyFile(license,path.join(stage,'libraries/LICENSE'));
await fs.copyFile(path.join(root,'docs/node-source.json'),path.join(stage,'node-source.json'));
const libraries=[];
for(const abi of ['arm64-v8a','x86_64']){
 const from=path.join(root,'.local/runtime22',abi),to=path.join(stage,'libraries',abi);
 try{await fs.access(path.join(from,'libnode.so'));}catch{continue;}
 const evidence=await fs.readFile(path.join(from,'elf-program-headers.txt'),'utf8');
 const loads=evidence.split(/\r?\n/).filter(line=>/^\s*LOAD\s/.test(line));
 if(!loads.length||loads.some(line=>parseInt(line.trim().split(/\s+/).at(-1),16)<source.pageSize))throw Error('Runtime is not 16 KB aligned: '+abi);
 await fs.cp(from,to,{recursive:true});
 const hash=crypto.createHash('sha256');for await(const bytes of createReadStream(path.join(to,'libnode.so')))hash.update(bytes);
 libraries.push({abi,sha256:hash.digest('hex')});
}
await fs.writeFile(path.join(stage,'libraries/installed.json'),JSON.stringify({libraries,sourceSha256:source.sourceSha256,version:source.version},null,2)+'\n');
console.log('Staged '+libraries.map(x=>x.abi).join(', ')+'. Build both ABIs before creating the release bundle.');