import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const requestLimit = 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function buildNativeProbe({ root, abi, env = process.env }) {
    const target = { 'x86_64': 'x86_64-linux-android29', 'arm64-v8a': 'aarch64-linux-android29' }[abi];
    if (!target) throw new Error('Unsupported native probe ABI');
    const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || path.join(root, '.local/android-sdk');
    const host = { win32: 'windows-x86_64', linux: 'linux-x86_64', darwin: 'darwin-x86_64' }[process.platform];
    if (!host) throw new Error('Unsupported NDK host');
    const toolchain = path.join(sdk, 'ndk/28.2.13676358/toolchains/llvm/prebuilt', host);
    const compiler = path.join(toolchain, 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang');
    const source = path.join(root, 'scripts/native/unix-http-probe.c');
    const directory = path.join(root, '.local/native-test-tools');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${abi}-${sha256(fs.readFileSync(source))}.bin`);
    if (!fs.existsSync(file)) {
        const pending = file + '.' + crypto.randomUUID() + '.pending';
        try {
            execFileSync(compiler, [`--target=${target}`, '--sysroot=' + path.join(toolchain, 'sysroot'), '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIE', '-pie', '-Wl,-z,relro,-z,now', '-o', pending, source], { windowsHide: true, timeout: 60000, stdio: 'pipe' });
            fs.renameSync(pending, file);
        } finally { fs.rmSync(pending, { force: true }); }
    }
    return { file, sha256: sha256(fs.readFileSync(file)) };
}

/** One owned helper directory; credentials travel only through stdin, never argv. */
export function createNativeClient({ root, packageName, execute, uid, env = process.env, build = buildNativeProbe }) {
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) throw new Error('Invalid probe package');
    if (uid !== undefined && (!Number.isSafeInteger(uid) || uid < 10000)) throw new Error('Native probe requires an app UID');
    if (uid === undefined && !packageName.endsWith('.debug')) throw new Error('run-as native probes require a debug package');
    const identity = uid === undefined ? ['run-as', packageName] : ['su', String(uid)];
    const runId = crypto.randomUUID();
    const directory = `/data/user/0/${packageName}/files/st-acceptance-probe-${runId}`;
    const executable = directory + '/unix-http-probe';
    const temporary = '/data/local/tmp/st-native-probe-' + runId;
    const socket = `/data/user/0/${packageName}/files/tavern/runtime.sock`;
    const text = args => String(execute(args)).trim();
    let prepared;
    let created = false;
    const close = () => {
        if (!created) return;
        try {
            text(['exec-out', ...identity, 'rm', '-f', executable]);
            text(['exec-out', ...identity, 'rmdir', directory]);
        } finally { created = false; prepared = undefined; }
    };
    const check = () => {
        if (prepared) return prepared;
        const actualUid = Number(text(['exec-out', ...identity, 'id', '-u']));
        if (!Number.isSafeInteger(actualUid) || actualUid < 10000 || (uid !== undefined && uid !== actualUid)) throw new Error('Native probe UID mismatch');
        const abi = text(['shell', 'getprop', 'ro.product.cpu.abi']);
        const binary = build({ root, abi, env });
        try {
            text(['push', binary.file, temporary]);
            text(['shell', 'chmod', '444', temporary]);
            text(['exec-out', ...identity, 'mkdir', '-m', '700', directory]);
            created = true;
            text(['exec-out', ...identity, 'cp', temporary, executable]);
            text(['exec-out', ...identity, 'chmod', '500', executable]);
            if (text(['exec-out', ...identity, 'sha256sum', executable]).split(/\s+/)[0] !== binary.sha256) throw new Error('Staged native probe SHA mismatch');
            if (text(['exec-out', ...identity, executable, '--check']) !== `unix-http-probe-v1 uid=${actualUid}`) throw new Error('Native helper execution or UID mismatch');
            prepared = { uid: actualUid, abi, transport: 'same-UID Unix socket; base64 ADB stdin/stdout' };
            return prepared;
        } catch (error) {
            try { close(); } catch { /* Preserve the original preparation failure. */ }
            throw error;
        } finally {
            text(['shell', 'rm', '-f', temporary]);
        }
    };
    return {
        check, close,
        request(input, { responseTimeoutMs = 30000 } = {}) {
            const request = Buffer.isBuffer(input) ? input : Buffer.from(input);
            if (request.length === 0 || request.length > requestLimit) throw new Error('Native request size must be between 1 byte and 1 MiB');
            if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 100 || responseTimeoutMs > 600000) throw new Error('Invalid native response timeout');
            check();
            // Windows adb shell performs text conversion; exec-out does not send
            // stdin. Base64 both directions preserves CRLF, UTF-8, NUL and Ctrl-Z.
            const command = `set -o pipefail; /system/bin/toybox base64 -d | ${executable} ${socket} ${responseTimeoutMs} | /system/bin/toybox base64`;
            const output = execute(['shell', '-T', ...identity, 'sh', '-c', `'${command}'`], {
                input: request.toString('base64') + '\n', encoding: null,
                timeout: responseTimeoutMs + 15000, maxBuffer: 16 * 1024 ** 2,
            });
            const encoded = Buffer.from(output).toString('ascii').replace(/[\r\n]/g, '');
            if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4) throw new Error('Invalid base64 native transport response');
            const decoded = Buffer.from(encoded, 'base64');
            if (decoded.toString('base64') !== encoded) throw new Error('Corrupt base64 native transport response');
            return decoded;
        },
    };
}
