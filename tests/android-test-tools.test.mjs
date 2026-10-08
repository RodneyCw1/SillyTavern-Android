import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const project = path.resolve(import.meta.dirname, '..');
const sourceRoot = process.env.ST_ANDROID_TEST_SOURCE_ROOT || project;
const load = () => import(pathToFileURL(path.join(sourceRoot, 'scripts/android-test-tools.mjs')));
const listing = 'List of devices attached\nalpha device product:test\nbeta device product:test\noffline-one offline\nuntrusted unauthorized\n';

test('device selection respects explicit serial, ANDROID_SERIAL, and exactly one online fallback', async () => {
    const { selectAndroidDevice } = await load();
    assert.equal(selectAndroidDevice(listing, { serial: 'beta', env: { ANDROID_SERIAL: 'alpha' } }), 'beta');
    assert.equal(selectAndroidDevice(listing, { env: { ANDROID_SERIAL: 'alpha', ST_TEST_DEVICE: 'beta' } }), 'alpha');
    assert.equal(selectAndroidDevice('List of devices attached\nchosen device\nother offline\n', { env: {} }), 'chosen');
    assert.throws(() => selectAndroidDevice(listing, { env: {} }), /multiple|多个/i);
    assert.throws(() => selectAndroidDevice(listing, { serial: 'offline-one', env: {} }), /offline|在线/i);
    assert.throws(() => selectAndroidDevice('List of devices attached\n', { env: {} }), /online|在线/i);
});

test('forward allocates an available port and removes only the port owned by this session', async () => {
    const { createAndroidDevice } = await load();
    const forwards = new Map([[17620, 'another-session']]);
    const run = (_command, args) => {
        if (args[0] === 'devices') return 'List of devices attached\nalpha device\n';
        assert.deepEqual(args.slice(0, 2), ['-s', 'alpha']);
        if (args[2] === 'forward' && args[3] === 'tcp:0') { forwards.set(41537, args[4]); return '41537\n'; }
        if (args[2] === 'forward' && args[3] === '--remove') { forwards.delete(Number(args[4].slice(4))); return ''; }
        throw new Error('Unexpected ADB operation');
    };
    const device = createAndroidDevice({ root: project, env: {}, run });
    const port = device.forward('tcp:17614');
    assert.equal(port, 41537);
    assert.equal(forwards.get(port), 'tcp:17614');
    device.close();
    assert.deepEqual([...forwards], [[17620, 'another-session']]);
});

test('native status uses a fresh private token for every request and remains under the debug UID', async () => {
    const { createAndroidDevice } = await load();
    let token = 'a'.repeat(64);
    const requests = [];
    const run = (_command, args, options) => {
        if (args[0] === 'devices') return 'List of devices attached\nalpha device\n';
        assert.deepEqual(args.slice(0, 2), ['-s', 'alpha']);
        if (args.includes('cat')) return token + '\n';
        throw new Error('Native HTTP must use the binary-safe same-UID client, not toybox nc');
    };
    const nativeClientFactory = options => {
        assert.equal(options.packageName, 'io.sillytavern.standalone.debug');
        assert.equal(options.uid, undefined);
        return { check: () => true, close() {}, request(bytes) {
        const request = String(bytes);
        requests.push(request);
        assert.match(request, new RegExp('x-android-host: ' + token, 'i'));
        const body = Buffer.from(JSON.stringify({ ready: true }));
        return Buffer.concat([Buffer.from('HTTP/1.0 200 OK\r\nContent-Length: ' + body.length + '\r\n\r\n'), body]);
        } };
    };
    const device = createAndroidDevice({ root: project, env: {}, run, nativeClientFactory });
    device.checkNativeClient();
    assert.equal(device.nativeStatus().ready, true);
    token = 'b'.repeat(64);
    assert.equal(device.nativeStatus().ready, true);
    assert.equal(requests.length, 2);
    assert.ok(!requests[1].includes('a'.repeat(64)));
});

test('private debug probes reject release package and cannot escape the app home', async () => {
    const { createAndroidDevice } = await load();
    const run = () => 'List of devices attached\nalpha device\n';
    assert.throws(() => createAndroidDevice({ root: project, packageName: 'io.sillytavern.standalone', env: {}, run }), /debug/i);
    const device = createAndroidDevice({ root: project, env: {}, run });
    assert.throws(() => device.readPrivate('../secrets'), /path|路径/i);
    assert.throws(() => device.readPrivate('a;cat /etc/passwd'), /path|路径/i);
});

test('native HTTP parsing preserves UTF-8 and rejects incomplete or failed responses', async () => {
    const { parseNativeResponse } = await load();
    const body = Buffer.from(JSON.stringify({ ready: true, text: '中文😀' }));
    assert.equal(parseNativeResponse(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: ' + body.length + '\r\n\r\n'), body])).text, '中文😀');
    assert.throws(() => parseNativeResponse('HTTP/1.0 200 OK\r\nContent-Length: 10\r\n\r\n{}'), /incomplete|完整/i);
    assert.throws(() => parseNativeResponse('HTTP/1.0 403 Forbidden\r\n\r\nForbidden'), /403/);
    assert.throws(() => parseNativeResponse('not HTTP'), /HTTP/);
});

test('acceptance reports bind current identity and append a new file on every run including failures', async t => {
    const { writeAcceptanceReport } = await load();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-android-tools-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const identity = { appVersion: '9.8.7', sourceHash: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) };
    const first = await writeAcceptanceReport(root, 'android-smoke', { ...identity, device: 'phone:1234', passed: true, checks: ['actual test'] });
    const saved = await fs.readFile(first, 'utf8');
    const second = await writeAcceptanceReport(root, 'android-smoke', { ...identity, device: 'phone:1234', passed: false, checks: [], error: 'failed probe' });
    assert.notEqual(first, second);
    assert.equal(await fs.readFile(first, 'utf8'), saved);
    assert.equal(JSON.parse(saved).appVersion, '9.8.7');
    assert.match(JSON.parse(saved).testedAt, /^\d{4}-/);
    assert.equal(JSON.parse(await fs.readFile(second, 'utf8')).passed, false);
    assert.equal((await fs.readdir(path.dirname(first))).length, 2);
    await assert.rejects(writeAcceptanceReport(root, 'android-smoke', { ...identity, device: 'alpha', checks: [] }), /passed|通过/i);
});

test('build identity reads current package metadata and rejects stale embedded resources', async t => {
    const { readBuildIdentity } = await load();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-android-identity-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const directory of ['server', 'docs', 'android/app/src/main/assets']) await fs.mkdir(path.join(root, directory), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '9.8.7' }));
    await fs.writeFile(path.join(root, 'server/package.json'), JSON.stringify({ version: '1.19.0' }));
    await fs.writeFile(path.join(root, 'docs/node-source.json'), JSON.stringify({ version: '22.23.2' }));
    const metadata = path.join(root, 'android/app/src/main/assets/runtime.json');
    const { getSourceHash } = await import('../scripts/source-inventory.mjs');
    const sourceHash = await getSourceHash(root);
    await fs.writeFile(metadata, JSON.stringify({ appVersion: '9.8.7', runtimeSha256: 'b'.repeat(64), sourceHash }));
    const identity = await readBuildIdentity(root);
    assert.equal(identity.appVersion, '9.8.7');
    assert.equal(identity.nodeVersion, 'v22.23.2');
    assert.match(identity.sourceHash, /^[a-f0-9]{64}$/);
    await fs.writeFile(path.join(root, 'server/source.js'), '// changed after packaging');
    await assert.rejects(readBuildIdentity(root), /runtime|运行资源/i);
    await fs.writeFile(metadata, JSON.stringify({ appVersion: '1.1.0', runtimeSha256: 'b'.repeat(64) }));
    await assert.rejects(readBuildIdentity(root), /runtime|运行资源/i);
});
