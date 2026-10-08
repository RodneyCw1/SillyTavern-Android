import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const appVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const load = () => import(pathToFileURL(path.join(process.env.ST_ANDROID_TEST_SOURCE_ROOT || root, 'scripts/audit-apk-assets.mjs')));
const archiver = createRequire(path.join(root, 'server/package.json'))('archiver');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function zip(destination, entries, compressed = false) {
    const archive = archiver('zip', { store: !compressed });
    const done = pipeline(archive, createWriteStream(destination));
    for (const [name, bytes] of entries) archive.append(bytes, { name });
    await archive.finalize(); await done;
}
function elf(machine, alignment = 0x4000) {
    const value = Buffer.alloc(128);
    value.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    value.writeUInt16LE(3, 16); value.writeUInt16LE(machine, 18); value.writeUInt32LE(1, 20);
    value.writeBigUInt64LE(64n, 32); value.writeUInt16LE(64, 52);
    value.writeUInt16LE(56, 54); value.writeUInt16LE(1, 56); value.writeUInt16LE(64, 58);
    value.writeUInt32LE(1, 64); value.writeUInt32LE(5, 68);
    value.writeBigUInt64LE(128n, 96); value.writeBigUInt64LE(128n, 104);
    value.writeBigUInt64LE(BigInt(alignment), 112);
    return value;
}
async function fixture(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(root, '.local/apk-audit-test-'));
    t.after(() => fs.rm(directory, { force: true, recursive: true }));
    const runtime = path.join(directory, 'runtime.zip');
    const meta = { formatVersion: 1, appVersion, sillyTavern: '1.19.0', sourceHash: 'a'.repeat(64), plugins: [{ name: 'fixture', version: '1.0', androidPatchRevision: 1 }] };
    const entries = [
        ['package.json', JSON.stringify({ version: '1.19.0' })],
        ['node_modules/multer/package.json', JSON.stringify({ name: 'multer', version: options.multer || '2.3.0' })],
        ['android/bundled-extensions/fixture/manifest.json', JSON.stringify({ version: '1.0', androidPatchRevision: 1 })],
        ['public/large-fixture.bin', Buffer.alloc(2 * 1024 ** 2, 0x41)],
    ];
    if (options.runtimeForbidden) entries.push([options.runtimeForbidden, 'synthetic forbidden fixture']);
    await zip(runtime, entries, options.compressed);
    const digest = crypto.createHash('sha256'); for await (const chunk of createReadStream(runtime)) digest.update(chunk);
    meta.runtimeSha256 = digest.digest('hex');
    const expected = structuredClone(meta);
    if (options.hashMismatch) meta.runtimeSha256 = 'f'.repeat(64);
    const apkEntries = [
        ['assets/runtime.json', JSON.stringify(meta)], ['assets/runtime.zip', createReadStream(runtime)],
        ['lib/arm64-v8a/libnode.so', elf(options.wrongAbi ? 62 : 183)], ['lib/arm64-v8a/libtavern_node.so', elf(183, options.badAlignment ? 0x1000 : 0x4000)],
        ['lib/x86_64/libnode.so', elf(62)], ['lib/x86_64/libtavern_node.so', elf(62)],
    ].filter(([name]) => !options.missingAbi || !name.startsWith('lib/x86_64/'));
    if (options.apkForbidden) apkEntries.push([options.apkForbidden, 'synthetic forbidden fixture']);
    if (options.duplicateMetadata) apkEntries.push(['assets/runtime.json', JSON.stringify(meta)]);
    const apk = path.join(directory, 'fixture.apk'); await zip(apk, apkEntries, options.compressed);
    const installed = { libraries: [{ abi: 'arm64-v8a', sha256: options.nativeHashMismatch ? 'f'.repeat(64) : hash(elf(183)) }, { abi: 'x86_64', sha256: hash(elf(62)) }] };
    return { apk, expected, expectedMetadataSha256: hash(JSON.stringify(expected)), installed, sourceHash: expected.sourceHash, workRoot: directory };
}

test('APK path checks reject signing, env and private-data paths without decoding them', async () => {
    const { validateArchivePath } = await load();
    for (const name of ['assets/key.p12', 'assets/key.pfx', 'assets/key.jks', 'assets/key.dpapi', 'assets/.env.local', '../escape', '/data/user/0/token', 'C:/Users/name/file', 'assets/signing-password.txt', 'assets/Users/name/file']) assert.throws(() => validateArchivePath(name, 'apk'));
    for (const name of ['data/default-user/secrets.json', 'host-token', '.local/signing/key', 'config.yaml', 'android/bundled-extensions/fixture/node_modules/index.js']) assert.throws(() => validateArchivePath(name, 'runtime'));
    assert.doesNotThrow(() => validateArchivePath('node_modules/package/private/helper.js', 'runtime'));
});

test('audits a real nested ZIP stream, metadata, actual Multer manifest and both ELF ABIs', async t => {
    const { auditApkAssets } = await load();
    const f = await fixture(t);
    const result = await auditApkAssets(f.apk, { root, ...f });
    assert.equal(result.passed, true);
    assert.equal(result.multerVersion, '2.3.0');
    assert.equal(result.nativeLibraries.length, 4);
    assert.ok(result.nativeLibraries.every(library => library.loadAlignments.every(value => value >= 0x4000)));
    assert.equal(result.runtimeSha256, f.expected.runtimeSha256);
    assert.equal(result.metadataSha256, f.expectedMetadataSha256);
    assert.ok(result.runtimeBytes > 2 * 1024 ** 2);
    assert.ok(result.streamStats.maxChunkBytes < result.runtimeBytes);
    assert.deepEqual((await fs.readdir(f.workRoot)).sort(), ['fixture.apk', 'runtime.zip']);
});

test('mismatched APK metadata/hash is rejected', async t => {
    const { auditApkAssets } = await load();
    const f = await fixture(t, { hashMismatch: true });
    await assert.rejects(auditApkAssets(f.apk, { root, ...f }), /hash|metadata|identity/i);
});

test('old Multer, absent ABI and wrong ELF machine cannot pass', async t => {
    const { auditApkAssets } = await load();
    for (const options of [{ multer: '1.4.5-lts.1' }, { missingAbi: true }, { wrongAbi: true }]) {
        const f = await fixture(t, options);
        await assert.rejects(auditApkAssets(f.apk, { root, ...f }), /Multer|ABI|ELF|libnode/i);
    }
});

test('forbidden paths at either APK or runtime level stop the audit', async t => {
    const { auditApkAssets } = await load();
    for (const options of [{ apkForbidden: 'assets/key.p12' }, { runtimeForbidden: '.env' }]) {
        const f = await fixture(t, options);
        await assert.rejects(auditApkAssets(f.apk, { root, ...f }), /forbidden|sensitive|private/i);
    }
});

test('native checksum and actual LLVM LOAD alignment failures cannot pass', async t => {
    const { auditApkAssets } = await load();
    for (const options of [{ nativeHashMismatch: true }, { badAlignment: true }]) {
        const f = await fixture(t, options);
        await assert.rejects(auditApkAssets(f.apk, { root, ...f }), /SHA|hash|alignment|LOAD/i);
    }
});

test('duplicate archive metadata and stale source identity cannot pass', async t => {
    const { auditApkAssets } = await load();
    const duplicate = await fixture(t, { duplicateMetadata: true });
    await assert.rejects(auditApkAssets(duplicate.apk, { root, ...duplicate }), /duplicate/i);
    const stale = await fixture(t);
    await assert.rejects(auditApkAssets(stale.apk, { root, ...stale, sourceHash: 'b'.repeat(64) }), /source|identity/i);
});

test('compressed APK entries and nested compressed runtime stream also complete', async t => {
    const { auditApkAssets } = await load();
    const f = await fixture(t, { compressed: true });
    const result = await auditApkAssets(f.apk, { root, ...f });
    assert.equal(result.passed, true);
    assert.equal(result.metadataSha256, f.expectedMetadataSha256);
    assert.deepEqual((await fs.readdir(f.workRoot)).sort(), ['fixture.apk', 'runtime.zip']);
});
