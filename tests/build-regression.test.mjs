import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const project = path.resolve(import.meta.dirname, '..');
const sourceRoot = process.env.ST_BUILD_TEST_SOURCE_ROOT || project;
const require = createRequire(path.join(project, 'server/package.json'));
const yauzl = require('yauzl');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-build-regression-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const relative of ['scripts/export-migration.mjs', 'scripts/write-report.mjs', 'scripts/write-checksums.mjs', 'scripts/package-source.mjs', 'scripts/source-inventory.mjs', 'scripts/verify-source-archive.mjs', 'server/android/files.js']) {
        await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
        try { await fs.copyFile(path.join(sourceRoot, relative), path.join(root, relative)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.mkdir(path.join(root, 'releases'), { recursive: true });
    await fs.mkdir(path.join(root, 'source/assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version: '9.8.7' }));
    await fs.writeFile(path.join(root, 'server/package.json'), JSON.stringify({ type: 'module', version: '1.19.0' }));
    await fs.writeFile(path.join(root, 'source/settings.json'), '{}');
    return root;
}

test('source inventory excludes local Google API key files from public archives', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'Google Cloud API Key.txt'), 'synthetic private credential');
    const { collectSourceFiles, excludedSourcePath } = await import(pathToFileURL(path.join(root, 'scripts/source-inventory.mjs')));
    assert.equal(excludedSourcePath('Google Cloud API Key.txt'), true);
    assert.ok(!(await collectSourceFiles(root)).includes('Google Cloud API Key.txt'));
});

function run(root, script, args = [], extra = {}) {
    return spawnSync(process.execPath, [script, ...args], {
        cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NODE_PATH: path.join(project, 'server/node_modules') }, ...extra,
    });
}

async function readArchive(file) {
    const entries = new Map();
    await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error);
        zip.on('error', reject); zip.on('end', resolve);
        zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => {
            if (error) return reject(error);
            const chunks = []; stream.on('error', reject); stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        }));
        zip.readEntry();
    }));
    return entries;
}

test('migration removes real proxy credentials and records every changed path', async () => {
    const { stripCredentials } = await import(pathToFileURL(path.join(sourceRoot, 'server/android/files.js')).href);
    const input = { oai_settings: { proxy_password: 'private-password', reverse_proxy: 'https://u:p@example.com/v1?api_key=private&mode=chat' }, note: 'keep', custom_url: 'https://u:p@example.com/v1?token=private' };
    const changes = [];
    const result = stripCredentials(input, changes);
    assert.equal(result.oai_settings.proxy_password, '');
    assert.equal(result.oai_settings.reverse_proxy, 'https://example.com/v1?mode=chat');
    assert.equal(result.custom_url, 'https://example.com/v1');
    assert.equal(result.note, 'keep');
    assert.deepEqual(changes.sort(), ['custom_url', 'oai_settings.proxy_password', 'oai_settings.reverse_proxy']);
    assert.equal(input.oai_settings.proxy_password, 'private-password');
    const invalidChanges = [];
    assert.equal(stripCredentials({ reverse_proxy: 'https://user:private@[broken?api_key=private' }, invalidChanges).reverse_proxy, '');
    assert.deepEqual(invalidChanges, ['reverse_proxy']);
});

test('migration export bounds binary buffering while preserving ZIP content and hashes', async t => {
    const root = await fixture(t);
    const preload = path.join(root, 'measure.mjs');
    await fs.writeFile(preload, "process.on('exit',()=>console.log('MAX_RSS='+process.resourceUsage().maxRSS));");
    const invoke = name => run(root, '--import', [pathToFileURL(preload).href, 'scripts/export-migration.mjs', path.join(root, 'source'), path.join(root, 'releases', name + '.zip')]);
    const before = invoke('empty'); assert.equal(before.status, 0, before.stderr);
    const payload = crypto.randomBytes(8 * 1024 * 1024);
    for (let i = 0; i < 8; i++) await fs.writeFile(path.join(root, 'source/assets', i + '.bin'), payload);
    const after = invoke('assets'); assert.equal(after.status, 0, after.stderr);
    const maxRSS = result => Number(result.stdout.match(/MAX_RSS=(\d+)/)?.[1]);
    assert.ok(maxRSS(after) - maxRSS(before) < 40 * 1024, '64 MiB input must not retain the entire compression backlog in memory');
    const entries = await readArchive(path.join(root, 'releases/assets.zip'));
    const manifest = JSON.parse(entries.get('manifest.json'));
    const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');
    assert.equal(manifest.files.filter(f => f.path.endsWith('.bin')).length, 8);
    for (const record of manifest.files.filter(f => f.path.endsWith('.bin'))) {
        assert.equal(record.sha256, expectedHash); assert.deepEqual(entries.get('user/' + record.path), payload);
    }
});

test('migration rejects JSON over 32 MiB and leaves no partial archive', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'source/settings.json'), JSON.stringify({ prompt: 'x'.repeat(32 * 1024 * 1024) }));
    const result = run(root, 'scripts/export-migration.mjs', [path.join(root, 'source'), path.join(root, 'releases/export.zip')]);
    assert.notEqual(result.status, 0, 'Oversized JSON must fail closed');
    assert.deepEqual((await fs.readdir(path.join(root, 'releases'))).filter(n => n.startsWith('export.zip')), []);
});

test('migration export failure removes temporary files and preserves previous destination', async t => {
    const root = await fixture(t);
    await fs.unlink(path.join(root, 'source/settings.json'));
    await fs.writeFile(path.join(root, 'releases/export.zip'), 'previous archive');
    const result = run(root, 'scripts/export-migration.mjs', [path.join(root, 'source'), path.join(root, 'releases/export.zip')]);
    assert.notEqual(result.status, 0);
    assert.equal(await fs.readFile(path.join(root, 'releases/export.zip'), 'utf8'), 'previous archive');
    assert.deepEqual((await fs.readdir(path.join(root, 'releases'))).filter(n => n.endsWith('.tmp')), []);
});

test('verification reports require explicit pass and matching version/source/runtime/time', async t => {
    const root = await fixture(t);
    const { evaluateEvidence } = await import(pathToFileURL(path.join(root, 'scripts/write-report.mjs')).href);
    const identity = { appVersion: '9.8.7', sourceHash: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64), now: new Date('2026-09-30T12:00:00Z') };
    const good = { ...identity, passed: true, testedAt: '2026-09-30T11:00:00Z' };
    assert.equal(evaluateEvidence(good, identity).verified, true);
    for (const bad of [{ ...good, passed: false }, { ...good, passed: undefined }, { ...good, appVersion: '1.0.0' }, { ...good, sourceHash: 'c'.repeat(64) }, { ...good, runtimeSha256: null }, { ...good, testedAt: '2026-10-01T00:00:00Z' }, { ...good, testedAt: 'invalid' }]) {
        assert.equal(evaluateEvidence(bad, identity).verified, false);
    }
});

test('writing a verification report preserves historical acceptance and limitations', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'docs/TEST-RESULTS.md'), '# Historical result\nKnown native crash remains unresolved.\n');
    await fs.writeFile(path.join(root, 'docs/source-verification.json'), JSON.stringify({ passed: false, changed: ['settings.json'], statusMatches: false }));
    await fs.mkdir(path.join(root, 'android/app/src/main/assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'android/app/src/main/assets/runtime.json'), JSON.stringify({ runtimeSha256: 'b'.repeat(64) }));
    const result = run(root, 'scripts/write-report.mjs'); assert.equal(result.status, 0, result.stderr);
    assert.match(await fs.readFile(path.join(root, 'docs/TEST-RESULTS.md'), 'utf8'), /Known native crash remains unresolved/);
    const reports = (await fs.readdir(path.join(root, 'docs'))).filter(n => n.startsWith('verification-9.8.7-') && n.endsWith('.json'));
    assert.equal(reports.length, 1);
    const report = JSON.parse(await fs.readFile(path.join(root, 'docs', reports[0]), 'utf8'));
    assert.ok(report.checks.every(check => !check.verified));
});

test('public checksums use actual APK certificate and do not require private migration or Git', async t => {
    const root = await fixture(t);
    await fs.mkdir(path.join(root, 'vendor/runtime'), { recursive: true });
    await fs.writeFile(path.join(root, 'vendor/runtime/installed.json'), JSON.stringify({ version: '22.23.2', libraries: [] }));
    await fs.writeFile(path.join(root, 'docs/plugins-lock.json'), '[]');
    await fs.writeFile(path.join(root, 'releases/SillyTavern-Standalone-9.8.7-release.apk'), 'APK fixture bytes');
    await fs.writeFile(path.join(root, 'releases/SillyTavern-Android-9.8.7-source.zip'), 'source fixture bytes');
    const { writeChecksums, parseSigningCertificate } = await import(pathToFileURL(path.join(root, 'scripts/write-checksums.mjs')).href);
    const fingerprint = '12'.repeat(32);
    const output = 'Signer #1 certificate SHA-256 digest: ' + fingerprint;
    assert.equal(parseSigningCertificate(output), fingerprint);
    assert.throws(() => parseSigningCertificate('invalid signer output'));
    const report = await writeChecksums({ root, verifyApk: async apk => { assert.ok(apk.endsWith('-9.8.7-release.apk')); return parseSigningCertificate(output); } });
    assert.equal(report.appVersion, '9.8.7'); assert.equal(report.signingCertificateSha256, fingerprint);
    assert.equal(report.files.length, 2); assert.ok(report.files.every(file => !file.name.includes('migration')));
    assert.equal(report.sourceCommit, null);
});

test('source archive works without Git and excludes private/cache/signing files before reading', async t => {
    const root = await fixture(t);
    const privatePaths = ['.local/secret.txt', '.codegraph/index.json', '.idea/workspace.xml', '.pnpm-store/store.bin', 'server/node_modules/dependency.js', 'server/data/default-user/settings.json', 'server/config.yaml', 'private.p12', 'nested/password.dpapi', 'signing-password-transfer.txt', 'nested/signing-password-other.txt', 'server/tests/test-results/.last-run.json', 'playwright-report/index.html', 'nested/__pycache__/cache.pyc', 'coverage/coverage.json'];
    for (const relative of privatePaths) { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), 'do not include'); }
    await fs.writeFile(path.join(root, 'README.md'), 'public source');
    const result = run(root, 'scripts/package-source.mjs'); assert.equal(result.status, 0, result.stderr);
    const entries = await readArchive(path.join(root, 'releases/SillyTavern-Android-9.8.7-source.zip'));
    assert.equal(entries.get('SillyTavern-Android/README.md').toString(), 'public source');
    for (const relative of privatePaths) assert.equal(entries.has('SillyTavern-Android/' + relative), false, relative);
});

test('source archive verification works without Git and rejects altered inventory hashes', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'README.md'), 'source fixture');
    const packaged = run(root, 'scripts/package-source.mjs'); assert.equal(packaged.status, 0, packaged.stderr);
    const verified = run(root, 'scripts/verify-source-archive.mjs'); assert.equal(verified.status, 0, verified.stderr);
    const result = JSON.parse(await fs.readFile(path.join(root, 'releases/source-archive-verification-9.8.7.json'), 'utf8'));
    assert.equal(result.passed, true);
    const inventoryPath = path.join(root, 'releases/source-inventory-9.8.7.json');
    const inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8'));
    inventory.files.find(file => file.path === 'README.md').sha256 = '0'.repeat(64);
    await fs.writeFile(inventoryPath, JSON.stringify(inventory));
    const corrupted = run(root, 'scripts/verify-source-archive.mjs'); assert.notEqual(corrupted.status, 0);
});
