import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readBuildIdentity, verifyInstalledApk, writeAcceptanceReport, until } from './android-test-tools.mjs';
import { parseApkBadging, readApkRuntime } from './release-upgrade-acceptance.mjs';
import { parseUiNodes } from './import-ui-acceptance.mjs';
import { waitForAcceptanceReady } from './folder-export-acceptance.mjs';
import { hashSourceFile } from './source-inventory.mjs';

const RELEASE = 'io.sillytavern.standalone';
const DEBUG = RELEASE + '.debug';
const ORIGIN = 'http://127.0.0.1:17614/';
const USAGE = 'Required: --serial emulator-N --avd SillyTavern… --debug-apk PATH --release-apk PATH';
const lines = text => String(text).split(/\r*\n/).map(value => value.trim()).filter(Boolean);

export function parseArgs(args) {
    const result = {}, flags = { '--serial': 'serial', '--avd': 'avd', '--debug-apk': 'debugApk', '--release-apk': 'releaseApk' };
    for (let i = 0; i < args.length; i += 2) {
        const key = flags[args[i]], value = args[i + 1];
        assert.ok(key && !result[key] && value && !value.startsWith('--'), USAGE);
        result[key] = value;
    }
    assert.ok(/^emulator-\d+$/.test(result.serial || '') && /^SillyTavern[\w-]+$/.test(result.avd || '') && result.debugApk && result.releaseApk, USAGE);
    result.debugApk = path.resolve(result.debugApk); result.releaseApk = path.resolve(result.releaseApk);
    assert.notEqual(result.debugApk, result.releaseApk, 'Debug and Release APK paths must differ');
    return result;
}

export function assertUserEnvironment(serial, expectedAvd, props) {
    assert.match(serial, /^emulator-\d+$/, 'Explicit emulator serial required');
    assert.match(expectedAvd, /^SillyTavern[\w-]+$/, 'Explicit dedicated SillyTavern AVD required');
    assert.equal(props.avd, expectedAvd, 'AVD name must match exactly');
    for (const [key, value] of Object.entries({ qemu: '1', api: '35', pageSize: '16384', type: 'user', shellUid: '2000', abi: 'x86_64' })) {
        assert.equal(props[key], value, `Unsafe or unsupported emulator ${key}`);
    }
    assert.equal(props.playStore, true, 'Google Play user system image required');
}

export function assertFreshRelease(packageList) {
    assert.ok(lines(packageList).every(line => /^package:[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(line)), 'Invalid package inventory response');
    assert.ok(!lines(packageList).includes('package:' + RELEASE), 'Release is installed or has retained data; use a fresh dedicated AVD');
}

export function assertDebugFixture(installedHash, expected, receipt) {
    assert.match(expected.apkSha256, /^[a-f0-9]{64}$/);
    assert.equal(installedHash, expected.apkSha256, 'Existing Debug APK differs from the requested artifact');
    assert.equal(receipt?.kind, 'release-user-debug-fixture', 'Existing Debug needs this suite\'s fixture receipt');
    for (const key of ['serial', 'avd', 'apkSha256']) assert.equal(receipt[key], expected[key], `Debug fixture receipt ${key} mismatch`);
}

export function parseMainPid(processList, packageName) {
    assert.ok([DEBUG, RELEASE].includes(packageName));
    const matches = lines(processList).map(line => /^(\d+)\s+(\S+)$/.exec(line)).filter(row => row && row[2] === packageName);
    assert.equal(matches.length, 1, 'Expected exactly one live app main process');
    assert.match(matches[0][1], /^[1-9]\d*$/, 'Invalid main process PID');
    return matches[0][1];
}

export function hasExactDevtoolsSocket(table, pid) {
    assert.match(pid, /^[1-9]\d*$/, 'Invalid main PID');
    assert.match(table, /^Num\s+RefCount\s+Protocol\s+Flags\s+Type\s+St\s+Inode\s+Path\s*$/m, 'Unreadable Unix socket table');
    return lines(table).some(line => line.split(/\s+/).at(-1) === '@webview_devtools_remote_' + pid);
}

export function assertCdpObservation(positive, samples) {
    assert.ok(positive?.connected === true && positive.ready === true && /^[1-9]\d*$/.test(positive.pid || ''), 'Debug CDP positive control must connect to a ready page');
    assert.ok(samples.length >= 3 && samples[0].elapsedMs === 0 && samples.at(-1).elapsedMs >= 10000, 'CDP observation must cover at least 10 seconds');
    let previous = -1;
    for (const sample of samples) {
        assert.ok(Number.isFinite(sample.elapsedMs) && sample.elapsedMs > previous, 'CDP observation times must be monotonic');
        previous = sample.elapsedMs;
        assert.match(sample.pid, /^[1-9]\d*$/, 'App main PID must remain alive');
        assert.equal(sample.pid, samples[0].pid, 'Release main PID changed during observation');
        assert.ok(sample.socketVisible === false || sample.socketVisible === null, 'Release exposes a WebView devtools socket');
        assert.equal(sample.httpReachable, false, 'Release CDP HTTP must be unavailable, not unknown or reachable');
    }
}

export function assertReadyUi(xml, packageName) {
    const nodes = parseUiNodes(xml).filter(node => node.visible && node.package === packageName);
    const text = nodes.map(node => [node.text, node['content-desc']].filter(Boolean).join(' ')).join('\n');
    assert.ok(!/正在准备独立运行环境|启动失败|启动时间较长|无法安全连接|端口被占用|页面进程已停止|版本过旧|正在重启/.test(text), 'Application UI is not ready');
    assert.ok(nodes.some(node => node.class === 'android.webkit.WebView'), 'Live app WebView is missing from UI');
    const toolbarLabels = nodes.filter(node => node.class === 'android.widget.Button').map(node => node.text);
    for (const label of ['更新', '重启', '退出']) assert.ok(toolbarLabels.includes(label), 'Native application toolbar UI is missing');
    assert.ok(!toolbarLabels.some(label => ['导入数据', '恢复结果'].includes(label)), 'Hidden native toolbar entries are still visible');
    const onboarding = /Welcome to SillyTavern!|欢迎(?:使用|来到)\s*SillyTavern/.test(text) && nodes.some(node => node.class === 'android.widget.EditText');
    const chat = nodes.some(node => /(?:^|[/:])send_textarea$/.test(node['resource-id'] || '') && node.class === 'android.widget.EditText');
    assert.ok(onboarding || chat, 'Actual SillyTavern page is not ready in UI');
    return { state: onboarding ? 'onboarding' : 'chat', visibleNodes: nodes.length };
}

export function assertToolbarLayout(xml, packageName, { density, contentLeft, contentRight } = {}) {
    assert.ok(Number.isFinite(density) && density > 0, 'Screen density is required for toolbar measurements');
    const labels = ['更新', '重启', '退出'];
    const nodes = parseUiNodes(xml).filter(node => node.visible && node.package === packageName && node.class === 'android.widget.Button' && labels.includes(node.text));
    assert.deepEqual(nodes.map(node => node.text), labels, 'Native toolbar button order or count is wrong');
    const bounds = nodes.map(node => node.bounds.match(/\d+/g).map(Number));
    const near = (actual, dp) => assert.ok(Math.abs(actual - dp * density) <= 1, `Toolbar dimension ${actual}px differs from ${dp}dp`);
    const widths = bounds.map(([left, , right]) => right - left);
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, 'Native toolbar buttons must have equal widths');
    bounds.forEach(([, top, , bottom]) => { near(bottom - top, 48); assert.equal(top, bounds[0][1], 'Toolbar buttons must align'); });
    for (let i = 1; i < bounds.length; i++) near(bounds[i][0] - bounds[i - 1][2], 8);
    if (Number.isFinite(contentLeft)) near(bounds[0][0] - contentLeft, 12);
    if (Number.isFinite(contentRight)) near(contentRight - bounds.at(-1)[2], 12);
    return { labels, bounds, density };
}

export async function waitForDebugPageReady(page, waitForReady = waitForAcceptanceReady) {
    // The shared helper waits for /script.js.settingsReady and completes real
    // onboarding before any context access. getContext does not export settingsReady.
    const readiness = await waitForReady(page);
    await page.waitForFunction(() => document.readyState === 'complete'
        && typeof window.STAndroid?.exportBlob === 'function'
        && typeof window.SillyTavern?.getContext === 'function', { timeout: 90000 });
    return readiness;
}

// Only connection refusal/reset proves a missing forwarded socket. Timeouts, HTTP errors,
// malformed JSON and disconnected ADB remain failures rather than evidence of absence.
export function probeCdpHttp(port, { timeoutMs = 3000 } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: timeoutMs, agent: false }, response => {
            const chunks = []; let length = 0;
            response.on('data', chunk => { length += chunk.length; if (length > 1024 * 1024) request.destroy(new Error('CDP response too large')); else chunks.push(chunk); });
            response.on('error', reject);
            response.on('end', () => resolve({ reachable: true, status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('timeout', () => request.destroy(Object.assign(new Error('CDP request timed out'), { code: 'ETIMEDOUT' })));
        request.on('error', error => ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code) ? resolve({ reachable: false }) : reject(error));
    });
}

async function findAapt(sdk) {
    const directory = path.join(sdk, 'build-tools');
    for (const version of (await fs.readdir(directory)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        const file = path.join(directory, version, process.platform === 'win32' ? 'aapt.exe' : 'aapt');
        try { await fs.access(file); return file; } catch { /* Try the next installed tool version. */ }
    }
    throw Error('Android SDK aapt is required');
}

export async function runAcceptance(options, { root = path.resolve(import.meta.dirname, '..') } = {}) {
    const runId = crypto.randomBytes(12).toString('hex');
    const report = { passed: false, appVersion: null, coreVersion: null, nodeVersion: null, sourceHash: null, runtimeSha256: null, device: options.serial, avd: options.avd, package: RELEASE, runId, scope: 'API35 Google Play 16KB user image; fresh Release debugging boundary with live Debug positive control; no root or private data access', checks: [] };
    const descriptions = {
        'artifact-identity': 'Both APK manifests and embedded runtime identities match the current source-bound build.',
        environment: 'Exact dedicated API35 x86_64 Google Play 16KB user emulator; shell UID 2000.',
        'fresh-fixture': 'Release is absent including retained data; any existing Debug is the exact suite-owned fixture.',
        'debug-apk': 'The installed Debug base APK has the requested SHA-256.',
        'debug-positive': 'Actual Debug application UI and a connected CDP session show the ready SillyTavern page.',
        'debug-stopped': 'Debug package main and runtime processes have stopped before Release starts.',
        'release-apk': 'Fresh Release has the exact APK SHA-256 and a non-debuggable manifest.',
        'release-ui': 'The real Release WebView displays the SillyTavern application UI.',
        'release-cdp-disabled': 'A stable live Release PID exposes no devtools socket or CDP HTTP response throughout at least ten seconds.',
        'source-stability': 'Build/source identity remains unchanged at completion.',
        cleanup: 'Only this run\'s ADB forwards and temporary UI dump were removed; Release stays open.',
    };
    report.checks = Object.entries(descriptions).map(([id, description]) => ({ id, description, required: true, passed: false }));
    const pass = id => { report.checks.find(check => check.id === id).passed = true; };
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(root, '.local/android-sdk');
    const adb = process.env.ST_ANDROID_ADB || path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    const execute = (args, extra = {}) => execFileSync(adb, ['-s', options.serial, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 ** 2, ...extra });
    const text = (...args) => String(execute(args)).trim();
    const forwards = new Map();
    const remoteXml = '/data/local/tmp/st-release-user-' + runId + '.xml';
    const evidenceDirectory = path.join(root, 'docs/acceptance', 'release-user-' + runId);
    let guarded = false, debugOwned = false, debugStopped = false, launched = false;
    const processes = () => text('shell', 'ps', '-A', '-o', 'PID,NAME');
    const pid = pkg => parseMainPid(processes(), pkg);
    const forward = processId => {
        assert.match(processId, /^[1-9]\d*$/);
        const remote = 'localabstract:webview_devtools_remote_' + processId;
        const port = Number(text('forward', 'tcp:0', remote));
        assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'ADB forward allocation failed');
        forwards.set(port, remote); return port;
    };
    const verifyForward = port => {
        assert.equal(text('get-state'), 'device', 'Device disconnected during CDP observation');
        const expected = `${options.serial} tcp:${port} ${forwards.get(port)}`;
        assert.ok(lines(text('forward', '--list')).some(line => line.replace(/\s+/g, ' ') === expected), 'Owned ADB forward is missing');
    };
    const ui = async (pkg, name) => {
        text('shell', 'uiautomator', 'dump', remoteXml);
        const xml = text('exec-out', 'cat', remoteXml);
        await fs.writeFile(path.join(evidenceDirectory, name + '.xml'), xml);
        const result = assertReadyUi(xml, pkg);
        await fs.writeFile(path.join(evidenceDirectory, name + '.png'), execute(['exec-out', 'screencap', '-p'], { encoding: null }));
        return result;
    };
    const install = apk => {
        const output = String(execute(['install', apk], { timeout: 180000 }));
        assert.match(output, /\bSuccess\b/, 'APK install failed');
    };
    const start = pkg => {
        text('shell', 'pm', 'grant', pkg, 'android.permission.POST_NOTIFICATIONS');
        const result = text('shell', 'am', 'start', '-W', '-n', pkg + '/io.sillytavern.standalone.MainActivity');
        assert.ok(!/Error:|Exception/.test(result), 'Application launch failed');
        launched = true;
    };
    try {
        const identity = await readBuildIdentity(root); Object.assign(report, identity);
        const aapt = await findAapt(sdk);
        report.artifacts = {};
        for (const [kind, apk, packageName, debuggable] of [['debug', options.debugApk, DEBUG, true], ['release', options.releaseApk, RELEASE, false]]) {
            const manifest = parseApkBadging(execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8', timeout: 30000 }));
            assert.equal(manifest.packageName, packageName); assert.equal(manifest.debuggable, debuggable);
            assert.equal(manifest.versionName, identity.appVersion); assert.equal(manifest.versionCode, 6);
            const runtime = await readApkRuntime(apk, root);
            for (const key of ['appVersion', 'sourceHash', 'runtimeSha256']) assert.equal(runtime[key], identity[key], `Stale ${kind} APK ${key}`);
            report.artifacts[kind] = { ...manifest, apkSha256: (await hashSourceFile(apk)).sha256 };
        }
        pass('artifact-identity');
        assert.equal(text('get-state'), 'device');
        const props = Object.fromEntries(Object.entries({ qemu: 'ro.kernel.qemu', api: 'ro.build.version.sdk', type: 'ro.build.type', abi: 'ro.product.cpu.abi' }).map(([key, prop]) => [key, text('shell', 'getprop', prop)]));
        Object.assign(props, { avd: lines(text('emu', 'avd', 'name')).filter(line => line !== 'OK').join('\n'), shellUid: text('shell', 'id', '-u'), pageSize: text('shell', 'getconf', 'PAGESIZE'), playStore: lines(text('shell', 'pm', 'list', 'packages', 'com.android.vending')).includes('package:com.android.vending') });
        assertUserEnvironment(options.serial, options.avd, props); report.environment = props; pass('environment');
        report.systemFingerprint = text('shell', 'getprop', 'ro.build.fingerprint');
        report.webViewProvider = lines(text('shell', 'dumpsys', 'webviewupdate')).find(line => line.startsWith('Current WebView package')) || 'unavailable';
        const packages = text('shell', 'pm', 'list', 'packages', '-u', RELEASE);
        assertFreshRelease(packages);
        const receiptDirectory = path.join(root, '.local/release-user-fixtures');
        const receiptFile = path.join(receiptDirectory, crypto.createHash('sha256').update(options.serial + '\n' + options.avd).digest('hex') + '.json');
        const expectedFixture = { serial: options.serial, avd: options.avd, apkSha256: report.artifacts.debug.apkSha256 };
        const existingDebug = lines(packages).includes('package:' + DEBUG);
        if (existingDebug) {
            const installedHash = await verifyInstalledApk({ text, packageName: DEBUG }, options.debugApk);
            let receipt; try { receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')); } catch { /* Guard below rejects unowned installations. */ }
            assertDebugFixture(installedHash, expectedFixture, receipt);
        }
        pass('fresh-fixture'); guarded = true;
        await fs.mkdir(evidenceDirectory, { recursive: true });
        report.uiEvidence = path.relative(root, evidenceDirectory).replaceAll('\\', '/');
        if (!existingDebug) {
            install(options.debugApk); debugOwned = true;
            await fs.mkdir(receiptDirectory, { recursive: true });
            await fs.writeFile(receiptFile, JSON.stringify({ kind: 'release-user-debug-fixture', ...expectedFixture, createdAt: new Date().toISOString() }, null, 2));
        } else debugOwned = true;
        report.artifacts.debug.installedSha256 = await verifyInstalledApk({ text, packageName: DEBUG }, options.debugApk); pass('debug-apk');
        start(DEBUG);
        report.debugUi = await until(() => ui(DEBUG, 'debug-ready'), 240000);
        const debugPid = pid(DEBUG), debugPort = forward(debugPid);
        const { default: puppeteer } = await import('puppeteer-core');
        await until(async () => { verifyForward(debugPort); const response = await probeCdpHttp(debugPort); return response.reachable && response.status === 200 && JSON.parse(response.body).some(target => target.type === 'page' && target.url === ORIGIN); }, 60000);
        const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}`, defaultViewport: null });
        try {
            const page = (await browser.pages()).find(page => page.url() === ORIGIN);
            assert.ok(page, 'Debug positive control has no actual application page');
            report.debugReadiness = await waitForDebugPageReady(page);
            assert.equal(pid(DEBUG), debugPid, 'Debug PID changed during positive control');
            report.positiveControl = { connected: true, ready: true, pid: debugPid };
        } finally { browser.disconnect(); }
        pass('debug-positive');
        text('shell', 'am', 'force-stop', DEBUG);
        await until(() => !lines(processes()).some(line => { const name = line.split(/\s+/)[1]; return name === DEBUG || name?.startsWith(DEBUG + ':'); }), 30000);
        debugStopped = true; pass('debug-stopped');
        text('forward', '--remove', 'tcp:' + debugPort); forwards.delete(debugPort);
        assertFreshRelease(text('shell', 'pm', 'list', 'packages', '-u', RELEASE));
        install(options.releaseApk);
        report.artifacts.release.installedSha256 = await verifyInstalledApk({ text, packageName: RELEASE }, options.releaseApk);
        report.apkSha256 = report.artifacts.release.installedSha256;
        const installed = text('shell', 'dumpsys', 'package', RELEASE);
        assert.doesNotMatch(installed, /(?:pkgFlags|flags)=\[[^\]]*\bDEBUGGABLE\b/, 'Installed Release is debuggable');
        pass('release-apk'); start(RELEASE);
        report.releaseUi = await until(() => ui(RELEASE, 'release-ready'), 240000); pass('release-ui');
        const releasePid = pid(RELEASE), releasePort = forward(releasePid);
        report.releasePid = releasePid; report.samples = [];
        let started;
        do {
            verifyForward(releasePort);
            assert.equal(text('shell', 'id', '-u'), '2000', 'Shell UID changed during observation');
            const actualPid = pid(RELEASE);
            assert.equal(actualPid, releasePid, 'Release main process restarted');
            let socketVisible = null;
            try { socketVisible = hasExactDevtoolsSocket(text('shell', 'cat', '/proc/net/unix'), actualPid); }
            catch (error) {
                // Modern user images deny shell access. A live, previously calibrated ADB
                // forward plus explicit HTTP connection failure is the alternate probe.
                if (!/Permission denied|Operation not permitted|EACCES/.test(String(error.stderr || error.message))) throw error;
            }
            const response = await probeCdpHttp(releasePort);
            const observedAt = performance.now();
            started ??= observedAt;
            report.samples.push({ elapsedMs: Math.floor(observedAt - started), pid: actualPid, socketVisible, httpReachable: response.reachable });
            assert.equal(socketVisible === true || response.reachable, false, 'Release exposes CDP');
            if (report.samples.at(-1).elapsedMs >= 10000) break;
            await delay(1000);
        } while (true);
        assertCdpObservation(report.positiveControl, report.samples);
        report.releaseUiAfterObservation = await ui(RELEASE, 'release-final');
        assert.equal(pid(RELEASE), releasePid, 'Release process changed after observation');
        pass('release-cdp-disabled');
        assert.deepEqual(await readBuildIdentity(root), identity, 'Source/build identity changed during acceptance'); pass('source-stability');
    } catch (error) {
        report.error = error.message;
        if (launched) {
            try { await fs.writeFile(path.join(evidenceDirectory, 'failure.png'), execute(['exec-out', 'screencap', '-p'], { encoding: null })); }
            catch (captureError) { report.captureError = captureError.message; }
        }
    }
    finally {
        const cleanupErrors = [];
        const clean = action => { try { action(); } catch (error) { cleanupErrors.push(error.message); } };
        if (debugOwned && !debugStopped) clean(() => text('shell', 'am', 'force-stop', DEBUG));
        for (const port of forwards.keys()) clean(() => text('forward', '--remove', 'tcp:' + port));
        if (guarded) clean(() => text('shell', 'rm', '-f', remoteXml));
        if (cleanupErrors.length) report.cleanupError = cleanupErrors.join('\n'); else pass('cleanup');
        report.passed = !report.error && !report.cleanupError && report.checks.every(check => check.passed);
        report.reportPath = await writeAcceptanceReport(root, 'release-user', report);
        console.log(JSON.stringify({ passed: report.passed, report: report.reportPath, error: report.error, cleanupError: report.cleanupError }, null, 2));
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    Promise.resolve().then(() => runAcceptance(parseArgs(process.argv.slice(2))))
        .then(report => { if (!report.passed) process.exitCode = 1; })
        .catch(error => { console.error(error.message); process.exitCode = 1; });
}
