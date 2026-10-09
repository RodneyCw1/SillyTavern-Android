import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const sourceRoot = process.env.ST_ANDROID_TEST_SOURCE_ROOT || root;
const load = () => import(pathToFileURL(path.join(sourceRoot, 'scripts/release-user-acceptance.mjs')));
const pkg = 'io.sillytavern.standalone';
const avd = 'SillyTavern113-Api35-Play16k-User';
const environment = () => ({ avd, qemu: '1', api: '35', pageSize: '16384', type: 'user', shellUid: '2000', abi: 'x86_64', playStore: true });

test('user Release accepts only the explicitly selected dedicated API35 16KB non-root emulator', async () => {
    const { assertUserEnvironment } = await load();
    assert.doesNotThrow(() => assertUserEnvironment('emulator-5560', avd, environment()));
    for (const change of [{ qemu: '0' }, { api: '29' }, { pageSize: '4096' }, { type: 'userdebug' }, { shellUid: '0' }, { abi: 'arm64-v8a' }, { playStore: false }, { avd: avd + '-other' }]) {
        assert.throws(() => assertUserEnvironment('emulator-5560', avd, { ...environment(), ...change }));
    }
    assert.throws(() => assertUserEnvironment('physical-123', avd, environment()));
    assert.throws(() => assertUserEnvironment('emulator-5560', '', environment()));
    assert.throws(() => assertUserEnvironment('emulator-5560', 'personal', { ...environment(), avd: 'personal' }));
});

test('fresh Release rejects installed and kept-data records but not similarly named packages', async () => {
    const { assertFreshRelease } = await load();
    assert.doesNotThrow(() => assertFreshRelease(`package:${pkg}.debug\r\r\npackage:${pkg}.other`));
    for (const output of [`package:${pkg}`, `package:${pkg}.debug\npackage:${pkg}\n`]) {
        assert.throws(() => assertFreshRelease(output), /fresh|retained|installed/i);
    }
    assert.throws(() => assertFreshRelease('Error: package manager unavailable'), /package|inventory/i);
});

test('pre-existing Debug requires both the exact installed artifact and a receipt for this dedicated fixture', async () => {
    const { assertDebugFixture } = await load();
    const expected = { serial: 'emulator-5560', avd, apkSha256: 'a'.repeat(64) };
    const receipt = { kind: 'release-user-debug-fixture', ...expected };
    assert.doesNotThrow(() => assertDebugFixture(expected.apkSha256, expected, receipt));
    for (const bad of [null, { ...receipt, avd: 'other' }, { ...receipt, serial: 'emulator-5554' }, { ...receipt, apkSha256: 'b'.repeat(64) }, { ...receipt, kind: 'ordinary-app' }]) {
        assert.throws(() => assertDebugFixture(expected.apkSha256, expected, bad), /fixture|receipt/i);
    }
    assert.throws(() => assertDebugFixture('b'.repeat(64), expected, receipt), /artifact|APK/i);
});

test('main-process and Unix-socket matching never confuses PID prefixes or runtime subprocesses', async () => {
    const { parseMainPid, hasExactDevtoolsSocket } = await load();
    const processList = `PID NAME\n123 ${pkg}\n124 ${pkg}:runtime\n1234 ${pkg}.debug\n`;
    assert.equal(parseMainPid(processList, pkg), '123');
    assert.throws(() => parseMainPid(`PID NAME\n124 ${pkg}:runtime`, pkg), /main process/i);
    assert.throws(() => parseMainPid(`PID NAME\n123 ${pkg}\n456 ${pkg}`, pkg), /main process/i);
    const header = 'Num RefCount Protocol Flags Type St Inode Path\n';
    const socket = name => `00000000: 00000002 00000000 00010000 0001 01 123 ${name}\n`;
    assert.equal(hasExactDevtoolsSocket(header + socket('@webview_devtools_remote_1234'), '123'), false);
    assert.equal(hasExactDevtoolsSocket(header + socket('@webview_devtools_remote_123'), '123'), true);
    assert.equal(hasExactDevtoolsSocket(header + socket('@webview_devtools_remote_123.extra'), '123'), false);
    assert.throws(() => hasExactDevtoolsSocket('Permission denied', '123'), /Unix|socket|table/i);
    assert.throws(() => hasExactDevtoolsSocket(header, '123 124'), /PID/i);
});

test('a negative CDP result needs a working positive control, live stable PID and a full observation window', async () => {
    const { assertCdpObservation } = await load();
    const positive = { connected: true, ready: true, pid: '123' };
    const samples = [0, 5000, 10000].map(elapsedMs => ({ elapsedMs, pid: '456', socketVisible: null, httpReachable: false }));
    assert.doesNotThrow(() => assertCdpObservation(positive, samples));
    for (const bad of [null, { ...positive, connected: false }, { ...positive, ready: false }, { ...positive, pid: '' }]) {
        assert.throws(() => assertCdpObservation(bad, samples), /positive|Debug/i);
    }
    assert.throws(() => assertCdpObservation(positive, samples.slice(0, 2)), /observation|10/i);
    for (const change of [{ pid: '457' }, { pid: '' }, { socketVisible: true }, { httpReachable: true }, { httpReachable: null }]) {
        assert.throws(() => assertCdpObservation(positive, [samples[0], { ...samples[1], ...change }, samples[2]]));
    }
    assert.throws(() => assertCdpObservation(positive, [samples[0], samples[2], samples[1]]), /observation|monotonic/i);
});

test('Release readiness requires real application UI, not an empty WebView or failure status', async () => {
    const { assertReadyUi } = await load();
    const node = (text, cls = 'android.widget.TextView') => `<node package="${pkg}" class="${cls}" text="${text}" enabled="true" bounds="[0,0][300,100]"/>`;
    const toolbar = ['更新', '重启', '退出'].map(text => node(text, 'android.widget.Button')).join('');
    const ready = `<hierarchy>${toolbar}${node('', 'android.webkit.WebView')}${node('Welcome to SillyTavern!')}${node('Persona Name:')}${node('User', 'android.widget.EditText')}</hierarchy>`;
    assert.equal(assertReadyUi(ready, pkg).state, 'onboarding');
    assert.throws(() => assertReadyUi(ready.replace('</hierarchy>', node('恢复结果', 'android.widget.Button') + '</hierarchy>'), pkg), /toolbar/i);
    assert.throws(() => assertReadyUi(ready.replace(node('更新', 'android.widget.Button'), ''), pkg), /toolbar/i);
    for (const bad of [toolbar, ready.replace('Welcome to SillyTavern!', ''), ready.replaceAll(pkg, pkg + '.debug'), ready.replace('</hierarchy>', node('页面进程已停止（内存回收或浏览器异常）。') + '</hierarchy>'), ready.replace('</hierarchy>', node('正在准备独立运行环境，首次启动需要解压资源…') + '</hierarchy>')]) {
        assert.throws(() => assertReadyUi(bad, pkg), /UI|page|WebView|ready/i);
    }
});

test('native toolbar measurements reject wrong order, size and spacing', async () => {
    const { assertToolbarLayout } = await load();
    const node = (text, bounds) => `<node package="${pkg}" class="android.widget.Button" text="${text}" enabled="true" bounds="${bounds}"/>`;
    const update = node('更新', '[12,32][108,80]');
    const restart = node('重启', '[116,32][212,80]');
    const exit = node('退出', '[220,32][316,80]');
    const options = { density: 1, contentLeft: 0, contentRight: 328 };
    assert.deepEqual(assertToolbarLayout(update + restart + exit, pkg, options).labels, ['更新', '重启', '退出']);
    for (const bad of [restart + update + exit, update.replace('108,80', '108,76') + restart + exit, update + restart.replace('116,32', '118,32') + exit, update + restart + exit.replace('316,80', '312,80')]) {
        assert.throws(() => assertToolbarLayout(bad, pkg, options), /toolbar|Toolbar/);
    }
});

test('Debug readiness waits for core initialization without requiring settingsReady on getContext', async () => {
    const { waitForDebugPageReady } = await load();
    let initialized = false;
    const browserContext = {
        document: { readyState: 'complete', querySelector: () => null },
        window: {
            STAndroid: { exportBlob() {} },
            SillyTavern: { getContext() {
                if (!initialized) throw new ReferenceError('Core binding is in its temporal dead zone');
                return { name1: 'Synthetic acceptance' }; // settingsReady belongs to /script.js.
            } },
        },
    };
    const page = { waitForFunction: async predicate => {
        assert.equal(initialized, true, 'Core/module readiness must be established');
        assert.equal(vm.runInNewContext(`(${predicate.toString()})()`, browserContext), true);
    } };
    const result = await waitForDebugPageReady(page, async () => { initialized = true; return { completedOnboarding: true }; });
    assert.deepEqual(result, { completedOnboarding: true });
    await assert.rejects(waitForDebugPageReady(page, async () => { throw Error('core not ready'); }), /core not ready/);
});

test('CDP HTTP probing distinguishes actual absence from an HTTP error or a stalled transport', async () => {
    const { probeCdpHttp } = await load();
    const server = http.createServer((request, response) => {
        response.writeHead(503); response.end('Not a working CDP page');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const errorPage = await probeCdpHttp(port);
        assert.equal(errorPage.reachable, true);
        assert.equal(errorPage.status, 503);
        server.removeAllListeners('request');
        server.on('request', () => {});
        await assert.rejects(probeCdpHttp(port, { timeoutMs: 30 }), /timed out/);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    assert.deepEqual(await probeCdpHttp(port), { reachable: false });
});

test('CLI requires all explicit selection flags and exits unsuccessfully without touching a device', async () => {
    const { parseArgs } = await load();
    const args = ['--serial', 'emulator-5560', '--avd', avd, '--debug-apk', 'debug.apk', '--release-apk', 'release.apk'];
    assert.equal(parseArgs(args).avd, avd);
    for (const bad of [[], args.slice(0, -2), [...args, '--avd', avd], [...args, '--root'], args.map(value => value === 'release.apk' ? 'debug.apk' : value)]) assert.throws(() => parseArgs(bad));
    const result = spawnSync(process.execPath, [path.join(sourceRoot, 'scripts/release-user-acceptance.mjs')], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--serial.*--avd.*--debug-apk.*--release-apk/);
});
