import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import git from 'isomorphic-git';
import gitHttp from 'isomorphic-git/http/node';
const http = { request: options => gitHttp.request({ ...options, fetchOptions: { ...options.fetchOptions, timeout: 30000, autoSelectFamily: true } }) };
import { inside, atomicJson, replaceDirectory } from './files.js';

const clientVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version.split('.').map(Number);
const locks = new Set();
const metadataName = '.android-origin.json';
export function repositoryUrl(input) {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use a public HTTPS Git repository URL without credentials');
    // GitLab accepts discovery without .git, but rejects the upload-pack POST with 422.
    // Normalize before every Git operation, including origins saved by older APKs.
    if (url.hostname === 'gitlab.com') {
        url.pathname = url.pathname.replace(/\/+$/, '');
        if (!url.pathname.endsWith('.git')) url.pathname += '.git';
    }
    return url.toString().replace(/\/$/, '');
}
export async function validateExtension(folder) {
    const manifest = JSON.parse(await fsp.readFile(path.join(folder, 'manifest.json'), 'utf8'));
    if (!manifest.display_name || !manifest.version) throw new Error('Extension manifest is incomplete');
    const minimum = String(manifest.minimum_client_version || '0').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((minimum[i] || 0) > clientVersion[i]) throw new Error('This extension requires a newer SillyTavern version');
        if ((minimum[i] || 0) < clientVersion[i]) break;
    }
    for (const key of ['js', 'css']) {
        if (manifest[key] && !(await fsp.stat(inside(folder, manifest[key]))).isFile()) throw new Error('Missing extension asset: ' + key);
    }
    async function checkLinks(dir) {
        for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
            if (entry.name === '.git') continue;
            if (entry.isSymbolicLink()) throw new Error('Symbolic links are not supported in Android extensions');
            if (entry.isDirectory()) await checkLinks(path.join(dir, entry.name));
        }
    }
    await checkLinks(folder);
    return manifest;
}
export async function extensionOrigin(folder) {
    if (fs.existsSync(path.join(folder, '.git'))) {
        return {
            url: await git.getConfig({ fs, dir: folder, path: 'remote.origin.url' }),
            branch: await git.currentBranch({ fs, dir: folder }) || 'main',
            commit: await git.resolveRef({ fs, dir: folder, ref: 'HEAD' }),
        };
    }
    return JSON.parse(await fsp.readFile(path.join(folder, metadataName), 'utf8'));
}
export async function installExtension({ url, branch, destination, replacing = false }) {
    url = repositoryUrl(url);
    if (locks.has(destination)) throw Object.assign(new Error('Extension is being updated'), { status: 409 });
    locks.add(destination);
    const stagingParent = path.join(path.dirname(path.dirname(destination)), '.extension-staging');
    await fsp.mkdir(stagingParent, { recursive: true });
    const stage = path.join(stagingParent, crypto.randomUUID());
    try {
        if (!replacing && fs.existsSync(destination)) throw Object.assign(new Error('Extension already exists'), { status: 409 });
        if (replacing && fs.existsSync(path.join(destination, '.git'))) {
            const matrix = await git.statusMatrix({ fs, dir: destination });
            if (matrix.some(([name, head, work, index]) => name !== metadataName && (head !== work || work !== index))) throw Object.assign(new Error('Extension has local changes; export them before updating'), { status: 409 });
        }
        await git.clone({ fs, http, dir: stage, url, ref: branch || undefined, singleBranch: true, depth: 1 });
        const manifest = await validateExtension(stage);
        const origin = { url, branch: await git.currentBranch({ fs, dir: stage }), commit: await git.resolveRef({ fs, dir: stage, ref: 'HEAD' }) };
        await atomicJson(path.join(stage, metadataName), origin);
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        // Backups live outside the discovery directory and survive until explicitly cleaned up.
        const backupRoot = path.join(path.dirname(path.dirname(destination)), '.extension-backups');
        await fsp.mkdir(backupRoot, { recursive: true });
        let backup = null;
        if (fs.existsSync(destination)) {
            backup = path.join(backupRoot, path.basename(destination) + '-' + Date.now());
            await fsp.rename(destination, backup);
        }
        try { await fsp.rename(stage, destination); }
        catch (error) { if (backup) await fsp.rename(backup, destination); throw error; }
        return { manifest, origin };
    } finally {
        locks.delete(destination);
        await fsp.rm(stage, { recursive: true, force: true });
    }
}
export function createAndroidExtensionRouter(globalDirectory) {
    const router = express.Router();
    const destination = req => {
        if (req.body.global && !req.user.profile.admin) throw Object.assign(new Error('Administrator permission required'), { status: 403 });
        const base = req.body.global ? globalDirectory : req.user.directories.extensions;
        const name = typeof req.body.extensionName === 'string' ? req.body.extensionName.replace(/^third-party\//, '').replace(/^\/(?!\/)/, '') : req.body.extensionName;
        if (typeof name !== 'string' || name.includes('/') || name.startsWith('.')) throw Object.assign(new Error('Invalid extension name'), { status: 400 });
        return inside(base, name);
    };
    const route = (name, handler) => router.post(name, async (req, res) => {
        try { await handler(req, res); }
        catch (error) { res.status(error.status || 400).send(error.message); }
    });
    route('/install', async (req, res) => {
        const url = repositoryUrl(req.body.url);
        const name = decodeURIComponent(new URL(url).pathname.split('/').pop()).replace(/\.git$/, '');
        req.body.extensionName = name;
        const folder = destination(req);
        const { manifest } = await installExtension({ url, branch: req.body.branch, destination: folder });
        const { version, author, display_name } = manifest;
        res.json({ version, author, display_name, extensionPath: folder });
    });
    route('/version', async (req, res) => {
        const folder = destination(req);
        if (!fs.existsSync(folder)) return res.sendStatus(404);
        let origin;
        try { origin = await extensionOrigin(folder); }
        catch { return res.json({ currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' }); }
        const refs = await git.listServerRefs({ http, url: repositoryUrl(origin.url), prefix: 'refs/heads/' });
        const remote = refs.find(r => r.ref === 'refs/heads/' + origin.branch);
        res.json({ currentBranchName: origin.branch, currentCommitHash: origin.commit, isUpToDate: remote?.oid === origin.commit, remoteUrl: origin.url });
    });
    route('/update', async (req, res) => {
        const folder = destination(req);
        const previous = await extensionOrigin(folder);
        const { origin } = await installExtension({ url: previous.url, branch: previous.branch, destination: folder, replacing: true });
        res.json({ shortCommitHash: origin.commit.slice(0, 7), extensionPath: folder, isUpToDate: previous.commit === origin.commit, remoteUrl: origin.url });
    });
    route('/branches', async (req, res) => {
        const origin = await extensionOrigin(destination(req));
        const refs = await git.listServerRefs({ http, url: repositoryUrl(origin.url), prefix: 'refs/heads/' });
        res.json(refs.map(r => ({ current: r.ref === 'refs/heads/' + origin.branch, commit: r.oid.slice(0, 7), name: 'origin/' + r.ref.slice(11), label: r.ref.slice(11) })));
    });
    route('/switch', async (req, res) => {
        const folder = destination(req);
        const previous = await extensionOrigin(folder);
        const branch = String(req.body.branch || '').replace(/^origin\//, '');
        if (!branch) return res.sendStatus(400);
        await installExtension({ url: previous.url, branch, destination: folder, replacing: true });
        res.sendStatus(204);
    });
    return router;
}
