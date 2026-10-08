import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { unpackMigration } from '../server/android/migration.js';

const project = path.resolve(import.meta.dirname, '..');
const source = process.env.ST_RELEASE_UPGRADE_SOURCE || path.join(project, 'scripts/release-upgrade-acceptance.mjs');
const load = () => import(pathToFileURL(source));
const certificate = 'c1b898bcbe03fc7991fe77a0fbe559f0da86667036850a917c2e45839070799f';
const properties = { qemu: '1', abi: 'x86_64', googleApis: '33_202408', type: 'userdebug' };
const identity = (versionName, versionCode) => ({ packageName: 'io.sillytavern.standalone', versionName, versionCode, debuggable: false, certificate });

test('release acceptance requires all explicit artifact/device arguments and rejects unknown or repeated flags', async () => {
    const { parseArgs } = await load();
    assert.deepEqual(parseArgs(['--serial', 'emulator-5558', '--baseline-apk', 'old.apk', '--new-apk', 'new.apk']), { serial: 'emulator-5558', baselineApk: path.resolve('old.apk'), newApk: path.resolve('new.apk') });
    for (const args of [[], ['--serial', 'emulator-5558'], ['--serial', 'emulator-5558', '--serial', 'emulator-5556'], ['--wipe'], ['--serial', 'physical-phone', '--baseline-apk', 'a', '--new-apk', 'b']]) assert.throws(() => parseArgs(args));
});

test('release identity accepts only original signing certificate and exact 5 to 6 version transition', async () => {
    const { assertUpgradeIdentity } = await load();
    assert.doesNotThrow(() => assertUpgradeIdentity(identity('1.1.2', 5), identity('1.1.3', 6)));
    for (const change of [{ certificate: 'a'.repeat(64) }, { debuggable: true }, { packageName: 'io.sillytavern.standalone.debug' }, { versionCode: 7 }, { versionName: '1.1.4' }]) assert.throws(() => assertUpgradeIdentity(identity('1.1.2', 5), { ...identity('1.1.3', 6), ...change }));
    assert.throws(() => assertUpgradeIdentity(identity('1.1.1', 4), identity('1.1.3', 6)));
});

test('APK badging retains release/debug information and rejects ambiguous package records', async () => {
    const { parseApkBadging } = await load();
    const line = "package: name='io.sillytavern.standalone' versionCode='6' versionName='1.1.3' platformBuildVersionName='15'";
    assert.deepEqual(parseApkBadging(line), { packageName: 'io.sillytavern.standalone', versionCode: 6, versionName: '1.1.3', debuggable: false });
    assert.equal(parseApkBadging(line + '\napplication-debuggable').debuggable, true);
    assert.throws(() => parseApkBadging(line + '\n' + line));
});

test('release probe rejects physical, ARM, non-Google and non-rootable targets before mutation', async () => {
    const { assertEmulator } = await load();
    assert.doesNotThrow(() => assertEmulator('emulator-5558', properties));
    for (const change of [{ qemu: '0' }, { abi: 'arm64-v8a' }, { googleApis: '' }, { type: 'user' }]) assert.throws(() => assertEmulator('emulator-5558', { ...properties, ...change }));
    assert.throws(() => assertEmulator('physical-device', properties));
});

function fakeAdb({ installed = '', qemu = '1', googleApis = '33_202408', googlePackages = '', api = '29' } = {}) {
    const commands = [];
    return { commands, run(_exe, args) {
        commands.push(args);
        assert.deepEqual(args.slice(0, 2), ['-s', 'emulator-5558']);
        const rest = args.slice(2).join(' ');
        const responses = {
            'get-state': 'device', 'shell getprop ro.kernel.qemu': qemu,
            'shell getprop ro.product.cpu.abi': 'x86_64', 'shell getprop ro.com.google.gmsversion': googleApis,
            'shell getprop ro.build.version.sdk': api, 'shell pm list packages com.google.android.gms': googlePackages,
            'shell getprop ro.build.type': 'userdebug', 'shell pm list packages -u io.sillytavern.standalone': installed,
            root: 'restarting adbd as root', 'wait-for-device': '', 'shell id -u': '0',
        };
        if (!(rest in responses)) throw new Error('Unexpected ADB command: ' + rest);
        return responses[rest];
    } };
}

test('Google APIs images without gmsversion require an exact installed GMS package before mutation', async () => {
    const { createReleaseDevice } = await load();
    const google = fakeAdb({ googleApis: '', googlePackages: 'package:com.google.android.gms\r\r\npackage:com.google.android.gms.other\r\r\n' });
    assert.doesNotThrow(() => createReleaseDevice({ serial: 'emulator-5558', adb: 'adb', run: google.run }));
    for (const googlePackages of ['', 'package:com.google.android.gms.other\r\r\n']) {
        const nongoogle = fakeAdb({ googleApis: '', googlePackages });
        assert.throws(() => createReleaseDevice({ serial: 'emulator-5558', adb: 'adb', run: nongoogle.run }), /Google APIs/);
        assert.ok(nongoogle.commands.every(args => !args.includes('root') && !args.includes('install')));
    }
});

test('release installs grant notifications on API 33+ only after owning the fresh baseline', async () => {
    const { createReleaseDevice } = await load();
    for (const api of ['29', '35']) {
        const fake = fakeAdb({ api });
        let installed = false, grants = 0;
        const run = (exe, args, options) => {
            if (args[2] === 'install') { installed = true; return 'Success'; }
            if (args.slice(2).join(' ') === 'shell pm grant io.sillytavern.standalone android.permission.POST_NOTIFICATIONS') {
                assert.equal(installed, true); grants++; return '';
            }
            return fake.run(exe, args, options);
        };
        const device = createReleaseDevice({ serial: 'emulator-5558', adb: 'adb', run });
        assert.throws(() => device.installUpgrade('new.apk'), /Baseline/);
        assert.equal(grants, 0);
        device.installBaseline('old.apk');
        device.installUpgrade('new.apk');
        assert.equal(grants, api === '35' ? 2 : 0);
    }
});

test('preexisting package or physical target is refused without reading private files or altering packages', async () => {
    const { createReleaseDevice } = await load();
    for (const options of [{ installed: 'package:io.sillytavern.standalone' }, { installed: 'package:io.sillytavern.standalone\r\r\npackage:io.sillytavern.standalone.debug\r\r\n' }, { qemu: '0' }]) {
        const adb = fakeAdb(options);
        assert.throws(() => createReleaseDevice({ serial: 'emulator-5558', adb: 'adb', run: adb.run }));
        assert.ok(adb.commands.every(args => !args.includes('root') && !args.includes('install') && !args.includes('uninstall') && !args.includes('cat')));
    }
});

test('a fresh root emulator still cannot read private data before this run installs the baseline', async () => {
    const { createReleaseDevice } = await load();
    const adb = fakeAdb();
    const device = createReleaseDevice({ serial: 'emulator-5558', adb: 'adb', run: adb.run });
    assert.throws(() => device.read('host-token'), /baseline|owned/i);
    assert.throws(() => device.read('../another-account/secrets.json'));
    assert.throws(() => device.native('GET', 'status'), /baseline|owned/i);
    assert.equal(device.packageName, 'io.sillytavern.standalone');
});

test('release native requests use the owned app UID and allow the ten-minute import deadline', async () => {
    const { createReleaseDevice } = await load();
    const fake = fakeAdb();
    const requests = [];
    let created = false;
    const run = (exe, args, options) => {
        if (args[2] === 'install') return 'Success';
        if (args.includes('cat')) return 'a'.repeat(64);
        if (args.slice(2).join(' ') === 'shell cmd package list packages -U io.sillytavern.standalone') return 'package:io.sillytavern.standalone uid:10123\r\r\npackage:io.sillytavern.standalone.debug uid:10146\r\r\n';
        return fake.run(exe, args, options);
    };
    const nativeClientFactory = options => {
        created = true;
        assert.equal(options.uid, 10123);
        assert.equal(options.packageName, 'io.sillytavern.standalone');
        return { request(request, settings) {
            requests.push({ request, settings });
            return Buffer.from('HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}');
        }, close() {} };
    };
    const device = createReleaseDevice({ root: project, serial: 'emulator-5558', adb: 'adb', run, nativeClientFactory });
    assert.equal(created, false);
    device.installBaseline('synthetic-baseline.apk');
    assert.equal(device.native('POST', 'import', { id: 'fixture' }).status, 200);
    assert.equal(requests[0].settings.responseTimeoutMs, 600000);
    assert.match(String(requests[0].request), /Content-Length: 16\r\n/);
});

test('native parser handles import errors without accepting truncated or chunked responses', async () => {
    const { parseHttpResponse } = await load();
    const body = JSON.stringify({ error: '合成错误' });
    const raw = Buffer.from(`HTTP/1.0 400 Bad Request\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    assert.deepEqual(parseHttpResponse(raw), { status: 400, body: { error: '合成错误' } });
    assert.throws(() => parseHttpResponse(raw.subarray(0, -1)));
    assert.throws(() => parseHttpResponse('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'));
});

test('data retention requires all synthetic hashes while a host token must rotate', async () => {
    const { assertPreserved, assertTokenRotation } = await load();
    const baseline = { 'chats/fixture/chat.jsonl': 'a', 'secrets.json': 'b', 'extensions/fixture/index.js': 'c' };
    assert.doesNotThrow(() => assertPreserved(baseline, { ...baseline }));
    assert.throws(() => assertPreserved(baseline, { ...baseline, 'secrets.json': 'changed' }), /secrets/);
    assert.throws(() => assertPreserved(baseline, { 'secrets.json': 'b' }));
    assert.doesNotThrow(() => assertTokenRotation('a'.repeat(64), 'b'.repeat(64)));
    assert.throws(() => assertTokenRotation('a'.repeat(64), 'a'.repeat(64)));
    assert.throws(() => assertTokenRotation('a', 'b'));
});

test('runtime assertion rejects stale app identity, missing patch revision or marker mismatch', async () => {
    const { assertRuntimeIdentity } = await load();
    const runtime = { appVersion: '1.1.3', sourceHash: 'b'.repeat(64), runtimeSha256: 'a'.repeat(64), plugins: [{ name: 'JS-Slash-Runner', version: '4.11.2', androidPatchRevision: 1 }] };
    assert.doesNotThrow(() => assertRuntimeIdentity(runtime, runtime, runtime.runtimeSha256));
    assert.throws(() => assertRuntimeIdentity({ ...runtime, appVersion: '1.1.2' }, runtime, runtime.runtimeSha256));
    assert.throws(() => assertRuntimeIdentity({ ...runtime, plugins: [{ name: 'JS-Slash-Runner', version: '4.11.2' }] }, runtime, runtime.runtimeSha256));
    assert.throws(() => assertRuntimeIdentity(runtime, runtime, '0'.repeat(64)));
});

test('loopback browser gateway must belong to the main process, not the Node runtime or wildcard address', async () => {
    const { assertLoopbackGateway } = await load();
    const row = (address, inode = '4312') => `0: ${address}:44CE 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10123 0 ${inode}`;
    assert.equal(assertLoopbackGateway(row('0100007F'), 'lrwx------ 1 u0_a1 u0_a1 64 Sep 30 00:00 32 -> socket:[4312]'), '4312');
    assert.throws(() => assertLoopbackGateway(row('00000000'), '32 -> socket:[4312]'), /loopback/);
    assert.throws(() => assertLoopbackGateway(row('0100007F'), '32 -> socket:[9999]'), /main process/);
    assert.throws(() => assertLoopbackGateway('', ''), /gateway/);
    assert.throws(() => assertLoopbackGateway(row('0100007F') + '\n' + row('00000000', '7777'), '32 -> socket:[4312]'), /gateway|loopback/);
});

test('dual-stack gateway accepts only the exact IPv4-mapped 127.0.0.1 proc address with its main-process inode', async () => {
    const { assertLoopbackGateway } = await load();
    const mapped = '0000000000000000FFFF00000100007F';
    const row = address => `0: ${address}:44CE 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 10123 0 4312\r\r\n`;
    const descriptors = '32 -> socket:[4312]';
    assert.equal(assertLoopbackGateway(row(mapped), descriptors), '4312');
    for (const address of [
        '00000000', '00000000000000000000000000000000',
        '0200007F', '0000000000000000FFFF00000200007F',
        '08080808', '0000000000000000FFFF000008080808',
        '00000000000000000000000001000000',
    ]) assert.throws(() => assertLoopbackGateway(row(address), descriptors), /loopback/);
    assert.throws(() => assertLoopbackGateway(row(mapped), '32 -> socket:[9999]'), /main process/);
    assert.throws(() => assertLoopbackGateway(row(mapped) + row('0100007F'), descriptors), /one.*listener/);
});

test('release WebView evidence matches the exact socket PID and never claims closure on userdebug', async () => {
    const { releaseWebViewEvidence } = await load();
    const input = { systemBuildType: 'userdebug', pid: '13502', appDebuggable: false, nativeWebViewPresent: true };
    const row = name => `0000000000000000: 00000002 00000000 00010000 0001 01 12345 ${name}\r\r\n`;
    for (const [sockets, socketObserved] of [
        [row('@webview_devtools_remote_135020'), false],
        [row('@webview_devtools_remote_13502'), true],
        [row('webview_devtools_remote_13502'), true],
        [row('@other_webview_devtools_remote_13502'), false],
        ['', false],
    ]) {
        const evidence = releaseWebViewEvidence({ ...input, sockets });
        assert.equal(evidence.releaseDebugging.socketObserved, socketObserved);
        assert.equal(evidence.releaseDebugging.systemBuildType, 'userdebug');
        assert.equal(evidence.releaseDebugging.appDebuggable, false);
        assert.equal(evidence.releaseDebugging.runtimeClosureVerified, false);
        assert.match(evidence.releaseDebugging.limitation, /https:\/\/chromium\.googlesource\.com\/.+124\.0\.6367\.219/);
        assert.deepEqual(evidence.checks.map(({ id, required, passed }) => ({ id, required, passed })), [
            { id: 'release-manifest', required: true, passed: true },
            { id: 'release-debugging-closure', required: false, passed: false },
        ]);
        assert.equal(evidence.checks[1].status, 'not-verified');
    }
    assert.throws(() => releaseWebViewEvidence({ ...input, sockets: '', appDebuggable: true }), /debuggable/i);
    assert.throws(() => releaseWebViewEvidence({ ...input, sockets: '', nativeWebViewPresent: false }), /WebView/i);
});

async function temporary(t) {
    const base = path.join(project, '.local/tests');
    await fsp.mkdir(base, { recursive: true });
    const directory = await fsp.mkdtemp(path.join(base, 'release-upgrade-'));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    return directory;
}

test('generated synthetic migration ZIP is accepted by the real importer and corrupt variant is rejected', async t => {
    const { makeMigrationZip } = await load();
    const directory = await temporary(t);
    const files = { 'settings.json': JSON.stringify({ synthetic: '中文😀' }), 'chats/fixture/chat.jsonl': JSON.stringify({ mes: 'x'.repeat(64000) }) + '\n' };
    const valid = path.join(directory, 'valid.zip'), corrupt = path.join(directory, 'corrupt.zip');
    await makeMigrationZip(valid, files, { root: project });
    const stage = path.join(directory, 'valid');
    const imported = await unpackMigration(valid, stage);
    assert.equal(imported.count, 2);
    assert.equal(await fsp.readFile(path.join(stage, 'user/chats/fixture/chat.jsonl'), 'utf8'), files['chats/fixture/chat.jsonl']);
    await makeMigrationZip(corrupt, files, { root: project, corrupt: true });
    await assert.rejects(() => unpackMigration(corrupt, path.join(directory, 'corrupt')), /checksum mismatch/);
});

test('APK runtime reader uses the embedded metadata and rejects duplicates or a missing asset', async t => {
    const { readApkRuntime } = await load();
    const directory = await temporary(t);
    const archiver = createRequire(path.join(project, 'server/package.json'))('archiver');
    async function archive(name, entries) {
        const file = path.join(directory, name);
        const zip = archiver('zip');
        const complete = pipeline(zip, fs.createWriteStream(file));
        for (const [name, body] of entries) zip.append(body, { name });
        await zip.finalize(); await complete;
        return file;
    }
    const runtime = { appVersion: '1.1.3', synthetic: true };
    const file = await archive('valid.apk', [['assets/runtime.json', JSON.stringify(runtime)], ['classes.dex', 'synthetic']]);
    assert.deepEqual(await readApkRuntime(file, project), runtime);
    const duplicate = await archive('duplicate.apk', [['assets/runtime.json', '{}'], ['assets/runtime.json', '{}']]);
    await assert.rejects(() => readApkRuntime(duplicate, project), /Duplicate/);
    const missing = await archive('missing.apk', [['classes.dex', 'synthetic']]);
    await assert.rejects(() => readApkRuntime(missing, project), /metadata missing/);
});
