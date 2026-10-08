import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { getSourceHash } from './source-inventory.mjs';
import { releaseVersion } from './release-version.mjs';
const root = path.resolve(import.meta.dirname, '..');
const { versionName: appVersion, versionCode } = releaseVersion();
const server = path.join(root, 'server');
const require = createRequire(path.join(server, 'package.json'));
const archiver = require('archiver');
const webpack = require('webpack');
const sourceHash = await getSourceHash(root);
globalThis.DATA_ROOT = path.join(root, '.local/webpack');
const { default: getConfig } = await import('../server/webpack.config.js');
const config = getConfig();
config.output = { ...config.output, path: server, filename: 'android-lib.js' };
await new Promise((resolve, reject) => {
    const compiler = webpack(config);
    compiler.run((error, stats) => compiler.close(closeError => {
        const failure = error || closeError || (stats?.hasErrors() ? new Error(stats.toString('errors-only')) : null);
        failure ? reject(failure) : resolve();
    }));
});
const plugins = [];
const assetDir = path.join(root, 'android/app/src/main/assets');
await fsp.mkdir(assetDir, { recursive: true });
const archive = archiver('zip', { zlib: { level: 6 } });
const zip = path.join(assetDir, 'runtime.zip');
const pendingZip = zip + '.pending';
const output = fs.createWriteStream(pendingZip);
const done = pipeline(archive, output);
done.catch(() => {}); // Observe I/O failures while the directory traversal is still running.
const excluded = new Set(['data', 'backups', 'uploads', 'test-results', '.git', '.github', '.vscode', 'tests', 'src/electron', 'node_modules/.cache']);
async function add(dir, relative = '') {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const rel = relative ? relative + '/' + entry.name : entry.name;
        if (excluded.has(rel) || ['.git', '.cache', '.bin', '.pnpm', '.pnpm-store', '.idea', '.codegraph'].includes(entry.name)) continue;
        if (rel.startsWith('android/bundled-extensions/') && entry.name === 'node_modules') continue;
        if (/\.(p12|pfx|jks|keystore|dpapi)$/i.test(entry.name) || /^signing-password.*\.txt$/i.test(entry.name) || /^\.env(?:\.|$)/.test(entry.name)) continue;
        if (!relative && ['config.yaml', 'CODEX-BRIDGE.md', 'Start.bat', 'Remote-Link.cmd'].includes(entry.name)) continue;
        if (rel === 'src/codex-bridge.js' || entry.name.endsWith('.map')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await add(full, rel);
        else if (entry.isFile()) archive.file(full, { name: rel });
    }
}
try {
    await add(server);
    await archive.finalize();
    await done;
    if (await getSourceHash(root) !== sourceHash) {
        throw new Error('Source changed while preparing runtime; rebuild after changes finish.');
    }
} catch (error) {
    archive.abort();
    output.destroy();
    await done.catch(() => {});
    await fsp.rm(pendingZip, { force: true });
    throw error;
}
await fsp.rename(pendingZip, zip);
const hash = crypto.createHash('sha256');
for await (const chunk of fs.createReadStream(zip)) hash.update(chunk);
const metadata = { formatVersion: 1, appVersion, versionCode, sillyTavern: '1.19.0', runtimeSha256: hash.digest('hex'), sourceHash, plugins };
await fsp.writeFile(path.join(assetDir, 'runtime.json'), JSON.stringify(metadata, null, 2));
await fsp.writeFile(path.join(root, 'docs/runtime-version.json'), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify({ bytes: (await fsp.stat(zip)).size, ...metadata }, null, 2));
