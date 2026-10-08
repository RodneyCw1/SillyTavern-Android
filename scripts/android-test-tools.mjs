import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getSourceHash, hashSourceFile } from './source-inventory.mjs';
import { createNativeClient } from './android-native-client.mjs';

export function selectAndroidDevice(output, { serial, env = process.env } = {}) {
    const devices = String(output).split(/\r?\n/).map(line => line.trim().split(/\s+/))
        .filter(parts => parts.length >= 2 && !['List', '*', 'adb'].includes(parts[0]));
    const requested = serial || env.ANDROID_SERIAL || env.ST_TEST_DEVICE;
    if (requested) {
        const found = devices.find(([id]) => id === requested);
        if (!found || found[1] !== 'device') throw new Error(`Device ${requested} is not online (${found?.[1] || 'missing'})`);
        return requested;
    }
    const online = devices.filter(([, state]) => state === 'device');
    if (online.length !== 1) throw new Error(online.length ? 'Multiple online devices: supply --serial or ANDROID_SERIAL.' : 'No online Android device.');
    return online[0][0];
}

export function parseNativeResponse(output) {
    const raw = Buffer.isBuffer(output) ? output : Buffer.from(output);
    const boundary = raw.indexOf('\r\n\r\n');
    if (boundary < 0) throw new Error('Incomplete native HTTP response');
    const headers = raw.subarray(0, boundary).toString('ascii');
    const status = Number(headers.match(/^HTTP\/1\.[01] (\d{3})\b/)?.[1]);
    if (status !== 200) throw new Error(`Native HTTP status ${status || 'invalid'}`);
    if (/\r\ntransfer-encoding:/i.test(headers)) throw new Error('Unexpected HTTP transfer encoding; use HTTP/1.0 close');
    const body = raw.subarray(boundary + 4);
    const length = headers.match(/\r\ncontent-length:\s*(\d+)/i)?.[1];
    if (length !== undefined && body.length !== Number(length)) throw new Error('Incomplete native HTTP body');
    return JSON.parse(body.toString('utf8'));
}

function findAdb(root, env) {
    if (env.ST_ANDROID_ADB) return env.ST_ANDROID_ADB;
    const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
    for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, path.join(root, '.local/android-sdk')].filter(Boolean)) {
        const candidate = path.join(sdk, 'platform-tools', executable);
        if (fs.existsSync(candidate)) return candidate;
    }
    return executable;
}

export function createAndroidDevice({ root = path.resolve(import.meta.dirname, '..'), serial, packageName, env = process.env, run = execFileSync, nativeClientFactory = createNativeClient } = {}) {
    const pkg = packageName || env.ST_TEST_PACKAGE || 'io.sillytavern.standalone.debug';
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+\.debug$/.test(pkg)) throw new Error('Private acceptance probes require a debug package.');
    const adb = findAdb(root, env);
    const selected = selectAndroidDevice(run(adb, ['devices', '-l'], { encoding: 'utf8', timeout: 10000 }), { serial, env });
    const mappings = [];
    const execute = (args, options = {}) => run(adb, ['-s', selected, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, ...options });
    const text = (...args) => String(execute(args)).trim();
    const nativeClient = nativeClientFactory({ root, packageName: pkg, execute, env });
    const readPrivate = relative => {
        if (!/^[a-zA-Z0-9_.\/-]+$/.test(relative) || relative.split('/').some(part => !part || part === '..' || part === '.') || relative.startsWith('/')) throw new Error('Invalid private relative path');
        return text('exec-out', 'run-as', pkg, 'cat', 'files/tavern/' + relative);
    };
    const allocate = (kind, remote) => {
        if (!/^(?:tcp:\d+|localabstract:[\w.-]+)$/.test(remote)) throw new Error('Invalid forward endpoint');
        const output = text(kind, 'tcp:0', remote);
        const port = Number(output);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`ADB did not return an allocated ${kind} port`);
        mappings.push([kind, `tcp:${port}`]);
        return port;
    };
    return {
        serial: selected, packageName: pkg, text,
        bytes: (...args) => execute(args, { encoding: null }),
        readPrivate,
        start: () => text('shell', 'am', 'start', '-W', '-n', `${pkg}/io.sillytavern.standalone.MainActivity`),
        forward: remote => allocate('forward', remote),
        reverse: hostPort => allocate('reverse', `tcp:${hostPort}`),
        checkNativeClient: () => nativeClient.check(),
        nativeStatus: () => {
            // RuntimeFiles.rotateToken replaces host-token every Node start.
            const token = readPrivate('host-token');
            if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Native token is not ready');
            const request = `GET /api/android/native/status HTTP/1.0\r\nHost: 127.0.0.1:17614\r\nx-android-host: ${token}\r\nConnection: close\r\n\r\n`;
            return parseNativeResponse(nativeClient.request(request));
        },
        close: () => {
            try { nativeClient.close(); } catch { /* Device may already be disconnected. */ }
            for (const [kind, local] of mappings.splice(0).reverse()) {
                try { text(kind, '--remove', local); } catch { /* Disconnected device; never remove another session's mappings. */ }
            }
        },
    };
}

export async function readBuildIdentity(root) {
    const read = async relative => JSON.parse(await fsp.readFile(path.join(root, relative), 'utf8'));
    const [app, core, node, runtime] = await Promise.all([read('package.json'), read('server/package.json'), read('docs/node-source.json'), read('android/app/src/main/assets/runtime.json')]);
    const sourceHash = await getSourceHash(root);
    if (runtime.appVersion !== app.version || runtime.sourceHash !== sourceHash || !/^[a-f0-9]{64}$/.test(runtime.runtimeSha256 || '')) throw new Error('Embedded runtime identity is missing or stale; rebuild the APK.');
    return { appVersion: app.version, coreVersion: core.version, nodeVersion: 'v' + node.version.replace(/^v/, ''), sourceHash, runtimeSha256: runtime.runtimeSha256 };
}

export async function verifyInstalledApk(device, apkPath) {
    const local = await hashSourceFile(apkPath);
    const installed = device.text('shell', 'pm', 'path', device.packageName).split(/\r?\n/).map(line => line.replace(/^package:/, ''));
    if (installed.length !== 1 || !/^\/data\/app\/[A-Za-z0-9_./=+~-]+\.apk$/.test(installed[0])) throw new Error('Expected one installed base APK for this test package');
    const remote = device.text('shell', 'sha256sum', installed[0]).split(/\s+/)[0];
    if (remote !== local.sha256) throw new Error('Installed APK differs from the requested test artifact.');
    return local.sha256;
}

export async function writeAcceptanceReport(root, suite, report) {
    if (typeof report.passed !== 'boolean') throw new Error('Acceptance report must explicitly set passed');
    if (!/^[a-z0-9-]+$/.test(suite)) throw new Error('Invalid acceptance suite name');
    const testedAt = new Date().toISOString();
    const safe = value => String(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const filename = `${suite}-${safe(report.appVersion)}-${safe(report.device)}-${testedAt.replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.json`;
    const destination = path.join(root, 'docs/acceptance', filename);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, JSON.stringify({ ...report, suite, testedAt }, null, 2), { flag: 'wx' });
    return destination;
}

export async function until(check, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try { const value = await check(); if (value) return value; } catch (error) { last = error; }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw last || new Error('Android acceptance check timed out');
}
