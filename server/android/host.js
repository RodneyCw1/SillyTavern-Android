import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { JobStore } from './jobs.js';
import { importMigration } from './migration.js';
import { localDreamRequest } from './localdream.js';

export const androidEnabled = process.env.ST_ANDROID === '1';
let jobs, migrating = false, restartRequired = false;
const pendingWrites = new Set();
function pendingWriteCount() {
    // Generation handlers can replace socket close listeners, preventing a
    // ServerResponse close event. Disconnected requests cannot remain barriers.
    for (const entry of pendingWrites) if (entry.socket.destroyed) pendingWrites.delete(entry);
    return pendingWrites.size;
}
const activeImports = new Set();
function tokenMatches(candidate) {
    const expected = process.env.ST_ANDROID_TOKEN || '';
    return typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate) && candidate.length === expected.length && expected.length === 64 && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}
export function androidAuth(req, res, next) {
    if (!androidEnabled) return next();
    const cookie = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('st_android_auth='))?.slice(16);
    if (!tokenMatches(req.headers['x-android-host']) && !tokenMatches(cookie)) return res.status(403).send('Open this service through the Android application.');
    if ((migrating || restartRequired) && !req.path.startsWith('/api/android/native/')) return res.status(503).json({ error: 'Data import in progress. Restart the application after import.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.path.startsWith('/api/android/native/')) {
        const entry = { socket: req.socket };
        pendingWrites.add(entry);
        const finish = () => pendingWrites.delete(entry);
        res.once('finish', finish); res.once('close', finish);
    }
    next();
}
export async function installAndroidNative(app) {
    if (!androidEnabled) return;
    const home = process.env.ST_ANDROID_HOME;
    jobs = new JobStore(path.join(home, 'generation-results'), Number(process.env.ST_ANDROID_PORT || 17614));
    await jobs.initialize();
    const router = express.Router();
    router.use((req, res, next) => tokenMatches(req.headers['x-android-host']) ? next() : res.sendStatus(403));
    router.get('/status', (_req, res) => res.json({ ready: !migrating && !restartRequired, migrating, restartRequired, active: jobs.activeCount(), pendingSaves: pendingWriteCount(), memory: { ...process.memoryUsage(), cachedJobs: jobs.jobs.size, pendingWrites: jobs.writes.size, workers: jobs.workers.size }, results: [...jobs.recent.values()] }));
    router.post('/import', async (req, res) => {
        const id = req.body?.id;
        if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return res.status(400).json({ error: 'Invalid import operation ID' });
        // A duplicate request cannot remove a file owned by the active request.
        if (activeImports.has(id)) return res.status(409).json({ error: 'This import is already active' });
        activeImports.add(id);
        const input = path.join(home, 'imports', id + '.zip');
        let ownsMigration = false, status = 200, result;
        try {
            if (migrating || restartRequired || jobs.activeCount() || pendingWriteCount()) {
                status = 409;
                throw new Error('Wait for current generation, data saves or import to finish.');
            }
            migrating = ownsMigration = true;
            const stat = await fsp.lstat(input);
            if (!stat.isFile() || stat.size > 4 * 1024 ** 3) throw new Error('Invalid or oversized import file');
            result = await importMigration(input, globalThis.DATA_ROOT);
            restartRequired = true;
        } catch (error) { status = status === 409 ? 409 : 400; result = { error: error.message }; }
        finally {
            try { await fsp.rm(input, { force: true }); }
            catch (error) { console.warn('Unable to clean import operation file:', id, error.message); }
            if (ownsMigration) migrating = false;
            activeImports.delete(id);
        }
        res.status(status).json(result);
    });
    app.use('/api/android/native', router);
}
export function installAndroidRoutes(app) {
    if (!androidEnabled) return;
    const router = express.Router();
    router.get('/localdream/health', localDreamRequest);
    router.post('/localdream/generate', localDreamRequest);
    router.get('/jobs/page', async (req, res, next) => {
        try { res.json(await jobs.list(req.user.profile.handle, { limit: req.query.limit, before: String(req.query.before || '') })); } catch (error) { next(error); }
    });
    router.get('/jobs', async (req, res, next) => {
        try { res.json((await jobs.list(req.user.profile.handle, { limit: 50 })).items); } catch (error) { next(error); }
    });
    router.post('/jobs', async (req, res) => {
        try {
            const { id, endpoint, body, context } = req.body;
            const contextBytes = JSON.stringify(context || {});
            if (contextBytes.length > 65536) throw new Error('Generation context is too large');
            const job = await jobs.create({ id, endpoint, body, context, owner: req.user.profile.handle, cookie: req.headers.cookie, csrf: req.headers['x-csrf-token'] });
            res.status(202).json(jobs.public(job));
        } catch (error) { res.status(400).json({ error: error.message }); }
    });
    router.use('/jobs/:id', async (req, res, next) => {
        try {
            const job = await jobs.get(req.params.id);
            if (!job || job.owner !== req.user.profile.handle) return res.sendStatus(404);
            res.locals.job = job; next();
        } catch (error) { next(error); }
    });
    router.get('/jobs/:id', (_req, res) => res.json(jobs.public(res.locals.job)));
    router.get('/jobs/:id/preview', async (_req, res, next) => {
        const job = res.locals.job;
        if (job.resultPurged) return res.sendStatus(410);
        try { res.json(await jobs.preview(job)); } catch (error) { next(error); }
    });
    router.get('/jobs/:id/content', (req, res, next) => {
        const offset = Number(req.query.offset || 0);
        if (!Number.isSafeInteger(offset) || offset < 0) return res.sendStatus(400);
        jobs.stream(res.locals.job, offset, res).catch(next);
    });
    router.post('/jobs/:id/cancel', async (_req, res) => { await jobs.cancel(res.locals.job); res.sendStatus(204); });
    router.post('/jobs/:id/ack', async (_req, res) => {
        try { await jobs.acknowledge(res.locals.job); res.sendStatus(204); }
        catch (error) { res.status(error.status || 500).json({ error: error.message }); }
    });
    app.use('/api/android', router);
}
