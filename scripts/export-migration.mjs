import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isMigrationPath, stripCredentials } from '../server/android/files.js';

const root = path.resolve(import.meta.dirname, '..');
if (!process.argv[2]) throw new Error('Usage: node scripts/export-migration.mjs <source-user-directory> [output.zip]');
const source = path.resolve(process.argv[2]);
const destination = path.resolve(process.argv[3] || path.join(root, 'releases/personal-migration.zip'));
if (!destination.startsWith(root + path.sep)) throw new Error('Migration output must stay in the Android project');
const require = createRequire(path.join(root, 'server/package.json'));
const archiver = require('archiver');
const jsonLimit = 32 * 1024 ** 2;
await fsp.mkdir(path.dirname(destination), { recursive: true });
const zip = archiver('zip', { zlib: { level: 6 } });
const temp = destination + '.' + crypto.randomUUID() + '.tmp';
const output = fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 });
const completed = pipeline(zip, output);
completed.catch(() => {}); // Awaited below; register immediately while walking files.
const files = [], removedCredentials = [];
let archiveError;
let activeStream;
zip.on('error', error => { archiveError = error; activeStream?.destroy(error); });
zip.on('warning', error => zip.destroy(error));

// Only one entry is queued at a time, including its compression and output.
function append(input, name) {
    if (archiveError) return Promise.reject(archiveError);
    return new Promise((resolve, reject) => {
        const finish = error => {
            zip.off('entry', onEntry); zip.off('error', onError);
            error ? reject(error) : resolve();
        };
        const onEntry = () => finish();
        const onError = error => finish(error);
        zip.once('entry', onEntry); zip.once('error', onError);
        zip.append(input, { name });
    });
}

async function sanitizedJson(file, relative) {
    const chunks = [];
    let size = 0;
    for await (const chunk of fs.createReadStream(file)) {
        size += chunk.length;
        if (size > jsonLimit) throw new Error('Migration JSON exceeds 32 MiB: ' + relative);
        chunks.push(chunk);
    }
    const changes = [];
    const data = stripCredentials(JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')), changes);
    if (changes.length) removedCredentials.push({ path: relative, fields: changes });
    return Buffer.from(JSON.stringify(data));
}

async function walk(dir, relative = '') {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const rel = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            if (isMigrationPath(rel + '/placeholder')) await walk(path.join(dir, entry.name), rel);
        } else if (entry.isFile() && isMigrationPath(rel)) {
            const file = path.join(dir, entry.name);
            if (entry.name.toLowerCase().endsWith('.json')) {
                const bytes = await sanitizedJson(file, rel);
                await append(bytes, 'user/' + rel);
                files.push({ path: rel, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
            } else {
                const hash = crypto.createHash('sha256');
                let size = 0;
                const meter = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
                activeStream = meter;
                const entryDone = append(meter, 'user/' + rel);
                const copied = pipeline(fs.createReadStream(file), meter);
                copied.catch(error => zip.destroy(error));
                await Promise.all([copied, entryDone]);
                activeStream = null;
                files.push({ path: rel, size, sha256: hash.digest('hex') });
            }
        }
    }
}

try {
    await walk(source);
    if (!files.some(file => file.path === 'settings.json')) throw new Error('Source settings.json is missing');
    await append(JSON.stringify({ format: 'sillytavern-android-migration', version: 1, createdAt: new Date().toISOString(), files }), 'manifest.json');
    await zip.finalize();
    await completed;
    await fsp.rename(temp, destination);
    const bytes = (await fsp.stat(destination)).size;
    await fsp.writeFile(path.join(path.dirname(destination), 'migration-report.json'), JSON.stringify({ files: files.length, bytes, removedCredentials }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ path: destination, files: files.length, bytes }, null, 2));
} catch (error) {
    zip.abort(); zip.destroy(error); output.destroy(error);
    await completed.catch(() => {});
    await fsp.rm(temp, { force: true });
    throw error;
}
