import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { excludedSourcePath, getSourceHash } from './source-inventory.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'server/package.json'));
const yauzl = require('yauzl');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const folder = path.join(root, 'releases');
const inventory = JSON.parse(await fs.readFile(path.join(folder, `source-inventory-${version}.json`), 'utf8'));
assert.equal(inventory.appVersion, version);
assert.ok(Array.isArray(inventory.files));
const expected = new Map();
for (const record of inventory.files) {
    assert.equal(typeof record.path, 'string');
    assert.ok(record.path && !record.path.includes('\\') && !record.path.includes(':') && record.path.split('/').every(part => part && part !== '.' && part !== '..'));
    assert.ok(!excludedSourcePath(record.path), 'Excluded path in inventory: ' + record.path);
    assert.ok(!expected.has(record.path), 'Duplicate inventory path');
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(record.size) && record.size >= 0);
    expected.set(record.path, record);
}
let checked = 0;
await new Promise((resolve, reject) => yauzl.open(path.join(folder, `SillyTavern-Android-${version}-source.zip`), { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    const fail = error => { zip.close(); reject(error); };
    zip.on('error', fail); zip.on('end', resolve);
    zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        try {
            assert.ok(entry.fileName.startsWith('SillyTavern-Android/'), 'Unexpected ZIP prefix');
            assert.notEqual((entry.externalFileAttributes >>> 16) & 0xf000, 0xa000, 'Symlinks are not source files');
            const name = entry.fileName.slice('SillyTavern-Android/'.length);
            const record = expected.get(name);
            assert.ok(record, 'Unexpected or duplicate archived file: ' + name);
            assert.equal(entry.uncompressedSize, record.size, name);
            const hash = crypto.createHash('sha256');
            zip.openReadStream(entry, (error, stream) => {
                if (error) return fail(error);
                stream.on('error', fail); stream.on('data', part => hash.update(part));
                stream.on('end', () => {
                    try { assert.equal(hash.digest('hex'), record.sha256, name); expected.delete(name); checked++; zip.readEntry(); }
                    catch (error) { fail(error); }
                });
            });
        } catch (error) { fail(error); }
    });
    zip.readEntry();
}));
assert.equal(expected.size, 0, 'Every source inventory file must be archived');
assert.equal(await getSourceHash(root), inventory.sourceHash, 'Current source does not match the exported source identity');
const report = { passed: true, appVersion: version, sourceHash: inventory.sourceHash, testedAt: new Date().toISOString(), filesVerified: checked, verification: 'Every decompressed ZIP file matches its SHA-256 source inventory; no Git metadata required' };
await fs.writeFile(path.join(folder, `source-archive-verification-${version}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
