import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { atomicJson, inside } from './files.js';

export const GENERATION_PATHS = new Set(['/api/backends/chat-completions/generate', '/api/backends/text-completions/generate', '/api/backends/kobold/generate', '/api/novelai/generate']);
export const JOB_CACHE_LIMIT = 64;
const NOTIFICATION_LIMIT = 128;
const terminal = new Set(['complete', 'failed', 'cancelled', 'interrupted']);
export class JobStore {
    constructor(root, port = 17614, { socketPath = process.env.ST_ANDROID_SOCKET } = {}) { this.root = root; this.port = port; this.socketPath = socketPath; this.jobs = new Map(); this.writes = new Map(); this.workers = new Map(); this.loads = new Map(); this.creating = new Map(); this.recent = new Map(); }
    async initialize() {
        await fsp.mkdir(this.root, { recursive: true });
        for await (const item of await fsp.opendir(this.root)) {
            const entry = item.name;
            if (!entry.endsWith('.json')) continue;
            try {
                const job = JSON.parse(await fsp.readFile(path.join(this.root, entry), 'utf8'));
                if (!/^[a-f0-9-]{36}$/.test(job.id)) continue;
                if (!terminal.has(job.state)) { job.state = 'interrupted'; job.finishedAt = Date.now(); }
                if (job.acknowledged) { await fsp.rm(this.contentPath(job.id), { force: true }); job.resultPurged = true; }
                job.bytes = fs.existsSync(this.contentPath(job.id)) ? (await fsp.stat(this.contentPath(job.id))).size : 0;
                await this.save(job);
                this.rememberCompletion(job);
            } catch (error) { console.warn('Unable to recover Android job metadata:', entry, error.message); }
        }
    }
    trimCache() {
        let completed = 0;
        for (const job of this.jobs.values()) if (terminal.has(job.state) && !this.workers.has(job.id) && !this.writes.has(job.id)) completed++;
        for (const [id, job] of this.jobs) {
            if (completed <= JOB_CACHE_LIMIT) break;
            if (terminal.has(job.state) && !this.workers.has(id) && !this.writes.has(id)) { this.jobs.delete(id); completed--; }
        }
    }
    rememberCompletion(job) {
        if (!job.finishedAt || job.acknowledged) { this.recent.delete(job.id); return; }
        this.recent.set(job.id, { id: job.id, state: job.state, finishedAt: job.finishedAt });
        if (this.recent.size > NOTIFICATION_LIMIT) {
            const oldest = [...this.recent.values()].sort((a, b) => a.finishedAt - b.finishedAt || a.id.localeCompare(b.id))[0];
            this.recent.delete(oldest.id);
        }
    }
    async get(id) {
        if (!/^[a-f0-9-]{36}$/.test(id || '')) return null;
        if (this.jobs.has(id)) {
            const job = this.jobs.get(id); this.jobs.delete(id); this.jobs.set(id, job); return job;
        }
        if (this.loads.has(id)) return this.loads.get(id);
        const loading = (async () => {
            try {
                const job = JSON.parse(await fsp.readFile(inside(this.root, id + '.json'), 'utf8'));
                if (job.id !== id) throw new Error('Generation metadata ID mismatch');
                this.jobs.set(id, job); this.trimCache(); return job;
            } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        })();
        this.loads.set(id, loading);
        try { return await loading; } finally { this.loads.delete(id); }
    }
    async list(owner, { limit = 20, before = '' } = {}) {
        limit = Math.max(1, Math.min(50, Number(limit) || 20));
        const entries = [];
        const key = job => String(job.createdAt || 0).padStart(16, '0') + ':' + job.id;
        for await (const entry of await fsp.opendir(this.root)) {
            if (!/^[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
            const id = entry.name.slice(0, -5);
            let job;
            try { job = this.jobs.get(id) || JSON.parse(await fsp.readFile(path.join(this.root, entry.name), 'utf8')); }
            catch (error) { console.warn('Unable to list generation metadata:', entry.name, error.message); continue; }
            if (job.owner !== owner || job.acknowledged || before && key(job) >= before) continue;
            entries.push({ id: job.id, state: job.state, createdAt: job.createdAt, bytes: job.bytes, context: { name: job.context?.name, type: job.context?.type } });
            entries.sort((a, b) => key(a) < key(b) ? 1 : -1);
            if (entries.length > limit + 1) entries.pop();
        }
        const more = entries.length > limit;
        if (more) entries.pop();
        return { items: entries, nextCursor: more ? key(entries.at(-1)) : null };
    }
    async preview(job) {
        const limit = 256 * 1024;
        const file = await fsp.open(this.contentPath(job.id), 'r');
        try {
            const buffer = Buffer.alloc(Math.min(job.bytes, limit));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            return { raw: buffer.subarray(0, bytesRead).toString('utf8'), truncated: job.bytes > bytesRead };
        } finally { await file.close(); }
    }
    contentPath(id) { return inside(this.root, id + '.response'); }
    async save(job) {
        const previous = this.writes.get(job.id) || Promise.resolve();
        const writing = previous.catch(() => {}).then(async () => {
            const { request, response, ...metadata } = job;
            await atomicJson(inside(this.root, job.id + '.json'), metadata);
        });
        this.writes.set(job.id, writing);
        try { await writing; this.rememberCompletion(job); } finally { if (this.writes.get(job.id) === writing) this.writes.delete(job.id); this.trimCache(); }
    }
    public(job) {
        const { request, response, fingerprint, ...metadata } = job;
        return metadata;
    }
    activeCount() { return [...this.jobs.values()].filter(j => !terminal.has(j.state)).length; }
    async create(input) {
        const { id, endpoint, body, owner } = input;
        if (this.creating.has(id)) {
            const job = await this.creating.get(id);
            const fingerprint = crypto.createHash('sha256').update(endpoint + JSON.stringify(body)).digest('hex');
            if (job.owner !== owner || job.fingerprint !== fingerprint) throw new Error('Request identifier already used');
            return job;
        }
        const creating = this.createOnce(input);
        this.creating.set(id, creating);
        try { return await creating; } finally { this.creating.delete(id); }
    }
    async createOnce({ id, endpoint, body, context, owner, cookie, csrf }) {
        if (!/^[a-f0-9-]{36}$/.test(id || '') || !GENERATION_PATHS.has(endpoint)) throw new Error('Invalid generation request');
        const fingerprint = crypto.createHash('sha256').update(endpoint + JSON.stringify(body)).digest('hex');
        const existing = await this.get(id);
        if (existing) {
            if (existing.owner !== owner || existing.fingerprint !== fingerprint) throw new Error('Request identifier already used');
            return existing;
        }
        const job = { id, owner, endpoint, context, fingerprint, createdAt: Date.now(), state: 'queued', bytes: 0, status: null, contentType: null, acknowledged: false };
        this.jobs.set(id, job);
        await fsp.writeFile(this.contentPath(id), '', { mode: 0o600 });
        await this.save(job);
        const worker = this.run(job, body, cookie, csrf).catch(async error => {
            job.response?.destroy(); job.request?.destroy();
            delete job.request; delete job.response;
            job.state = job.state === 'cancelled' ? 'cancelled' : 'failed';
            job.error = error.message; job.finishedAt = Date.now();
            await this.save(job);
        }).finally(() => { this.workers.delete(job.id); this.trimCache(); });
        this.workers.set(job.id, worker);
        worker.catch(error => console.error('Unable to persist Android generation state:', error.message));
        return job;
    }
    async run(job, body, cookie, csrf) {
        const data = Buffer.from(JSON.stringify(body));
        job.state = 'running';
        await this.save(job);
        if (job.state === 'cancelled') return;
        const response = await new Promise((resolve, reject) => {
            const request = http.request({
                ...(this.socketPath ? { socketPath: this.socketPath } : { hostname: '127.0.0.1', port: this.port }),
                path: job.endpoint, method: 'POST',
                headers: { host: `127.0.0.1:${this.port}`, 'content-type': 'application/json', 'content-length': data.length, 'accept-encoding': 'identity', cookie, 'x-csrf-token': csrf },
            }, resolve);
            job.request = request;
            request.on('error', reject);
            request.setTimeout(10 * 60 * 1000, () => request.destroy(new Error('Generation request timed out')));
            request.end(data);
        });
        job.response = response;
        job.status = response.statusCode || 502;
        job.contentType = String(response.headers['content-type'] || 'application/octet-stream');
        await this.save(job);
        for await (const chunk of response) {
            if (job.bytes + chunk.length > 64 * 1024 ** 2) throw new Error('Generation result exceeds 64 MiB');
            await fsp.appendFile(this.contentPath(job.id), chunk);
            job.bytes += chunk.length;
        }
        job.state = job.state === 'cancelled' ? 'cancelled' : job.status >= 200 && job.status < 300 ? 'complete' : 'failed';
        job.finishedAt = Date.now();
        delete job.request; delete job.response;
        await this.save(job);
    }
    async cancel(job) {
        if (terminal.has(job.state)) return;
        job.state = 'cancelled'; job.finishedAt = Date.now();
        job.response?.destroy(); job.request?.destroy();
        await this.workers.get(job.id);
        await this.save(job);
    }
    async acknowledge(job) {
        if (!terminal.has(job.state)) throw Object.assign(new Error('Generation is still active'), { status: 409 });
        job.acknowledged = true; await this.save(job);
        await fsp.rm(this.contentPath(job.id), { force: true });
        job.bytes = 0; job.resultPurged = true;
        delete job.context; // The durable ID/fingerprint still prevents resubmission.
        await this.save(job);
    }
    async stream(job, offset, res) {
        if (job.resultPurged) return res.status(410).json({ error: 'This result has already been saved or marked as handled.' });
        let closed = false;
        res.on('close', () => { closed = true; });
        while (!job.status && !terminal.has(job.state) && !closed) await new Promise(r => setTimeout(r, 100));
        if (closed) return;
        if (offset > job.bytes) return res.status(416).json({ error: 'Invalid stream offset' });
        res.status(job.status || 502);
        res.setHeader('Content-Type', job.contentType || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store, no-transform');
        res.setHeader('X-Android-Job-State', job.state);
        res.flushHeaders();
        while (!closed) {
            const end = job.bytes;
            if (end > offset) {
                const stream = fs.createReadStream(this.contentPath(job.id), { start: offset, end: end - 1 });
                for await (const chunk of stream) {
                    if (closed) break;
                    res.write(chunk); offset += chunk.length;
                    if (res.writableLength > 1024 * 1024) {
                        await new Promise(resolve => {
                            const finish = () => { res.off('drain', finish); res.off('close', finish); resolve(); };
                            res.once('drain', finish); res.once('close', finish);
                        });
                    }
                }
            }
            if (terminal.has(job.state) && offset >= job.bytes) { res.end(); return; }
            await new Promise(r => setTimeout(r, 100));
        }
    }
}
