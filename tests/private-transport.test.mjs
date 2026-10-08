import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { JobStore } from '../server/android/jobs.js';

async function temporary(t) {
    const base = path.resolve('.local/tests');
    await fs.mkdir(base, { recursive: true });
    const dir = await fs.mkdtemp(path.join(base, 'ipc-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
}
function socketName(dir) {
    return process.platform === 'win32' ? '\\\\.\\pipe\\st-review-' + crypto.randomUUID() : path.join(dir, 'runtime.sock');
}

test('R04 background jobs use private IPC even when an unrelated TCP service claims readiness', async t => {
    const dir = await temporary(t), socketPath = socketName(dir);
    let leaked = 0, requests = 0;
    const decoy = http.createServer((req, res) => { leaked++; req.resume(); res.end('{"ready":true}'); });
    decoy.listen(0, '127.0.0.1'); await once(decoy, 'listening');
    t.after(() => { decoy.closeAllConnections(); decoy.close(); });
    const runtime = http.createServer((req, res) => {
        requests++; assert.match(req.headers.cookie, /synthetic-session/);
        req.resume(); res.end('private model result');
    });
    runtime.listen(socketPath); await once(runtime, 'listening');
    t.after(() => { runtime.closeAllConnections(); runtime.close(); });
    const store = new JobStore(path.join(dir, 'jobs'), decoy.address().port, { socketPath });
    await store.initialize();
    const job = await store.create({ id: crypto.randomUUID(), owner: 'test', endpoint: '/api/backends/chat-completions/generate', body: {}, cookie: 'session=synthetic-session', csrf: 'synthetic-csrf' });
    await store.workers.get(job.id);
    assert.equal(leaked, 0, 'a TCP listener must never receive session credentials');
    assert.equal(requests, 1);
    assert.equal(job.state, 'complete');
    assert.equal(await fs.readFile(store.contentPath(job.id), 'utf8'), 'private model result');
});

test('R04 private listener serves HTTP without opening a browser TCP port', async t => {
    const { listenPrivate } = await import('../server/android/transport.js');
    const dir = await temporary(t), socketPath = socketName(dir);
    const server = await listenPrivate((_req, res) => res.end('private'), socketPath);
    t.after(() => { server.closeAllConnections(); server.close(); });
    assert.equal(server.address(), socketPath);
    const text = await new Promise((resolve, reject) => {
        http.get({ socketPath, path: '/' }, async res => {
            let body = ''; for await (const chunk of res) body += chunk;
            resolve(body);
        }).on('error', reject);
    });
    assert.equal(text, 'private');
});

test('R04 socket path must stay inside the private home and existing ordinary files survive', async t => {
    const { androidSocketPath, listenPrivate } = await import('../server/android/transport.js');
    const dir = await temporary(t);
    assert.equal(androidSocketPath(dir), path.join(dir, 'runtime.sock'));
    assert.throws(() => androidSocketPath(dir, path.join(dir, '..', 'foreign.sock'), 'android'), /private/);
    const file = path.join(dir, 'runtime.sock'); await fs.writeFile(file, 'keep');
    await assert.rejects(listenPrivate(() => {}, file), /socket|pipe/i);
    assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});
