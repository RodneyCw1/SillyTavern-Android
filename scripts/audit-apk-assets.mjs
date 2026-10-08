import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getSourceHash } from './source-inventory.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const yauzl = createRequire(path.join(projectRoot, 'server/package.json'))('yauzl');
const execute = promisify(execFile);
const abiMachines = new Map([['arm64-v8a', 183], ['x86_64', 62]]);
const shaPattern = /^[a-f0-9]{64}$/;
const maximumJsonBytes = 1024 * 1024;

function requireCondition(condition, message) {
    if (!condition) throw new Error(message);
}

// Check names before opening entries. No signing or personal-data bytes are read.
export function validateArchivePath(name, kind) {
    requireCondition(typeof name === 'string' && name.length > 0 && name.length <= 4096, 'Invalid archive path');
    const relative = name.endsWith('/') ? name.slice(0, -1) : name;
    requireCondition(!/[\\:\x00-\x1f\x7f]/.test(relative) && !relative.startsWith('/'), 'Forbidden absolute or invalid archive path');
    const parts = relative.toLowerCase().split('/');
    requireCondition(parts.every(part => part && part !== '.' && part !== '..'), 'Forbidden archive traversal path');
    requireCondition(!parts.some(part => /\.(?:p12|pfx|jks|keystore|dpapi)$/.test(part)
        || /^signing-password/.test(part) || /^\.env(?:\.|$)/.test(part)
        || ['.local', '.git', '.aws', '.ssh', 'users', 'home', 'host-token'].includes(part)), 'Forbidden sensitive or private archive path');
    const normalized = parts.join('/');
    const runtimeName = kind === 'apk' ? normalized.replace(/^assets\//, '') : normalized;
    requireCondition(!/^(?:data|backups|uploads|test-results)(?:\/|$)/.test(runtimeName)
        && runtimeName !== 'config.yaml', 'Forbidden private runtime path');
    requireCondition(!/^android\/bundled-extensions\/[^/]+\/(?:.*\/)?node_modules(?:\/|$)/.test(runtimeName), 'Forbidden nested plugin node_modules');
    return relative;
}

async function visitZip(file, kind, visit) {
    const archive = await new Promise((resolve, reject) => yauzl.open(file, {
        lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true,
    }, (error, zip) => error ? reject(error) : resolve(zip)));
    try {
        await new Promise((resolve, reject) => {
            const names = new Set();
            let totalBytes = 0;
            let stopped = false;
            const fail = error => { if (!stopped) { stopped = true; reject(error); } };
            archive.on('error', fail);
            archive.on('end', () => { stopped = true; resolve(); });
            archive.on('entry', entry => {
                Promise.resolve().then(async () => {
                    const name = validateArchivePath(entry.fileName, kind);
                    const identity = name.toLowerCase();
                    requireCondition(!names.has(identity), 'Duplicate archive entry: ' + name);
                    names.add(identity);
                    requireCondition(names.size <= 1000000, 'Archive entry count exceeds audit limit');
                    requireCondition(!entry.isEncrypted(), 'Encrypted archive entries cannot be audited');
                    requireCondition(((entry.externalFileAttributes >>> 16) & 0xf000) !== 0xa000, 'Archive symlinks cannot be audited');
                    totalBytes += entry.uncompressedSize;
                    requireCondition(Number.isSafeInteger(totalBytes) && totalBytes <= 10 * 1024 ** 3, 'Archive exceeds audit size limit');
                    if (!entry.fileName.endsWith('/')) await visit(entry, archive);
                    if (!stopped) archive.readEntry();
                }).catch(fail);
            });
            archive.readEntry();
        });
    } finally {
        archive.close();
    }
}

function entryStream(archive, entry) {
    return new Promise((resolve, reject) => archive.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        // yauzl's stored-entry stream marks itself destroyed before emitting end;
        // a standard stream boundary keeps Node 24 async iteration from hanging.
        const output = new PassThrough();
        stream.on('error', failure => output.destroy(failure));
        output.once('close', () => { if (!stream.destroyed) stream.destroy(); });
        stream.pipe(output);
        resolve(output);
    }));
}

async function jsonEntry(archive, entry, stats) {
    requireCondition(entry.uncompressedSize <= maximumJsonBytes, 'Archive JSON exceeds audit size limit');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of await entryStream(archive, entry)) {
        bytes += chunk.length;
        stats.maxChunkBytes = Math.max(stats.maxChunkBytes, chunk.length);
        requireCondition(bytes <= maximumJsonBytes, 'Archive JSON exceeds audit size limit');
        chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);
    return { value: JSON.parse(content.toString('utf8')), sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

async function copyEntry(archive, entry, destination, stats, maxBytes) {
    requireCondition(entry.uncompressedSize <= maxBytes, 'Archive resource exceeds audit size limit');
    const hash = crypto.createHash('sha256');
    const header = Buffer.alloc(20);
    let headerBytes = 0;
    let bytes = 0;
    const meter = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) return callback(new Error('Archive resource exceeds audit size limit'));
        stats.maxChunkBytes = Math.max(stats.maxChunkBytes, chunk.length);
        hash.update(chunk);
        const copied = chunk.copy(header, headerBytes, 0, Math.min(chunk.length, header.length - headerBytes));
        headerBytes += copied;
        callback(null, chunk);
    } });
    await pipeline(await entryStream(archive, entry), meter, createWriteStream(destination, { flags: 'wx' }));
    requireCondition(bytes === entry.uncompressedSize, 'Archive resource byte count mismatch');
    return { bytes, sha256: hash.digest('hex'), header };
}

async function inspectNative(file, name, digest, installed, llvmReadelf) {
    const [, abi, library] = name.split('/');
    requireCondition(abiMachines.has(abi), 'Unexpected native ABI: ' + abi);
    requireCondition(digest.header.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]))
        && digest.header.readUInt16LE(18) === abiMachines.get(abi), 'ELF ABI mismatch: ' + name);
    if (library === 'libnode.so') {
        const expected = installed.libraries.find(record => record.abi === abi);
        requireCondition(expected && shaPattern.test(expected.sha256) && digest.sha256 === expected.sha256, 'libnode SHA-256 mismatch: ' + abi);
    }
    const { stdout } = await execute(llvmReadelf, ['--program-headers', '--wide', file], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    const loadAlignments = stdout.split(/\r?\n/).filter(line => /^\s*LOAD\s/.test(line)).map(line => {
        const last = line.trim().split(/\s+/).at(-1);
        requireCondition(/^0x[\da-f]+$/i.test(last), 'Cannot parse LLVM LOAD alignment: ' + name);
        return Number.parseInt(last, 16);
    });
    requireCondition(loadAlignments.length > 0 && loadAlignments.every(value => value >= 0x4000), 'ELF LOAD alignment is below 16 KB: ' + name);
    return { path: name, abi, bytes: digest.bytes, sha256: digest.sha256, loadAlignments };
}

/** Streams large resources to private scratch files; only bounded JSON is buffered. */
export async function auditApkAssets(apkPath, options = {}) {
    const root = path.resolve(options.root || projectRoot);
    const readJson = async relative => JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
    const expectedBytes = options.expected ? null : await fs.readFile(path.join(root, 'android/app/src/main/assets/runtime.json'));
    const expected = options.expected || JSON.parse(expectedBytes.toString('utf8'));
    const expectedMetadataSha256 = options.expectedMetadataSha256 || (expectedBytes && crypto.createHash('sha256').update(expectedBytes).digest('hex'));
    const installed = options.installed || await readJson('vendor/runtime/installed.json');
    const appVersion = options.appVersion || expected.appVersion;
    const sourceHash = options.sourceHash || await getSourceHash(root);
    const llvmReadelf = options.llvmReadelf || path.join(root, '.local/android-sdk/ndk/28.2.13676358/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-readelf.exe');
    requireCondition(Array.isArray(installed.libraries), 'Missing installed native library checksums');
    requireCondition(shaPattern.test(sourceHash), 'Invalid expected source identity');
    const workRoot = path.resolve(options.workRoot || path.join(root, '.local'));
    await fs.mkdir(workRoot, { recursive: true });
    const scratch = await fs.mkdtemp(path.join(workRoot, 'apk-assets-audit-'));
    const streamStats = { maxChunkBytes: 0 };
    let metadata;
    let metadataSha256;
    let runtime;
    let runtimeEntries = 0;
    let multer;
    let serverPackage;
    const manifests = new Map();
    const nativeLibraries = [];
    try {
        await visitZip(apkPath, 'apk', async (entry, archive) => {
            const name = entry.fileName;
            if (name === 'assets/runtime.json') {
                const resource = await jsonEntry(archive, entry, streamStats);
                metadata = resource.value;
                metadataSha256 = resource.sha256;
            }
            else if (name === 'assets/runtime.zip') runtime = await copyEntry(archive, entry, path.join(scratch, 'runtime.zip'), streamStats, 1024 ** 3);
            else if (/^lib\/[^/]+\/[^/]+\.so$/.test(name)) {
                const destination = path.join(scratch, 'native-' + nativeLibraries.length + '.so');
                const digest = await copyEntry(archive, entry, destination, streamStats, 512 * 1024 ** 2);
                nativeLibraries.push(await inspectNative(destination, name, digest, installed, llvmReadelf));
            }
        });
        requireCondition(metadata && runtime, 'Missing APK runtime assets');
        requireCondition(!expectedMetadataSha256 || metadataSha256 === expectedMetadataSha256, 'APK runtime metadata hash mismatch');
        requireCondition(metadata.formatVersion === 1 && metadata.appVersion === appVersion, 'APK runtime metadata app version mismatch');
        for (const field of ['formatVersion', 'appVersion', 'sillyTavern', 'sourceHash', 'runtimeSha256', 'plugins']) {
            requireCondition(isDeepStrictEqual(metadata[field], expected[field]), 'APK runtime metadata identity mismatch: ' + field);
        }
        requireCondition(metadata.sourceHash === sourceHash, 'APK runtime source identity is stale');
        requireCondition(shaPattern.test(metadata.runtimeSha256) && metadata.runtimeSha256 === runtime.sha256, 'APK runtime hash mismatch');
        requireCondition(Array.isArray(metadata.plugins), 'Missing bundled plugin metadata');
        for (const abi of abiMachines.keys()) {
            for (const name of ['libnode.so', 'libtavern_node.so']) {
                requireCondition(nativeLibraries.some(record => record.path === `lib/${abi}/${name}`), 'Missing native ABI library: ' + abi + '/' + name);
            }
        }
        await visitZip(path.join(scratch, 'runtime.zip'), 'runtime', async (entry, archive) => {
            runtimeEntries++;
            if (options.forbidPreinstalled) {
                requireCondition(!entry.fileName.startsWith('android/bundled-extensions/'), 'Third-party preinstalled extensions are forbidden');
                if (entry.fileName === 'default/content/index.json') {
                    const index = (await jsonEntry(archive, entry, streamStats)).value;
                    requireCondition(Array.isArray(index) && !index.some(item => ['character', 'world', 'sprites'].includes(item.type)), 'Preinstalled characters or worlds are forbidden');
                }
            }
            if (entry.fileName === 'package.json') serverPackage = (await jsonEntry(archive, entry, streamStats)).value;
            else if (entry.fileName === 'node_modules/multer/package.json') multer = (await jsonEntry(archive, entry, streamStats)).value;
            else {
                const match = /^android\/bundled-extensions\/([^/]+)\/manifest\.json$/.exec(entry.fileName);
                if (match) manifests.set(match[1], (await jsonEntry(archive, entry, streamStats)).value);
            }
        });
        requireCondition(multer?.name === 'multer' && multer.version === '2.3.0', 'Runtime Multer must be 2.3.0');
        requireCondition(serverPackage?.version === metadata.sillyTavern, 'Runtime server version mismatch');
        requireCondition(manifests.size === metadata.plugins.length, 'Bundled plugin manifest count mismatch');
        for (const plugin of metadata.plugins) {
            const manifest = manifests.get(plugin.name);
            requireCondition(manifest && manifest.version === plugin.version && (manifest.androidPatchRevision || 0) === plugin.androidPatchRevision, 'Bundled plugin metadata mismatch: ' + plugin.name);
        }
        return {
            passed: true, testedAt: new Date().toISOString(), appVersion, sourceHash,
            metadataSha256, runtimeSha256: runtime.sha256, runtimeBytes: runtime.bytes, runtimeEntries,
            multerVersion: multer.version, plugins: metadata.plugins, nativeLibraries, streamStats,
            nativeAlignmentTool: 'llvm-readelf --program-headers --wide',
        };
    } finally {
        // The only recursive deletion is the unique directory this invocation created.
        await fs.rm(scratch, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        requireCondition(process.argv[2], 'Usage: node scripts/audit-apk-assets.mjs <apk> [report.json]');
        const report = await auditApkAssets(path.resolve(process.argv[2]), { forbidPreinstalled: true });
        const output = JSON.stringify(report, null, 2) + '\n';
        if (process.argv[3]) await fs.writeFile(path.resolve(process.argv[3]), output);
        console.log(output.trimEnd());
    } catch (error) {
        console.error('APK asset audit failed: ' + error.message);
        process.exitCode = 1;
    }
}
