
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {importMigration} from '../server/android/migration.js';
const root=path.resolve(import.meta.dirname,'..');
const dir=await fs.mkdtemp(path.join(root,'.local/tests/real-migration-'));
try{
    const result=await importMigration(path.join(root,'releases/personal-migration.zip'),path.join(dir,'data'));
    assert.equal(result.count,198);
    const settings=JSON.parse(await fs.readFile(path.join(dir,'data/default-user/settings.json'),'utf8'));assert.ok(settings);
    await assert.rejects(fs.access(path.join(dir,'data/default-user/secrets.json')));
    await assert.rejects(fs.access(path.join(dir,'data/default-user/extensions')));
    const report={passed:true,files:result.count,uncompressedBytes:result.bytes,credentialsFileIncluded:false,oldPluginCodeIncluded:false};
    await fs.writeFile(path.join(root,'docs/migration-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await fs.rm(dir,{recursive:true,force:true});}
