import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sha256 } from '../server/android/files.js';
import { getSourceHash } from './source-inventory.mjs';

export function parseSigningCertificate(output) {
    const digests = [...String(output).matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([a-f0-9:]+)\s*$/gim)].map(match => match[1].replaceAll(':', '').toLowerCase());
    if (digests.length !== 1 || !/^[a-f0-9]{64}$/.test(digests[0])) throw new Error('Expected exactly one verified APK signing certificate SHA-256');
    return digests[0];
}

export async function verifyApkCertificate(apk, root) {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(root, '.local/android-sdk');
    const versions = (await fs.readdir(path.join(sdk, 'build-tools'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    let jar;
    for (const version of versions) {
        const candidate = path.join(sdk, 'build-tools', version, 'lib/apksigner.jar');
        try { await fs.access(candidate); jar = candidate; break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!jar) throw new Error('Android SDK apksigner.jar is required to verify the release APK');
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
    const output = execFileSync(java, ['-jar', jar, 'verify', '--verbose', '--print-certs', apk], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    return parseSigningCertificate(output);
}

export async function writeChecksums({ root = path.resolve(import.meta.dirname, '..'), verifyApk = verifyApkCertificate } = {}) {
    const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const core = JSON.parse(await fs.readFile(path.join(root, 'server/package.json'), 'utf8'));
    const folder = path.join(root, 'releases');
    const names = [`SillyTavern-Standalone-${version}-release.apk`, `SillyTavern-Android-${version}-source.zip`];
    const debugName = `SillyTavern-Standalone-${version}-debug.apk`;
    try { await fs.access(path.join(folder, debugName)); names.push(debugName); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const files = [];
    for (const name of names) {
        const file = { name, bytes: (await fs.stat(path.join(folder, name))).size, sha256: await sha256(path.join(folder, name)) };
        if (name.endsWith('.apk')) file.signingCertificateSha256 = await verifyApk(path.join(folder, name), root);
        files.push(file);
    }
    const signingCertificateSha256 = files[0].signingCertificateSha256;
    const plugins = JSON.parse(await fs.readFile(path.join(root, 'docs/plugins-lock.json'), 'utf8'));
    const nativeRuntime = JSON.parse(await fs.readFile(path.join(root, 'vendor/runtime/installed.json'), 'utf8'));
    let sourceCommit = null;
    try { sourceCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source ZIP workspaces have no Git metadata. */ }
    const report = { applicationId: 'io.sillytavern.standalone', appVersion: version, sillyTavern: core.version, node: nativeRuntime.version, minAndroid: 10, abis: nativeRuntime.libraries.map(library => library.abi), sourceCommit, sourceHash: await getSourceHash(root), signingCertificateSha256, nativeRuntime, plugins, files };
    await fs.writeFile(path.join(folder, 'versions-and-checksums.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(folder, 'SHA256SUMS.txt'), files.map(file => file.sha256 + '  ' + file.name).join('\n') + '\n');
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(await writeChecksums(), null, 2));
