import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { collectSourceFiles, getSourceHash, hashSourceFile } from './source-inventory.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'server/package.json'));
const archiver = require('archiver');
const { version } = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
const folder = path.join(root, 'releases');
await fsp.mkdir(folder, { recursive: true });
const destination = path.join(folder, `SillyTavern-Android-${version}-source.zip`);
const temp = destination + '.' + crypto.randomUUID() + '.tmp';
const files = await collectSourceFiles(root);
const inventory = [];
const zip = archiver('zip', { zlib: { level: 6 } });
const output = fs.createWriteStream(temp, { flags: 'wx' });
const completed = pipeline(zip, output);
completed.catch(() => {});
zip.on('warning', error => zip.destroy(error));
try {
    for (const relative of files) {
        inventory.push({ path: relative, ...await hashSourceFile(path.join(root, relative)) });
        zip.file(path.join(root, relative), { name: 'SillyTavern-Android/' + relative });
    }
    await zip.finalize();
    await completed;
    await fsp.rename(temp, destination);
    const report = { appVersion: version, sourceHash: await getSourceHash(root, files), createdAt: new Date().toISOString(), files: inventory };
    await fsp.writeFile(path.join(folder, `source-inventory-${version}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ path: destination, files: inventory.length, sourceHash: report.sourceHash }));
} catch (error) {
    zip.abort(); zip.destroy(error); output.destroy(error);
    await completed.catch(() => {});
    await fsp.rm(temp, { force: true });
    throw error;
}
