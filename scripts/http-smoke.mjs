import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { once } from 'node:events';
const root = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:17614';
let cookie = 'st_android_auth=' + fs.readFileSync(path.join(root, '.local/desktop-data/session-token'), 'utf8');
let csrf;
async function call(url, body) {
    const response = await fetch(origin + url, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const set of response.headers.getSetCookie()) cookie += '; ' + set.split(';')[0];
    return response;
}
let calls = 0;
const model = http.createServer((req, res) => {
    calls++; req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"安卓"}}]}\n\n');
    setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"独立运行正常"}}]}\n\ndata: [DONE]\n\n'), 400);
}).listen(17616, '127.0.0.1');
await once(model, 'listening');
const report = { checks: [] };
try {
    const unauthenticated = await fetch(origin + '/');
    assert.equal(unauthenticated.status, 403);
    report.checks.push('Untrusted local requests are rejected');
    csrf = (await (await call('/csrf-token')).json()).token;
    const noCsrf = await fetch(origin + '/api/ping', { method: 'POST', headers: { cookie } });
    assert.equal(noCsrf.status, 403);
    report.checks.push('CSRF protection is active');
    const discovery = await (await call('/api/extensions/discover')).json();
    assert.equal(discovery.filter(p => p.name === 'third-party/JS-Slash-Runner').length, 1);
    report.checks.push('Exactly one Tavern Helper is discovered');
    for (const name of ['/JS-Slash-Runner', '/ST-Prompt-Template']) {
        const response = await call('/api/extensions/version', { extensionName: name, global: false });
        assert.equal(response.status, 200, await response.clone().text());
        const info = await response.json();
        assert.ok(info.currentCommitHash);
    }
    report.checks.push('Legacy extension names and HTTPS version checks work without system Git');
    const body = { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:17616/v1', model: 'mock', messages: [{ role: 'user', content: 'local test' }], stream: true, max_tokens: 32, temperature: 0.1 };
    const id = crypto.randomUUID();
    const request = { id, endpoint: '/api/backends/chat-completions/generate', body, context: { type: 'normal', chatId: 'fixture' } };
    const created = await call('/api/android/jobs', request);
    assert.equal(created.status, 202, await created.clone().text());
    assert.equal((await call('/api/android/jobs', request)).status, 202);
    const output = await call('/api/android/jobs/' + id + '/content');
    const text = await output.text();
    assert.equal(output.status, 200, text);
    assert.match(text, /安卓/); assert.match(text, /独立运行正常/);
    const replay = await (await call('/api/android/jobs/' + id + '/content?offset=10')).text();
    assert.equal(replay, Buffer.from(text).subarray(10).toString());
    assert.equal(calls, 1);
    report.checks.push('Real SillyTavern model proxy streams durably, replays by byte offset and deduplicates requests');
    assert.equal((await call('/api/android/jobs/' + id + '/ack', {})).status, 204);
    await fsp.writeFile(path.join(root, 'docs/http-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} finally { model.closeAllConnections(); model.close(); }
