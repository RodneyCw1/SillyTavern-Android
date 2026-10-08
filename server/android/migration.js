import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { inside, isMigrationPath, sha256, replaceDirectory } from './files.js';

export async function unpackMigration(archivePath, stage, maxBytes = 8 * 1024 ** 3) {
    await fsp.mkdir(stage, { recursive: true });
    const seen = new Set();
    let total = 0, count = 0;
    await new Promise((resolve, reject) => {
        yauzl.open(archivePath, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
            if (error) return reject(error);
            let failed = false;
            const fail = e => { if (!failed) { failed = true; zip.close(); reject(e); } };
            zip.on('error', fail);
            zip.on('end', resolve);
            zip.on('entry', entry => {
                (async () => {
                    const name = entry.fileName;
                    if (name.endsWith('/')) { inside(stage, name.slice(0, -1)); return; }
                    if (name !== 'manifest.json' && (!name.startsWith('user/') || !isMigrationPath(name.slice(5)))) throw new Error('Unexpected migration file: ' + name);
                    const target = inside(stage, name);
                    if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 || entry.generalPurposeBitFlag & 1) throw new Error('Links and encrypted entries are not supported');
                    if (seen.has(name)) throw new Error('Duplicate archive path');
                    seen.add(name);
                    total += entry.uncompressedSize;
                    if (++count > 100000 || total > maxBytes) throw new Error('Migration archive exceeds limits');
                    if (name === 'manifest.json' && entry.uncompressedSize > 32 * 1024 ** 2) throw new Error('Manifest is too large');
                    await fsp.mkdir(path.dirname(target), { recursive: true });
                    const stream = await new Promise((r, j) => zip.openReadStream(entry, (e, s) => e ? j(e) : r(s)));
                    await pipeline(stream, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
                })().then(() => { if (!failed) zip.readEntry(); }, fail);
            });
            zip.readEntry();
        });
    });
    const manifest = JSON.parse(await fsp.readFile(path.join(stage, 'manifest.json'), 'utf8'));
    if (manifest.format !== 'sillytavern-android-migration' || manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported migration format');
    const listed = new Set();
    for (const file of manifest.files) {
        if (!isMigrationPath(file.path) || listed.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw new Error('Invalid file manifest');
        listed.add(file.path);
        const location = inside(path.join(stage, 'user'), file.path);
        const stat = await fsp.stat(location);
        if (stat.size !== file.size || await sha256(location) !== file.sha256) throw new Error('Migration checksum mismatch: ' + file.path);
    }
    if (listed.size + 1 !== count || !listed.has('settings.json')) throw new Error('Migration manifest does not match the archive');
    return { manifest, bytes: total, count: listed.size };
}

export async function importMigration(archivePath, dataRoot, { availableBytes } = {}) {
    const parent = path.dirname(dataRoot);
    const stage = path.join(parent, '.import-' + crypto.randomUUID());
    await fsp.mkdir(parent, { recursive: true });
    const free = availableBytes ?? Number((await fsp.statfs(parent)).bavail) * Number((await fsp.statfs(parent)).bsize);
    if (free < 32 * 1024 ** 2) throw new Error('Insufficient free space');
    try {
        const result = await unpackMigration(archivePath, stage, Math.min(8 * 1024 ** 3, free - 32 * 1024 ** 2));
        const userStage = path.join(stage, 'user');
        const target = path.join(dataRoot, 'default-user');
        // Keep installed extensions and existing phone credentials separate from imported personal content.
        for (const name of ['extensions', 'secrets.json']) {
            const existing = path.join(target, name);
            if (fs.existsSync(existing)) await fsp.cp(existing, path.join(userStage, name), { recursive: true });
        }
        await fsp.mkdir(dataRoot, { recursive: true });
        const backup = await replaceDirectory(userStage, target);
        return { count: result.count, bytes: result.bytes, backup: backup ? path.basename(backup) : null, restartRequired: true };
    } finally {
        await fsp.rm(stage, { recursive: true, force: true });
    }
}
