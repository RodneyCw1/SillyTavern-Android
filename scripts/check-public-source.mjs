import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectSourceFiles } from './source-inventory.mjs';
const root=path.resolve(import.meta.dirname,'..');
const forbidden=/(^|\/)(?:SillyTavern-Android-Signing|compatibility|\.local|node_modules|data|backups|uploads)(\/|$)|\.(?:p12|pfx|jks|keystore|dpapi|apk|so)$|(?:^|\/)(?:signing-password[^/]*|PRIVATE-MIGRATION-INVENTORY\.json|README-MIGRATION\.txt|\.env(?:\.[^/]*)?)$/i;
let files;
try{files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean);}
catch{files=await collectSourceFiles(root);}
if(!files.length)files=await collectSourceFiles(root);
for(const relative of files){
    if(/^docs\/acceptance(?:\/|$)/.test(relative)||/\.(?:tar\.gz|tar\.xz)$/.test(relative)||forbidden.test(relative)||/^server\/android\/bundled-extensions\//.test(relative)||/^android\/app\/src\/main\/cpp\/node-include\//.test(relative))throw Error('Forbidden public file: '+relative);
    const stat=await fs.stat(path.join(root,relative));if(stat.size>100*1024*1024)throw Error('Oversized Git source file: '+relative);
    if(/\.(?:json|yaml|yml|md|js|mjs|kt|ps1|txt)$/.test(relative)&&stat.size<4*1024*1024){
        const text=await fs.readFile(path.join(root,relative),'utf8');
        if(/\bgh[pousr]_[A-Za-z0-9_]{30,}\b|\bAIza[A-Za-z0-9_-]{35}\b/.test(text))throw Error('Possible credential in public file: '+relative);
    }
}
const index=JSON.parse(await fs.readFile(path.join(root,'server/default/content/index.json'),'utf8'));
if(index.some(item=>['character','world','sprites'].includes(item.type)))throw Error('Public package must contain no character/world defaults');
const meta=JSON.parse(await fs.readFile(path.join(root,'docs/plugins-lock.json'),'utf8'));
if(meta.length)throw Error('Third-party preinstalled plugins are not allowed');
console.log('Public source audit passed: '+files.length+' files; no private paths or preinstalled content.');
