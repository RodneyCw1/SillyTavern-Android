import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { JobStore, JOB_CACHE_LIMIT } from '../server/android/jobs.js';
const base = path.resolve(import.meta.dirname, '../.local/tests');
async function fixture(t) {
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'memory-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
test('thousands of old contexts stay on disk; bounded cache keeps old IDs recoverable and deduplicated', async t => {
    const root = await fixture(t), ids = [];
    const body = { fixture: 'never resend' }, endpoint = '/api/backends/chat-completions/generate';
    const fingerprint = crypto.createHash('sha256').update(endpoint + JSON.stringify(body)).digest('hex');
    for (let i = 0; i < 1000; i++) {
        const id = crypto.randomUUID(); ids.push(id);
        await fs.writeFile(path.join(root, id + '.json'), JSON.stringify({ id, owner: 'default-user', endpoint, fingerprint, state: 'complete', createdAt: i, finishedAt: i + 1, bytes: 2, acknowledged: i < 500, context: { name: 'fixture-' + i, previousText: String(i).padEnd(32000, '汉') } }));
        await fs.writeFile(path.join(root, id + '.response'), '{}');
    }
    const store = new JobStore(root); await store.initialize();
    assert.equal(store.jobs.size, 0);
    assert.ok(store.recent.size <= 128);
    for (const id of ids) assert.ok(await store.get(id));
    assert.ok(store.jobs.size <= JOB_CACHE_LIMIT);
    const old = await store.create({ id: ids[0], owner: 'default-user', endpoint, body });
    assert.equal(old.acknowledged, true);
    assert.equal(store.workers.size, 0);
    await assert.rejects(store.create({ id: ids[0], owner: 'default-user', endpoint, body: { different: true } }), /identifier/);
    let before = '', count = 0, visited = new Set();
    do {
        const page = await store.list('default-user', { limit: 20, before });
        assert.ok(page.items.length <= 20);
        for (const item of page.items) { assert.equal(item.context.previousText, undefined); assert.equal(visited.has(item.id), false); visited.add(item.id); count++; }
        before = page.nextCursor;
    } while (before);
    assert.equal(count, 500);
    assert.equal((await store.list('another-user')).items.length, 0);
    assert.ok(store.jobs.size <= JOB_CACHE_LIMIT);
    const latest = await store.get(ids.at(-1)); await store.acknowledge(latest);
    assert.equal(latest.context, undefined);
    assert.equal((await store.list('default-user')).items.some(j => j.id === latest.id), false);
});
test('preview is bounded while the complete result remains available for export', async t => {
    const root = await fixture(t), id = crypto.randomUUID();
    const raw = Buffer.from('大回复😀'.repeat(100000));
    await fs.writeFile(path.join(root, id + '.response'), raw);
    const store = new JobStore(root);
    const preview = await store.preview({ id, bytes: raw.length });
    assert.equal(preview.truncated, true);
    assert.ok(Buffer.byteLength(preview.raw) <= 256 * 1024 + 3);
    assert.deepEqual(await fs.readFile(store.contentPath(id)), raw);
});
test('simultaneous retries only submit one model request after asynchronous disk lookup', async t => {
    const root = await fixture(t); let requests = 0;
    const server = http.createServer((req, res) => { requests++; req.resume(); res.end('{}'); }).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => server.close());
    const store = new JobStore(root, server.address().port); await store.initialize();
    const request = { id: crypto.randomUUID(), endpoint: '/api/backends/chat-completions/generate', body: {}, owner: 'default-user', cookie: '', csrf: '' };
    const jobs = await Promise.all(Array.from({ length: 20 }, () => store.create(request)));
    assert.ok(jobs.every(job => job === jobs[0]));
    await store.workers.get(jobs[0].id);
    assert.equal(requests, 1);
});
