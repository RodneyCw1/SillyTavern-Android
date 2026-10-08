import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createNativeClient } from './android-native-client.mjs';

export const PACKAGE = 'io.sillytavern.standalone';
// Original release certificate recorded in docs/apk-signature.txt.
const ORIGINAL_CERTIFICATE = 'c1b898bcbe03fc7991fe77a0fbe559f0da86667036850a917c2e45839070799f';
const HOME = `/data/user/0/${PACKAGE}/files/tavern`;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function parseArgs(args) {
    const result = {};
    const flags = { '--serial': 'serial', '--baseline-apk': 'baselineApk', '--new-apk': 'newApk' };
    for (let i = 0; i < args.length; i += 2) {
        const key = flags[args[i]], value = args[i + 1];
        if (!key || result[key] || !value || value.startsWith('--')) throw new Error('Required: --serial emulator-N --baseline-apk PATH --new-apk PATH (no repeated flags)');
        result[key] = value;
    }
    if (!/^emulator-\d+$/.test(result.serial || '') || !result.baselineApk || !result.newApk) throw new Error('Explicit emulator serial and both APK paths are required');
    result.baselineApk = path.resolve(result.baselineApk);
    result.newApk = path.resolve(result.newApk);
    if (result.baselineApk === result.newApk) throw new Error('Baseline and new APK must differ');
    return result;
}

export function parseApkBadging(text) {
    const records = [...String(text).matchAll(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/gm)];
    if (records.length !== 1) throw new Error('Expected exactly one APK package record');
    return { packageName: records[0][1], versionCode: Number(records[0][2]), versionName: records[0][3], debuggable: /^application-debuggable\s*$/m.test(text) };
}

export function assertUpgradeIdentity(baseline, current) {
    for (const [artifact, version, code] of [[baseline, '1.1.2', 5], [current, '1.1.3', 6]]) {
        assert.equal(artifact.packageName, PACKAGE, 'Unexpected application ID');
        assert.equal(artifact.versionName, version, 'Unexpected versionName');
        assert.equal(artifact.versionCode, code, 'Unexpected versionCode');
        assert.equal(artifact.debuggable, false, 'Release APK must not be debuggable');
        assert.equal(artifact.certificate, ORIGINAL_CERTIFICATE, 'APK must use the original release signer');
    }
}

export function assertEmulator(serial, props) {
    assert.match(serial, /^emulator-\d+$/, 'An explicit emulator serial is required');
    assert.equal(props.qemu, '1', 'Refusing a physical device');
    assert.equal(props.abi, 'x86_64', 'A dedicated x86_64 emulator is required');
    assert.ok(props.googleApis || props.googleApisPackage === true, 'A Google APIs system image is required');
    assert.equal(props.type, 'userdebug', 'A rootable Google APIs image is required');
}

export function parseHttpResponse(output) {
    const raw = Buffer.from(output), boundary = raw.indexOf('\r\n\r\n');
    if (boundary < 0) throw new Error('Incomplete native HTTP response');
    const headers = raw.subarray(0, boundary).toString('ascii');
    const status = Number(headers.match(/^HTTP\/1\.[01] (\d{3})\b/)?.[1]);
    if (!status || /\r\ntransfer-encoding:/i.test(headers)) throw new Error('Invalid or chunked native response');
    const body = raw.subarray(boundary + 4), length = headers.match(/\r\ncontent-length:\s*(\d+)/i)?.[1];
    if (length !== undefined && body.length !== Number(length)) throw new Error('Incomplete native HTTP body');
    return { status, body: JSON.parse(body.toString('utf8')) };
}

export function assertPreserved(before, after) {
    for (const [file, hash] of Object.entries(before)) assert.equal(after[file], hash, `Synthetic file changed: ${file}`);
}

export function assertTokenRotation(before, after) {
    assert.match(before, /^[a-f0-9]{64}$/); assert.match(after, /^[a-f0-9]{64}$/);
    assert.notEqual(after, before, 'Host token must rotate after the new process starts');
}

export function assertLoopbackGateway(tcp, mainProcessDescriptors) {
    const port = (17614).toString(16).toUpperCase();
    const listeners = String(tcp).split(/\r?\n/).map(line => line.trim().split(/\s+/))
        .filter(fields => fields[1]?.endsWith(':' + port) && fields[3] === '0A');
    assert.equal(listeners.length, 1, 'Expected one browser gateway listener');
    // proc tcp6 prints native-endian 32-bit words: the second form is
    // ::ffff:127.0.0.1 on the dedicated x86_64 test image.
    const loopbackAddresses = ['0100007F', '0000000000000000FFFF00000100007F'];
    assert.ok(loopbackAddresses.some(address => listeners[0][1] === address + ':' + port), 'Browser gateway must bind exactly 127.0.0.1 loopback');
    const inode = listeners[0][9];
    assert.match(inode, /^\d+$/);
    assert.ok(String(mainProcessDescriptors).includes(`socket:[${inode}]`), 'Browser gateway must belong to the Android main process');
    return inode;
}

export function releaseWebViewEvidence({ systemBuildType, pid, sockets, appDebuggable, nativeWebViewPresent }) {
    assert.equal(appDebuggable, false, 'Release APK must not be debuggable');
    assert.equal(nativeWebViewPresent, true, 'Live native WebView is missing');
    assert.equal(systemBuildType, 'userdebug', 'This upgrade suite requires its dedicated userdebug emulator');
    assert.match(pid, /^[1-9]\d*$/, 'Expected exactly one main app PID');
    const socketName = `webview_devtools_remote_${pid}`;
    const socketObserved = String(sockets).split(/\r?\n/).some(line => line.trim().split(/\s+/).at(-1)?.replace(/^@/, '') === socketName);
    const limitation = 'Runtime debugging closure is not verified on this userdebug system. Chromium 124 enables WebView debugging for debug Android builds and ignores the app disable call: '
        + 'https://chromium.googlesource.com/chromium/src/+/refs/tags/124.0.6367.219/android_webview/glue/java/src/com/android/webview/chromium/SharedStatics.java ; '
        + 'https://chromium.googlesource.com/chromium/src/+/refs/tags/124.0.6367.219/base/android/java/src/org/chromium/base/BuildInfo.java';
    return {
        releaseDebugging: { systemBuildType, socketObserved, appDebuggable, runtimeClosureVerified: false, limitation },
        checks: [
            { id: 'release-manifest', required: true, passed: true, description: 'Release APK and installed package are not debuggable; the live native WebView exists.' },
            { id: 'release-debugging-closure', required: false, passed: false, status: 'not-verified', description: limitation },
        ],
    };
}

export function assertRuntimeIdentity(actual, expected, marker) {
    for (const key of ['appVersion', 'sourceHash', 'runtimeSha256']) assert.equal(actual[key], expected[key], `Stale embedded runtime ${key}`);
    assert.equal(actual.appVersion, '1.1.3');
    assert.match(actual.sourceHash, /^[a-f0-9]{64}$/);
    assert.match(actual.runtimeSha256, /^[a-f0-9]{64}$/);
    assert.equal(marker.trim(), actual.runtimeSha256, 'Deployed runtime marker mismatch');
    assert.ok(actual.plugins?.length, 'Runtime plugin metadata missing');
    for (const plugin of actual.plugins) {
        assert.ok(/^[\w-]+$/.test(plugin.name), 'Invalid runtime plugin name');
        const wanted = expected.plugins.find(item => item.name === plugin.name);
        assert.ok(wanted, 'Unexpected runtime plugin');
        assert.equal(plugin.version, wanted.version);
        assert.ok(Number.isSafeInteger(plugin.androidPatchRevision) && plugin.androidPatchRevision >= 1, 'Missing Android patch revision');
        assert.equal(plugin.androidPatchRevision, wanted.androidPatchRevision);
    }
    assert.equal(actual.plugins.length, expected.plugins.length);
}

export function createReleaseDevice({ root = path.resolve(import.meta.dirname, '..'), serial, adb, run = execFileSync, nativeClientFactory = createNativeClient }) {
    assert.match(serial, /^emulator-\d+$/);
    const execute = (args, options = {}) => run(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 ** 2, ...options });
    const text = (...args) => String(execute(args)).trim();
    assert.equal(text('get-state'), 'device');
    const props = Object.fromEntries(Object.entries({ qemu: 'ro.kernel.qemu', abi: 'ro.product.cpu.abi', googleApis: 'ro.com.google.gmsversion', type: 'ro.build.type' }).map(([key, prop]) => [key, text('shell', 'getprop', prop)]));
    if (!props.googleApis) props.googleApisPackage = text('shell', 'pm', 'list', 'packages', 'com.google.android.gms').split(/\r?\n/).some(line => line.trim() === 'package:com.google.android.gms');
    assertEmulator(serial, props);
    props.api = Number(text('shell', 'getprop', 'ro.build.version.sdk'));
    assert.ok(Number.isSafeInteger(props.api) && props.api >= 29, 'Unexpected test Android API level');
    // Never uninstall, clear, enumerate or inspect data from an existing installation.
    // -u also catches a previously removed package whose private data was kept.
    const installed = text('shell', 'pm', 'list', 'packages', '-u', PACKAGE).split(/\r?\n/).map(line => line.trim());
    if (installed.includes(`package:${PACKAGE}`)) throw new Error('Target package already installed or retains data; use a fresh dedicated emulator. No data was touched.');
    text('root'); text('wait-for-device');
    assert.equal(text('shell', 'id', '-u'), '0', 'adb root failed');
    let owned = false;
    let nativeClient;
    const grantNotifications = () => {
        if (!owned) throw new Error('Baseline not installed');
        if (props.api >= 33) text('shell', 'pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS');
    };
    const appUid = () => {
        if (!owned) throw new Error('Native client unavailable until this run owns the baseline installation');
        const expression = new RegExp(`^package:${PACKAGE.replaceAll('.', '\\.')} uid:(\\d+)$`);
        const matches = text('shell', 'cmd', 'package', 'list', 'packages', '-U', PACKAGE).split(/\r?\n/).map(line => expression.exec(line.trim())).filter(Boolean);
        assert.equal(matches.length, 1, 'Missing or ambiguous app UID');
        const value = matches[0][1];
        const uid = Number(value);
        assert.ok(Number.isSafeInteger(uid) && uid >= 10000, 'Missing app UID');
        return uid;
    };
    const privatePath = relative => {
        if (!owned) throw new Error('Private files are unavailable until this run owns a fresh baseline installation');
        if (!/^[\w./-]+$/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid controlled relative path');
        return `${HOME}/${relative}`;
    };
    const read = relative => Buffer.from(execute(['exec-out', 'cat', privatePath(relative)], { encoding: null }));
    const token = () => {
        const value = read('host-token').toString().trim();
        assert.match(value, /^[a-f0-9]{64}$/); return value;
    };
    return {
        serial, packageName: PACKAGE, props, text, read, token,
        installBaseline(apk) { text('install', apk); owned = true; grantNotifications(); },
        installUpgrade(apk) { if (!owned) throw new Error('Baseline not installed'); text('install', '-r', apk); grantNotifications(); },
        stop() { if (!owned) throw new Error('Baseline not installed'); text('shell', 'am', 'force-stop', PACKAGE); },
        start() { if (!owned) throw new Error('Baseline not installed'); text('shell', 'am', 'start', '-W', '-n', `${PACKAGE}/io.sillytavern.standalone.MainActivity`); },
        exists(relative) { return text('shell', 'sh', '-c', `'test -e ${privatePath(relative)} && echo yes || echo no'`) === 'yes'; },
        put(local, relative) {
            const destination = privatePath(relative);
            text('shell', 'mkdir', '-p', path.posix.dirname(destination));
            text('push', local, destination);
        },
        fixFixtureOwnership() {
            if (!owned) throw new Error('Baseline not installed');
            const uid = appUid();
            // This entire installation was created by this invocation, never a pre-existing account.
            text('shell', 'chown', '-R', `${uid}:${uid}`, privatePath('data'));
        },
        native(method, endpoint, body) {
            assert.ok(['status', 'import'].includes(endpoint));
            if (!nativeClient) nativeClient = nativeClientFactory({ root, packageName: PACKAGE, execute, uid: appUid() });
            const payload = body === undefined ? '' : JSON.stringify(body);
            const request = `${method} /api/android/native/${endpoint} HTTP/1.0\r\nHost: 127.0.0.1:17614\r\nx-android-host: ${token()}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`;
            return parseHttpResponse(nativeClient.request(request, { responseTimeoutMs: endpoint === 'import' ? 600000 : 30000 }));
        },
        close() { nativeClient?.close(); },
    };
}

export async function readApkRuntime(apk, root) {
    const yauzl = createRequire(path.join(root, 'server/package.json'))('yauzl');
    return new Promise((resolve, reject) => yauzl.open(apk, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error);
        let result;
        const fail = error => { zip.close(); reject(error); };
        zip.on('error', fail);
        zip.on('end', () => result ? resolve(result) : reject(new Error('APK runtime metadata missing')));
        zip.on('entry', entry => {
            if (entry.fileName !== 'assets/runtime.json') return zip.readEntry();
            if (result || entry.uncompressedSize > 1024 ** 2) return fail(new Error('Duplicate or oversized APK runtime metadata'));
            zip.openReadStream(entry, (error, stream) => {
                if (error) return fail(error);
                const chunks = [];
                stream.on('error', fail);
                stream.on('data', chunk => chunks.push(chunk));
                stream.on('end', () => { try { result = JSON.parse(Buffer.concat(chunks)); zip.readEntry(); } catch (error) { fail(error); } });
            });
        });
        zip.readEntry();
    }));
}

export async function makeMigrationZip(destination, files, { corrupt = false, root } = {}) {
    const archive = createRequire(path.join(root, 'server/package.json'))('archiver')('zip');
    const complete = pipeline(archive, fs.createWriteStream(destination, { flags: 'wx' }));
    const manifest = [];
    for (const [name, content] of Object.entries(files)) {
        const bytes = Buffer.from(content);
        manifest.push({ path: name, size: bytes.length, sha256: corrupt ? '0'.repeat(64) : digest(bytes) });
        archive.append(bytes, { name: 'user/' + name });
    }
    archive.append(JSON.stringify({ format: 'sillytavern-android-migration', version: 1, files: manifest }), { name: 'manifest.json' });
    await archive.finalize(); await complete;
}

async function findBuildTool(root, name) {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(root, '.local/android-sdk');
    const directory = path.join(sdk, 'build-tools');
    const versions = (await fsp.readdir(directory)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
        const file = path.join(directory, version, name + (process.platform === 'win32' ? '.exe' : ''));
        if (fs.existsSync(file)) return file;
    }
    throw new Error(`SDK ${name} required`);
}

export async function runAcceptance(options, { root = path.resolve(import.meta.dirname, '..') } = {}) {
    const helper = await import(pathToFileURL(path.join(root, 'scripts/android-test-tools.mjs')));
    const { verifyApkCertificate } = await import(pathToFileURL(path.join(root, 'scripts/write-checksums.mjs')));
    const aapt = await findBuildTool(root, 'aapt');
    const describe = async apk => ({ ...parseApkBadging(execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8' })), certificate: await verifyApkCertificate(apk, root) });
    const baseline = await describe(options.baselineApk), current = await describe(options.newApk);
    assertUpgradeIdentity(baseline, current);
    const expected = JSON.parse(await fsp.readFile(path.join(root, 'android/app/src/main/assets/runtime.json'), 'utf8'));
    const buildIdentity = await helper.readBuildIdentity(root); // Reject a stale runtime before touching the emulator.
    const oldRuntime = await readApkRuntime(options.baselineApk, root), runtime = await readApkRuntime(options.newApk, root);
    assert.equal(oldRuntime.appVersion, '1.1.2'); assert.match(oldRuntime.runtimeSha256, /^[a-f0-9]{64}$/);
    assertRuntimeIdentity(runtime, expected, runtime.runtimeSha256);
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(root, '.local/android-sdk');
    const adb = process.env.ST_ANDROID_ADB || path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    const device = createReleaseDevice({ root, serial: options.serial, adb });
    const runId = crypto.randomBytes(16).toString('hex');
    const local = path.join(root, '.local', 'release-upgrade-fixtures', runId);
    await fsp.mkdir(local, { recursive: true });
    const report = { ...buildIdentity, device: options.serial, package: PACKAGE, baseline, current, runId, passed: false, checks: [],
        scope: 'Original-signed release upgrade: artifact identity, data retention, runtime identity, private transport and native import; runtime WebView debugging closure is outside this userdebug suite.',
        coverage: { nativeImport: 'not-run', pickerUi: 'not-run: Android document picker and Kotlin URI staging require a separate UI test', webView: 'non-debuggable release manifest and live native WebView presence; no page interaction', runtimeDebuggingClosure: 'not-verified: provider debugging is forced on userdebug Android; requires separate validation on a user system' } };
    const passed = (id, description) => report.checks.push({ id, passed: true, required: true, description });
    const user = 'data/default-user/';
    const hashes = names => Object.fromEntries(names.map(name => [name, digest(device.read(user + name))]));
    const put = async (relative, bytes) => {
        const file = path.join(local, crypto.randomBytes(8).toString('hex'));
        await fsp.writeFile(file, bytes, { flag: 'wx' }); device.put(file, relative);
    };
    const ready = () => helper.until(() => { const response = device.native('GET', 'status'); return response.status === 200 && response.body.ready && response.body; }, 180000);
    const installedVersion = code => {
        const dump = device.text('shell', 'dumpsys', 'package', PACKAGE);
        assert.match(dump, new RegExp(`versionCode=${code}\\b`));
        assert.match(dump, new RegExp(`versionName=1\\.1\\.${code === 5 ? 2 : 3}\\b`));
        assert.doesNotMatch(dump, /(?:pkgFlags|flags)=\[[^\]]*\bDEBUGGABLE\b/);
    };
    try {
        device.installBaseline(options.baselineApk); installedVersion(5);
        report.baseline.apkSha256 = await helper.verifyInstalledApk(device, options.baselineApk);
        device.start();
        await helper.until(() => device.read(`runtimes/${oldRuntime.runtimeSha256}/.complete`).toString().trim() === oldRuntime.runtimeSha256 && device.exists(user + 'settings.json') && oldRuntime.plugins.every(plugin => device.exists(user + `extensions/${plugin.name}/manifest.json`)) && device.exists('data/_global/bundled-extensions.json') && device.token(), 180000);
        const oldToken = device.token(); device.stop();
        const settings = JSON.parse(device.read(user + 'settings.json'));
        settings.androidUpgradeFixture = runId;
        const chat = [{ user_name: 'Synthetic user', character_name: 'Synthetic fixture', chat_metadata: { acceptance: runId } }, { name: 'Synthetic fixture', is_user: false, is_system: false, send_date: '2026-09-30T00:00:00.000Z', mes: '合成聊天😀 ' + 'x'.repeat(64000), extra: {} }].map(row => JSON.stringify(row)).join('\n') + '\n';
        const fixtures = {
            'settings.json': JSON.stringify(settings),
            'chats/acceptance-fixture/upgrade.jsonl': chat,
            'secrets.json': JSON.stringify({ api_key_openai: [{ id: runId, value: 'synthetic-not-a-real-key-' + runId, label: 'Acceptance only', active: true }] }),
            'extensions/acceptance-fixture/manifest.json': JSON.stringify({ display_name: 'Synthetic acceptance fixture', version: '1.0.0', js: 'index.js' }),
            'extensions/acceptance-fixture/index.js': '// Synthetic acceptance fixture; intentionally no runtime behavior.\n',
        };
        for (const [name, content] of Object.entries(fixtures)) await put(user + name, content);
        device.fixFixtureOwnership();
        const names = Object.keys(fixtures); report.before = hashes(names);
        device.installUpgrade(options.newApk); installedVersion(6);
        report.current.apkSha256 = await helper.verifyInstalledApk(device, options.newApk);
        device.start(); await ready();
        assertTokenRotation(oldToken, device.token()); report.tokenRotated = true;
        report.after = hashes(names); assertPreserved(report.before, report.after);
        const marker = device.read(`runtimes/${runtime.runtimeSha256}/.complete`).toString();
        assertRuntimeIdentity(runtime, expected, marker); report.runtime = runtime;
        for (const plugin of runtime.plugins) {
            const manifest = JSON.parse(device.read(user + `extensions/${plugin.name}/manifest.json`));
            assert.equal(manifest.version, plugin.version); assert.equal(manifest.androidPatchRevision, plugin.androidPatchRevision);
        }
        const nativeWebViewPresent = await helper.until(() => device.text('shell', 'dumpsys', 'activity', 'top').includes('android.webkit.WebView'), 90000);
        const pid = device.text('shell', 'pidof', PACKAGE); assert.match(pid, /^\d+$/);
        const sockets = device.text('shell', 'cat', '/proc/net/unix');
        const webViewEvidence = releaseWebViewEvidence({ systemBuildType: device.props.type, pid, sockets, appDebuggable: current.debuggable, nativeWebViewPresent });
        report.releaseDebugging = webViewEvidence.releaseDebugging;
        const tcp = device.text('shell', 'cat', '/proc/net/tcp', '/proc/net/tcp6');
        report.gatewayInode = assertLoopbackGateway(tcp, device.text('shell', 'ls', '-l', `/proc/${pid}/fd`));
        passed('artifact-identity', 'Original signer, exact package/code/version, installed APK SHA-256');
        passed('retention', 'Synthetic settings/chat/plugin/secrets hashes preserved; host token rotated');
        passed('runtime-identity', 'Current runtime marker and installed bundled patch revisions');
        report.checks.push(...webViewEvidence.checks);
        passed('private-transport', 'Unix IPC ready; loopback browser gateway belongs to the Android main process');

        const migrated = { 'settings.json': JSON.stringify({ ...settings, androidImportFixture: runId }), 'chats/acceptance-fixture/imported.jsonl': chat };
        const importOne = async (corrupt, expectedStatus) => {
            const id = crypto.randomBytes(16).toString('hex'), zip = path.join(local, id + '.zip');
            await makeMigrationZip(zip, migrated, { corrupt, root }); device.put(zip, `imports/${id}.zip`);
            const response = device.native('POST', 'import', { id });
            assert.equal(response.status, expectedStatus, `Import returned ${response.status}: ${JSON.stringify(response.body)}`);
            assert.equal(device.exists(`imports/${id}.zip`), false, 'Import operation ZIP was not cleaned');
            return response.body;
        };
        await importOne(true, 400); assertPreserved(report.after, hashes(names));
        const imported = await importOne(false, 200);
        assert.equal(imported.restartRequired, true); assert.match(imported.backup, /^default-user\.previous-[a-f0-9-]{36}$/);
        assert.equal(digest(device.read(`data/${imported.backup}/chats/acceptance-fixture/upgrade.jsonl`)), report.before['chats/acceptance-fixture/upgrade.jsonl']);
        const kept = names.filter(name => name.startsWith('extensions/') || name === 'secrets.json');
        assertPreserved(Object.fromEntries(kept.map(name => [name, report.before[name]])), hashes(kept));
        for (const [name, content] of Object.entries(migrated)) assert.equal(digest(device.read(user + name)), digest(content));
        await importOne(false, 409);
        device.stop(); device.start(); await ready();
        assert.equal(JSON.parse(device.read(user + 'settings.json')).androidImportFixture, runId);
        assertPreserved(Object.fromEntries(kept.map(name => [name, report.before[name]])), hashes(kept));
        report.coverage.nativeImport = 'passed: corrupt ZIP 400, valid ZIP 200/backup/retention, restart-pending 409, owned ZIP cleanup, restart';
        passed('native-import', report.coverage.nativeImport);
        assert.deepEqual(await helper.readBuildIdentity(root), buildIdentity, 'Source/build identity changed during acceptance');
        passed('source-stability', 'Source/build identity unchanged at completion');
        report.passed = true;
    } catch (error) {
        report.error = error.message;
        throw error;
    } finally {
        try { device.close(); } catch { /* Preserve the acceptance result on disconnect. */ }
        report.reportPath = await helper.writeAcceptanceReport(root, 'release-upgrade', report);
        console.log(JSON.stringify({ passed: report.passed, report: report.reportPath, pickerUi: report.coverage.pickerUi }, null, 2));
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runAcceptance(parseArgs(process.argv.slice(2)));
