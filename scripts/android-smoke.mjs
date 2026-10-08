import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { createAndroidDevice, readBuildIdentity, verifyInstalledApk, writeAcceptanceReport, until } from './android-test-tools.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: {
    serial: { type: 'string' }, package: { type: 'string' }, apk: { type: 'string' },
    'expected-api': { type: 'string' }, 'expected-page-size': { type: 'string' },
} });
const report = { passed: false, checks: [], scope: 'Debug emulator; local model fixture; no release or external-provider claim' };
const check = (id, description) => report.checks.push({ id, description, required: true, passed: true });
let device, model, cookie, csrf, origin, failure, calls = 0;
async function request(url, body, extraHeaders = {}) {
    const response = await fetch(origin + url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    for (const set of response.headers.getSetCookie()) cookie += '; ' + set.split(';')[0];
    return response;
}
async function refreshSession() {
    await until(() => device.nativeStatus().ready);
    cookie = 'st_android_auth=' + device.readPrivate('host-token');
    csrf = undefined;
    csrf = await until(async () => {
        const response = await request('/csrf-token');
        return response.ok && (await response.json()).token;
    });
}
try {
    Object.assign(report, await readBuildIdentity(root));
    device = createAndroidDevice({ root, serial: values.serial, packageName: values.package });
    report.device = device.serial;
    report.package = device.packageName;
    assert.equal(device.text('shell', 'getprop', 'ro.kernel.qemu'), '1', 'Use a disposable emulator for this lifecycle test.');
    device.checkNativeClient();
    report.api = Number(device.text('shell', 'getprop', 'ro.build.version.sdk'));
    report.android = device.text('shell', 'getprop', 'ro.build.version.release');
    report.pageSize = Number(device.text('shell', 'getconf', 'PAGESIZE'));
    if (values['expected-api']) assert.equal(report.api, Number(values['expected-api']));
    if (values['expected-page-size']) assert.equal(report.pageSize, Number(values['expected-page-size']));
    report.apkSha256 = await verifyInstalledApk(device, path.resolve(values.apk || path.join(root, `releases/SillyTavern-Standalone-${report.appVersion}-debug.apk`)));
    report.installedVersion = device.text('shell', 'dumpsys', 'package', device.packageName).match(/versionName=([^\s]+)/)?.[1];
    assert.equal(report.installedVersion, report.appVersion);
    if (report.api >= 33) device.text('shell', 'pm', 'grant', device.packageName, 'android.permission.POST_NOTIFICATIONS');
    device.start();
    origin = 'http://127.0.0.1:' + device.forward('tcp:17614');
    await refreshSession();
    assert.equal(device.readPrivate(`runtimes/${report.runtimeSha256}/.complete`), report.runtimeSha256);
    report.runtime = JSON.parse(device.readPrivate('runtime-checks.json'));
    assert.equal(report.runtime.node, report.nodeVersion);
    for (const key of ['fileReadWrite', 'unicodeProperties', 'intl', 'wasm', 'wasmMemoryBounds', 'wasmMemoryGrowth']) assert.equal(report.runtime[key], true, key);
    assert.equal((await (await request('/version')).json()).pkgVersion, report.coreVersion);
    check('runtime', 'Installed APK, deployed runtime, versions and runtime probes match the current build.');

    assert.equal((await fetch(origin + '/', { signal: AbortSignal.timeout(5000) })).status, 403);
    assert.equal((await fetch(origin + '/api/ping', { method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(5000) })).status, 403);
    const nativeOverWeb = await request('/api/android/native/status');
    assert.equal(nativeOverWeb.status, 403, 'A browser session cookie alone cannot authorize native operations.');
    check('auth', 'Unauthenticated and CSRF-free writes fail; browser cookies cannot authorize native operations.');
    const extensions = await (await request('/api/extensions/discover')).json();
    assert.equal(extensions.filter(extension => extension.name === 'third-party/JS-Slash-Runner').length, 1);
    check('helper', 'Exactly one active Tavern Helper is discovered.');

    model = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || '{}');
        calls++;
        const slow = body.messages?.[0]?.content === 'slow';
        let chunks = 0;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"后台中文"}}]}\n\n');
        const interval = setInterval(() => {
            if (++chunks >= (slow ? 60 : 12)) { clearInterval(interval); res.end('data: {"choices":[{"delta":{"content":"完成😀"}}]}\n\ndata: [DONE]\n\n'); }
            else res.write('data: {"choices":[{"delta":{"content":"。"}}]}\n\n');
        }, 250);
        res.on('close', () => clearInterval(interval));
    }).listen(0, '127.0.0.1');
    await once(model, 'listening');
    const modelPort = device.reverse(model.address().port);
    const create = async (slow = false) => {
        const id = crypto.randomUUID();
        const response = await request('/api/android/jobs', { id, endpoint: '/api/backends/chat-completions/generate', body: {
            chat_completion_source: 'custom', custom_url: `http://127.0.0.1:${modelPort}/v1`, model: 'mock',
            messages: [{ role: 'user', content: slow ? 'slow' : 'background' }], stream: true,
        }, context: { type: 'plugin', name: 'Android acceptance fixture' } });
        assert.equal(response.status, 202, await response.clone().text());
        return id;
    };
    const info = async id => (await request('/api/android/jobs/' + id)).json();
    const id = await create();
    device.text('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    device.text('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
    await until(async () => (await info(id)).state === 'complete', 20000);
    assert.match(await (await request('/api/android/jobs/' + id + '/content')).text(), /完成😀/);
    assert.equal(calls, 1);
    await until(() => device.text('shell', 'dumpsys', 'notification').split('\n').some(line => line.includes('pkg=' + device.packageName + ' ') && line.includes('id=1002 '))
        && device.text('exec-out', 'run-as', device.packageName, 'cat', 'shared_prefs/notifications.xml').includes(id), 15000);
    check('background', 'Home and screen off preserve one streamed result and completion notification.');
    device.text('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    device.text('shell', 'wm', 'dismiss-keyguard');
    device.start();
    const cancelId = await create(true);
    await until(async () => (await info(cancelId)).bytes > 0, 15000);
    assert.equal((await request('/api/android/jobs/' + cancelId + '/cancel', {})).status, 204);
    assert.equal((await info(cancelId)).state, 'cancelled');
    assert.ok((await info(cancelId)).bytes > 0);
    check('cancel', 'Cancellation keeps received bytes.');

    const survives = await create();
    await until(async () => (await info(survives)).bytes > 0, 15000);
    const mainPid = device.text('shell', 'pidof', device.packageName).split(/\s+/)[0];
    assert.match(mainPid, /^\d+$/);
    device.text('exec-out', 'run-as', device.packageName, 'kill', '-9', mainPid);
    // The Activity owns the TCP gateway, so observe the same-UID socket while it is gone.
    await until(() => device.nativeStatus().results.some(result => result.id === survives && result.state === 'complete'), 20000);
    device.start();
    await refreshSession();
    assert.equal((await info(survives)).state, 'complete');
    check('activity-recovery', 'Killing the Activity leaves the Node service generating; reopening recovers the result.');

    const interrupted = await create(true);
    await until(async () => (await info(interrupted)).bytes > 0, 15000);
    const beforeRestart = calls;
    const beforeToken = device.readPrivate('host-token');
    device.text('shell', 'am', 'force-stop', device.packageName);
    device.start();
    await until(() => device.readPrivate('host-token') !== beforeToken);
    await refreshSession();
    assert.equal((await info(interrupted)).state, 'interrupted');
    assert.equal(calls, beforeRestart);
    check('process-recovery', 'Whole-process termination rotates the native token and recovers partial output without resubmission.');
    assert.deepEqual(await readBuildIdentity(root), { appVersion: report.appVersion, coreVersion: report.coreVersion, nodeVersion: report.nodeVersion, sourceHash: report.sourceHash, runtimeSha256: report.runtimeSha256 }, 'Source changed during acceptance; rerun after changes settle.');
    report.passed = true;
} catch (error) {
    report.error = error.message;
    failure = error;
} finally {
    if (model) { model.closeAllConnections(); model.close(); }
    device?.close();
    const evidence = await writeAcceptanceReport(root, 'android-smoke', report);
    console.log(JSON.stringify({ passed: report.passed, evidence, device: report.device, checks: report.checks }, null, 2));
}
if (failure) { console.error(failure.message); process.exitCode = 1; }
