import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';

const project = path.resolve(import.meta.dirname, '..');
const load = () => import(pathToFileURL(process.env.ST_FOLDER_EXPORT_SOURCE || path.join(project, 'scripts/folder-export-acceptance.mjs')));

test('folder export CLI resolves shared readiness imports before validating arguments', () => {
    const result = spawnSync(process.execPath, [path.join(project, 'scripts/folder-export-acceptance.mjs'), '--invalid'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown, repeated or incomplete acceptance arguments/);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/);
});

test('folder export CLI writes a failed report and exits 1 for a missing synthetic token', async () => {
    const local = path.join(project, '.local');
    await fs.mkdir(local, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(local, 'folder-cli-test-'));
    try {
        const bundle = path.join(fixture, 'server/android/bundled-extensions/JS-Slash-Runner');
        await fs.mkdir(path.join(fixture, 'scripts'), { recursive: true });
        await fs.mkdir(path.join(bundle, 'dist'), { recursive: true });
        // Real modules and real CLI flow; only the repository content being hashed is tiny.
        for (const name of ['folder-export-acceptance.mjs', 'application-acceptance.mjs', 'android-test-tools.mjs', 'android-native-client.mjs', 'source-inventory.mjs']) {
            await fs.copyFile(path.join(project, 'scripts', name), path.join(fixture, 'scripts', name));
        }
        await fs.writeFile(path.join(fixture, 'package.json'), '{"version":"1.1.3","type":"module"}');
        await fs.writeFile(path.join(fixture, 'server/package.json'), '{"version":"1.19.0"}');
        await fs.writeFile(path.join(bundle, 'manifest.json'), '{"version":"4.11.2"}');
        await fs.writeFile(path.join(bundle, 'dist/index.js'), '// Never loaded: missing token fails before browser startup.');
        const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/folder-export-acceptance.mjs'), '--synthetic-data', '--desktop-token-file', path.join(fixture, '.local/missing-token')], { encoding: 'utf8', timeout: 30000 });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /ENOENT/);
        assert.doesNotMatch(result.stderr, /unsettled top-level await/);
        const reports = await fs.readdir(path.join(fixture, 'docs/acceptance'));
        assert.equal(reports.length, 1);
        const report = JSON.parse(await fs.readFile(path.join(fixture, 'docs/acceptance', reports[0]), 'utf8'));
        assert.equal(report.passed, false);
        assert.equal(report.runtimeSha256, null);
        assert.match(report.sourceHash, /^[a-f0-9]{64}$/);
        assert.match(report.error, /ENOENT/);
        assert.ok(report.testedAt);
    } finally {
        assert.ok(fixture.startsWith(local + path.sep));
        await fs.rm(fixture, { recursive: true, force: true });
    }
});

test('folder export assertions independently check child data and child buttons', async () => {
    const { createFixture, assertExport } = await load();
    const fixture = createFixture('123456abcdef', 'data');
    const dataOnly = structuredClone(fixture);
    dataOnly.scripts[0].button.buttons = [];
    dataOnly.scripts[0].export_with.button = false;
    assert.doesNotThrow(() => assertExport(dataOnly, fixture, { data: true, buttons: false }));
    const buttonsOnly = structuredClone(fixture);
    buttonsOnly.scripts[0].data = {};
    buttonsOnly.scripts[0].export_with.data = false;
    assert.doesNotThrow(() => assertExport(buttonsOnly, fixture, { data: false, buttons: true }));
    assert.throws(() => assertExport(fixture, fixture, { data: false, buttons: true }));
    assert.throws(() => assertExport(dataOnly, fixture, { data: false, buttons: true }));
    assert.ok(Buffer.byteLength(JSON.stringify(dataOnly)) > 65536);
});

test('desktop bridge probe reassembles Unicode chunks and records finish without claiming native disk I/O', async () => {
    const { desktopBridgeProbe } = await load();
    const window = {}, sandbox = vm.createContext({ window, crypto: { randomUUID: () => 'fixture-download' }, queueMicrotask });
    vm.runInContext(`(${desktopBridgeProbe.toString()})()`, sandbox);
    const replies = [];
    window.AndroidHost.onmessage = event => replies.push(JSON.parse(event.data));
    const send = (id, method, data) => window.AndroidHost.postMessage(JSON.stringify({ id, method, data }));
    send('1', 'download.begin', { name: 'synthetic.json', mime: 'application/json' });
    const content = Buffer.from('中文😀 synthetic');
    send('2', 'download.chunk', { downloadId: 'fixture-download', base64: content.subarray(0, 4).toString('base64') });
    send('3', 'download.chunk', { downloadId: 'fixture-download', base64: content.subarray(4).toString('base64') });
    send('4', 'download.finish', { downloadId: 'fixture-download' });
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(replies.at(-1).ok, true);
    const result = window.__folderBridge.exports[0];
    assert.equal(Buffer.concat(result.chunks.map(chunk => Buffer.from(chunk, 'base64'))).toString(), content.toString());
    assert.equal(window.__folderBridge.nativeDiskWrite, false);
    assert.deepEqual(Array.from(window.__folderBridge.calls), ['download.begin', 'download.chunk', 'download.chunk', 'download.finish']);
});

test('Android download path accepts only this generated fixture name and safely quotes spaces', async () => {
    const { controlledDownloadPath, quoteShell } = await load();
    const name = 'Tavern Helper Script Folder-FolderAcceptance-123456abcdef-data.json';
    assert.equal(controlledDownloadPath(name, '123456abcdef', 'data'), '/sdcard/Download/SillyTavern/' + name);
    assert.equal(quoteShell("a'b"), "'a'\\''b'");
    for (const invalid of ['../other.json', '/sdcard/private.json', name + '\n', 'someone-else.json', name.replace('123456abcdef', 'aaaaaaaaaaaa')]) assert.throws(() => controlledDownloadPath(invalid, '123456abcdef', 'data'));
});
