import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { once } from 'node:events';
import { loadAndroidConfig } from '../server/android/config.js';
import { seedExtensions } from '../server/android/seed-extensions.js';
import { localDreamRequest } from '../server/android/localdream.js';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'server/package.json'));
const express = require('express'), lodash = require('lodash');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };
async function temporary(t) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'st-restart-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    return dir;
}

test('Android restart preserves saved nested configuration and adds new defaults', async t => {
    const dir = await temporary(t), defaults = path.join(dir, 'default.yaml'), saved = path.join(dir, 'saved.yaml');
    await fsp.writeFile(defaults, 'performance:\n  useDiskCache: true\n  lazyLoadCharacters: false\nextensions:\n  enabled: true\n');
    await fsp.writeFile(saved, 'performance:\n  useDiskCache: false\ncustomAddress: http://127.0.0.1:8081\n');
    assert.deepEqual(loadAndroidConfig(defaults, saved), {
        performance: { useDiskCache: false, lazyLoadCharacters: false }, extensions: { enabled: true }, customAddress: 'http://127.0.0.1:8081',
    });
    assert.equal(loadAndroidConfig(defaults, path.join(dir, 'first-start')).performance.useDiskCache, true);
    await fsp.writeFile(saved, '[]');
    assert.throws(() => loadAndroidConfig(defaults, saved));
});
















test('Android LocalDream proxy streams the actual protocol and forwards no Tavern credentials', async t => {
    let upstreamHeaders, payload;
    const upstream = express(); upstream.use(express.json());
    upstream.get('/health', (_req, res) => res.sendStatus(200));
    upstream.post('/generate', (req, res) => {
        upstreamHeaders = req.headers; payload = req.body;
        res.setHeader('Content-Type', 'text/event-stream');
        res.write('event: progress\ndata: {"type":"progress","step":1,"total_steps":2}\n\n');
        setTimeout(() => res.end('event: complete\ndata: {"type":"complete","format":"jpeg","image":"AA=="}\n\n'), 20);
    });
    const model = upstream.listen(8081, '127.0.0.1'); await once(model, 'listening');
    t.after(() => { model.closeAllConnections(); model.close(); });
    const app = express(); app.use(express.json());
    app.get('/health', localDreamRequest); app.post('/generate', localDreamRequest);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await fetch(url + '/health')).status, 200);
    const response = await fetch(url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: 'private', 'X-Android-Host': 'private', 'X-CSRF-Token': 'private' }, body: '{"prompt":"test","output_format":"jpeg"}' });
    assert.match(await response.text(), /"type":"complete"/);
    assert.equal(payload.output_format, 'jpeg');
    for (const key of ['cookie', 'x-android-host', 'x-csrf-token']) assert.equal(upstreamHeaders[key], undefined);
    assert.equal((await fetch(url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    assert.equal((await fetch(url + '/health')).status, 503);
});
