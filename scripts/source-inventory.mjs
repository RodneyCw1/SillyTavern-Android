import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const excludedDirectories = new Set(['.git', '.local', '.codegraph', '.idea', '.pnpm-store', 'node_modules', '.gradle', '.kotlin', '.cxx', '.cache', 'test-results', 'playwright-report', '__pycache__', '.pytest_cache', 'coverage']);

export function excludedSourcePath(relative) {
    const parts = relative.replaceAll('\\', '/').toLowerCase().split('/');
    const name = parts.at(-1);
    const normalized = parts.join('/');
    return parts.some(part => excludedDirectories.has(part))
        || parts[0] === 'releases'
        || parts[0] === 'compatibility' || parts[0] === 'sillytavern-android-signing'
        || /^(?:private-migration-inventory\.json|readme-migration\.txt)$/.test(normalized)
        || /^vendor\/runtime(?:\/|$)/.test(normalized)
        || /^android\/app\/src\/main\/(?:jnilibs|cpp\/node-include)(?:\/|$)/.test(normalized)
        || parts[0] === 'data'
        || /^server\/(?:data|backups|uploads|cache)(?:\/|$)/.test(normalized)
        || /^vendor\/(?:downloads|nodejs-mobile)(?:\/|$)/.test(normalized)
        || /^android\/(?:.*\/)?build(?:\/|$)/.test(normalized)
        || /^(?:server\/config\.yaml|android\/local\.properties|server\/android-lib\.js(?:\.license\.txt)?|android\/app\/src\/main\/assets\/runtime\.zip(?:\.pending)?)$/.test(normalized)
        || /\.(?:p12|pfx|jks|keystore|dpapi|log)$/i.test(name)
        || /^signing-password.*\.txt$/i.test(name)
        || name === 'google cloud api key.txt'
        || name === '.env' || name.startsWith('.env.');
}

export async function collectSourceFiles(root) {
    const files = [];
    async function walk(relative = '') {
        for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
            const rel = relative ? relative + '/' + entry.name : entry.name;
            // Check names before opening files: signing material is never read.
            if (excludedSourcePath(rel) || entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) await walk(rel);
            else if (entry.isFile()) files.push(rel);
        }
    }
    await walk();
    return files.sort();
}

export async function hashSourceFile(file) {
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
    return { size, sha256: hash.digest('hex') };
}

export async function getSourceHash(root, files = undefined) {
    const hash = crypto.createHash('sha256');
    for (const relative of files || await collectSourceFiles(root)) {
        // Evidence and generated runtime identity bind separately, avoiding self-reference.
        if (relative.startsWith('docs/') || relative === 'android/app/src/main/assets/runtime.json') continue;
        const digest = await hashSourceFile(path.join(root, relative));
        hash.update(relative + '\0' + digest.sha256 + '\n');
    }
    return hash.digest('hex');
}
