import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const express = require('express');

test('updater save barrier counts live writes and releases canceled streaming connections', async t => {
    const base = path.resolve('.local/tests'); await fs.mkdir(base, { recursive: true });
    const home = await fs.mkdtemp(path.join(base, 'update-save-barrier-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const token = 'a'.repeat(64);
    process.env.ST_ANDROID = '1'; process.env.ST_ANDROID_HOME = home; process.env.ST_ANDROID_TOKEN = token;
    const { installAndroidNative, androidAuth } = await import('../server/android/host.js');
    const app = express(); app.use(androidAuth); await installAndroidNative(app);
    let saving, streamingSocket;
    app.post('/held-save', (_req, res) => { saving = res; res.flushHeaders(); });
    app.post('/canceled-stream', (req, res) => {
        // Upstream generation handlers replace socket close listeners. On disconnect,
        // ServerResponse may therefore never emit close or finish.
        req.socket.removeAllListeners('close'); streamingSocket = req.socket;
        res.write('synthetic stream');
    });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const port = server.address().port;
    const status = async () => (await (await fetch(`http://127.0.0.1:${port}/api/android/native/status`, { headers: { 'x-android-host': token } })).json()).pendingSaves;
    const post = async route => {
        const request = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers: { 'x-android-host': token } });
        request.end(); const [response] = await once(request, 'response'); response.resume(); return response;
    };
    const held = await post('/held-save');
    assert.equal(await status(), 1, 'an outstanding save must block installation');
    const finished = once(held, 'end'); saving.end(); await finished;
    assert.equal(await status(), 0);
    const stream = await post('/canceled-stream'); assert.equal(await status(), 1);
    const closed = once(streamingSocket, 'close'); stream.destroy(); await closed;
    assert.equal(await status(), 0, 'a canceled socket must not leave a permanent save barrier');
    assert.equal(await status(), 0, 'cleanup must remain idempotent');
});