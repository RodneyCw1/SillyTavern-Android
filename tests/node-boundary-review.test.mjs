import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { JobStore } from '../server/android/jobs.js';
import { listenPrivate } from '../server/android/transport.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const express = require('express');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-node-boundary-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
function socketName(root) { return process.platform === 'win32' ? '\\\\.\\pipe\\st-node-review-' + crypto.randomUUID() : path.join(root, 'runtime.sock'); }
function closeAfter(t, server) { t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })); }

test('R04 ServerStartup selects only the private listener and propagates missing socket errors', async t => {
    const root = await temporary(t), socketPath = socketName(root);
    const source = await fs.readFile(new URL('../server/src/server-startup.js', import.meta.url), 'utf8');
    const environment = { ST_ANDROID: '1', ST_ANDROID_SOCKET: socketPath };
    const sandbox = vm.createContext({ process: { env: environment }, console });
    let tcpAttempts = 0, privateServer;
    const transport = new vm.SyntheticModule(['listenPrivate'], function () {
        this.setExport('listenPrivate', async (...args) => {
            privateServer = await listenPrivate(...args);
            return privateServer;
        });
    }, { context: sandbox });
    await transport.link(() => {}); await transport.evaluate();
    const module = new vm.SourceTextModule(source, {
        context: sandbox,
        importModuleDynamically: specifier => {
            assert.equal(specifier, '../android/transport.js');
            return transport;
        },
    });
    await module.link(specifier => {
        let exports;
        if (specifier === 'node:http' || specifier === 'node:https') exports = { default: { createServer() { tcpAttempts++; throw new Error('Unexpected TCP listener'); } } };
        else if (specifier === 'node:fs') exports = { default: {} };
        else if (specifier === './util.js') exports = { color: { red: x => x }, urlHostnameToIPv6: x => x, getHasIP: async () => ({}) };
        else exports = { router: {} };
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context: sandbox });
    });
    await module.evaluate();
    const startup = new module.namespace.ServerStartup((_req, res) => res.end('private'), { enableIPv4: true });
    const result = await startup.start();
    closeAfter(t, privateServer);
    assert.equal(result.socketPath, socketPath);
    assert.equal(privateServer.address(), socketPath);
    assert.equal(result.useIPv4, false);
    assert.equal(result.useIPv6, false);
    delete environment.ST_ANDROID_SOCKET;
    await assert.rejects(startup.start(), /socket path is required/);
    assert.equal(tcpAttempts, 0);
});

test('R04 simultaneous duplicate generation IDs share one IPC request and clear creation tracking', async t => {
    const root = await temporary(t), socketPath = socketName(root);
    let requests = 0;
    const runtime = await listenPrivate((req, res) => { requests++; req.resume(); res.end('one synthetic result'); }, socketPath);
    closeAfter(t, runtime);
    const store = new JobStore(path.join(root, 'jobs'), 17614, { socketPath });
    await store.initialize();
    const input = { id: crypto.randomUUID(), endpoint: '/api/backends/chat-completions/generate', body: { prompt: 'synthetic' }, owner: 'fixture', cookie: '', csrf: '' };
    const jobs = await Promise.all(Array.from({ length: 8 }, () => store.create(input)));
    for (const job of jobs) assert.equal(job, jobs[0]);
    await store.workers.get(input.id);
    assert.equal(requests, 1);
    assert.equal(store.creating.size, 0);
    assert.equal(store.workers.size, 0);
    assert.equal(jobs[0].state, 'complete');
});

test('R11 busy and duplicate imports clean only the operation they own', async t => {
    const home = await temporary(t), token = 'b'.repeat(64);
    const oldEnv = Object.fromEntries(['ST_ANDROID', 'ST_ANDROID_HOME', 'ST_ANDROID_TOKEN'].map(key => [key, process.env[key]]));
    const oldDataRoot = globalThis.DATA_ROOT;
    Object.assign(process.env, { ST_ANDROID: '1', ST_ANDROID_HOME: home, ST_ANDROID_TOKEN: token });
    globalThis.DATA_ROOT = path.join(home, 'data');
    t.after(() => {
        for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        globalThis.DATA_ROOT = oldDataRoot;
    });
    await fs.mkdir(path.join(home, 'imports')); await fs.mkdir(globalThis.DATA_ROOT);
    const { installAndroidNative, androidAuth } = await import('../server/android/host.js');
    const app = express(); app.use(express.json()); app.use(androidAuth); await installAndroidNative(app);
    const busyStarted = deferred(), busyRelease = deferred();
    app.post('/busy-save', async (_req, res) => { busyStarted.resolve(); await busyRelease.promise; res.end('saved'); });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); closeAfter(t, server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (endpoint, body) => fetch(base + endpoint, { method: 'POST', headers: { 'x-android-host': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const id = crypto.randomUUID().replaceAll('-', ''), other = crypto.randomUUID().replaceAll('-', '');
    const input = path.join(home, 'imports', id + '.zip'), otherInput = path.join(home, 'imports', other + '.zip');

    const busy = post('/busy-save', {}); await busyStarted.promise;
    await fs.writeFile(input, 'synthetic invalid archive');
    assert.equal((await post('/api/android/native/import', { id })).status, 409);
    await assert.rejects(fs.stat(input), { code: 'ENOENT' });
    busyRelease.resolve(); await busy;

    const entered = deferred(), release = deferred(), originalLstat = fs.lstat.bind(fs);
    t.mock.method(fs, 'lstat', async (...args) => {
        if (args[0] === input) { entered.resolve(); await release.promise; }
        return originalLstat(...args);
    });
    t.after(() => release.resolve());
    await fs.writeFile(input, 'synthetic invalid archive'); await fs.writeFile(otherInput, 'other operation');
    const first = post('/api/android/native/import', { id }); await entered.promise;
    assert.equal((await post('/api/android/native/import', { id })).status, 409);
    assert.equal(await fs.readFile(input, 'utf8'), 'synthetic invalid archive');
    assert.equal((await post('/api/android/native/import', { id: other })).status, 409);
    await assert.rejects(fs.stat(otherInput), { code: 'ENOENT' });
    assert.equal(await fs.readFile(input, 'utf8'), 'synthetic invalid archive');
    release.resolve();
    assert.equal((await first).status, 400);
    await assert.rejects(fs.stat(input), { code: 'ENOENT' });
    const status = await fetch(base + '/api/android/native/status', { headers: { 'x-android-host': token } });
    assert.equal((await status.json()).ready, true);
});
