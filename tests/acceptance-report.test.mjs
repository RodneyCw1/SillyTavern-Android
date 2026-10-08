import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const project = path.resolve(import.meta.dirname, '..');
const sourceRoot = process.env.ST_ANDROID_TEST_SOURCE_ROOT || project;
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-acceptance-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const relative of ['scripts/write-report.mjs', 'scripts/write-checksums.mjs', 'scripts/source-inventory.mjs', 'server/android/files.js']) {
        await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
        await fs.copyFile(path.join(sourceRoot, relative), path.join(root, relative));
    }
    for (const relative of ['docs/acceptance', 'releases', 'vendor/runtime', 'android/app/src/main/assets']) await fs.mkdir(path.join(root, relative), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '9.8.7', type: 'module' }));
    await fs.writeFile(path.join(root, 'server/package.json'), JSON.stringify({ version: '1.19.0', type: 'module' }));
    await fs.writeFile(path.join(root, 'android/app/src/main/assets/runtime.json'), JSON.stringify({ appVersion: '9.8.7', runtimeSha256: 'b'.repeat(64) }));
    return root;
}

test('explicit evidence collection requires every selected suite and every required check to pass', async t => {
    const root = await fixture(t);
    const { getSourceHash } = await import(pathToFileURL(path.join(root, 'scripts/source-inventory.mjs')));
    const { writeReport } = await import(pathToFileURL(path.join(root, 'scripts/write-report.mjs')));
    const identity = { appVersion: '9.8.7', sourceHash: await getSourceHash(root), runtimeSha256: 'b'.repeat(64), testedAt: new Date().toISOString(), passed: true };
    const first = 'docs/acceptance/first.json';
    const second = 'docs/acceptance/second.json';
    await fs.writeFile(path.join(root, first), JSON.stringify({ ...identity, checks: [{ id: 'start', required: true, passed: true }] }));
    const files = [{ file: first, requiredChecks: ['start'] }, { file: second, requiredChecks: ['recover'] }];
    await fs.writeFile(path.join(root, second), JSON.stringify({ ...identity, checks: [{ id: 'recover', required: true, passed: true }] }));
    const good = await writeReport(root, { evidenceFiles: files });
    assert.equal(good.passed, true);
    assert.equal(good.checks.length, 2);
    for (const checks of [[], [{ id: 'unrelated', required: true, passed: true }], [{ id: 'recover', required: false, passed: true }], [{ id: 'recover', required: true, passed: false }]]) {
        await fs.writeFile(path.join(root, second), JSON.stringify({ ...identity, checks }));
        assert.equal((await writeReport(root, { evidenceFiles: files })).passed, false);
    }
    assert.equal((await writeReport(root, { evidenceFiles: [] })).passed, false);
    assert.equal((await writeReport(root, { evidenceFiles: ['docs/acceptance/missing.json'] })).passed, false);
    const history = await writeReport(root);
    assert.equal(history.passed, false);
    assert.equal(history.historical, true);
});

test('debug artifact gets its own actual certificate and hash when present', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'vendor/runtime/installed.json'), JSON.stringify({ version: '22.23.2', libraries: [] }));
    await fs.writeFile(path.join(root, 'docs/plugins-lock.json'), '[]');
    for (const [name, value] of [['SillyTavern-Standalone-9.8.7-release.apk', 'release'], ['SillyTavern-Standalone-9.8.7-debug.apk', 'debug'], ['SillyTavern-Android-9.8.7-source.zip', 'source']]) await fs.writeFile(path.join(root, 'releases', name), value);
    const { writeChecksums } = await import(pathToFileURL(path.join(root, 'scripts/write-checksums.mjs')));
    const report = await writeChecksums({ root, verifyApk: async apk => apk.endsWith('-debug.apk') ? 'd'.repeat(64) : 'e'.repeat(64) });
    assert.equal(report.files.length, 3);
    const debug = report.files.find(file => file.name.endsWith('-debug.apk'));
    assert.equal(debug.signingCertificateSha256, 'd'.repeat(64));
    assert.equal(debug.sha256, crypto.createHash('sha256').update('debug').digest('hex'));
    assert.equal(report.signingCertificateSha256, 'e'.repeat(64));
    await assert.rejects(writeChecksums({ root, verifyApk: async apk => { if (apk.endsWith('-debug.apk')) throw new Error('Invalid debug APK'); return 'e'.repeat(64); } }), /Invalid debug APK/);
});
