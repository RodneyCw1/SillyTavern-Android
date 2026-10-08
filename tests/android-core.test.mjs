import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { inside, stripCredentials, replaceDirectory } from '../server/android/files.js';
import { importMigration } from '../server/android/migration.js';
import { validateExtension, repositoryUrl } from '../server/android/extensions.js';
import { JobStore } from '../server/android/jobs.js';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'server/package.json'));
const archiver = require('archiver');
async function temporary(t) {
    const base = path.join(root, '.local/tests');
    await fsp.mkdir(base, { recursive: true });
    const dir = await fsp.mkdtemp(path.join(base, 'case-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    return dir;
}
async function archive(file, contents, corrupt = false) {
    const zip = archiver('zip');
    const done = pipeline(zip, fs.createWriteStream(file));
    const files = [];
    for (const [name, content] of Object.entries(contents)) {
        const bytes = Buffer.from(content);
        files.push({ path: name, size: bytes.length, sha256: corrupt ? '0'.repeat(64) : crypto.createHash('sha256').update(bytes).digest('hex') });
        zip.append(bytes, { name: 'user/' + name });
    }
    zip.append(JSON.stringify({ format: 'sillytavern-android-migration', version: 1, files }), { name: 'manifest.json' });
    await zip.finalize(); await done;
}
test('migration paths reject traversal and Windows absolute paths', () => {
    for (const value of ['../settings.json', '/tmp/a', 'a/../../b', 'C:/a', 'a\\b', '.', 'a//b']) assert.throws(() => inside(root, value));
    assert.equal(inside(root, '聊天/测试.json'), path.join(root, '聊天/测试.json'));
});
test('credential sanitizer preserves prompts and sampling settings', () => {
    const input = { api_key: 'secret', max_tokens: 4096, prompt: 'story', custom_url: 'http://127.0.0.1:8090/v1', nested: { authorization: 'Bearer private', endpoint: 'https://user:pass@example.com/v1?api_key=private&mode=chat' } };
    const output = stripCredentials(input);
    assert.equal(output.api_key, '');
    assert.equal(output.max_tokens, 4096);
    assert.equal(output.prompt, 'story');
    assert.equal(output.custom_url, '');
    assert.equal(output.nested.endpoint, 'https://example.com/v1?mode=chat');
    assert.equal(input.api_key, 'secret');
});
test('migration atomically replaces personal content and preserves phone extensions and keys', async t => {
    const dir = await temporary(t);
    const data = path.join(dir, 'data'), user = path.join(data, 'default-user');
    await fsp.mkdir(path.join(user, 'extensions/helper'), { recursive: true });
    await fsp.writeFile(path.join(user, 'extensions/helper/manifest.json'), '{"version":"4.9.5"}');
    await fsp.writeFile(path.join(user, 'settings.json'), '{"old":true}');
    await fsp.writeFile(path.join(user, 'secrets.json'), '{"phone":"private"}');
    const zip = path.join(dir, 'migration.zip');
    await archive(zip, { 'settings.json': '{"new":true}', 'chats/角色/测试.jsonl': '{"mes":"hello"}' });
    const result = await importMigration(zip, data);
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(user, 'settings.json'))), { new: true });
    assert.equal(await fsp.readFile(path.join(user, 'secrets.json'), 'utf8'), '{"phone":"private"}');
    assert.equal(await fsp.readFile(path.join(user, 'extensions/helper/manifest.json'), 'utf8'), '{"version":"4.9.5"}');
    assert.equal(result.restartRequired, true);
    assert.equal(await fsp.readFile(path.join(data, result.backup, 'settings.json'), 'utf8'), '{"old":true}');
});
test('corrupt migration and insufficient space leave current data intact', async t => {
    const dir = await temporary(t), data = path.join(dir, 'data');
    await fsp.mkdir(path.join(data, 'default-user'), { recursive: true });
    const settings = path.join(data, 'default-user/settings.json');
    await fsp.writeFile(settings, '{"keep":true}');
    const zip = path.join(dir, 'broken.zip');
    await archive(zip, { 'settings.json': '{}' }, true);
    await assert.rejects(importMigration(zip, data), /checksum/);
    await assert.rejects(importMigration(zip, data, { availableBytes: 1024 }), /space/);
    assert.equal(await fsp.readFile(settings, 'utf8'), '{"keep":true}');
});
test('migration refuses bundled extension and credential files', async t => {
    const dir = await temporary(t), zip = path.join(dir, 'unsafe.zip');
    await archive(zip, { 'settings.json': '{}', 'extensions/helper/manifest.json': '{}' });
    await assert.rejects(importMigration(zip, path.join(dir, 'data')), /Unexpected migration/);
});
test('directory replacement restores original if staging is missing', async t => {
    const dir = await temporary(t), destination = path.join(dir, 'target');
    await fsp.mkdir(destination);
    await fsp.writeFile(path.join(destination, 'keep'), 'original');
    await assert.rejects(replaceDirectory(path.join(dir, 'missing'), destination));
    assert.equal(await fsp.readFile(path.join(destination, 'keep'), 'utf8'), 'original');
});
test('extension validation preserves compatibility boundary', async t => {
    const dir = await temporary(t);
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ display_name: 'test', version: '1.0', minimum_client_version: '1.19.1', js: 'index.js' }));
    await fsp.writeFile(path.join(dir, 'index.js'), '');
    await assert.rejects(validateExtension(dir), /newer SillyTavern/);
    for (const minimum of ['1.14.0', '1.15.0', '1.19.0']) {
        await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ display_name: 'test', version: '1.0', minimum_client_version: minimum, js: 'index.js' }));
        assert.equal((await validateExtension(dir)).minimum_client_version, minimum);
    }
    for (const url of ['file:///x', 'http://example.com/plugin', 'https://user:pass@example.com/plugin']) assert.throws(() => repositoryUrl(url));
    assert.equal(repositoryUrl('https://github.com/test/plugin/'), 'https://github.com/test/plugin');
});
test('durable generation runs once, stores bytes independently and recovers after restart', async t => {
    const dir = await temporary(t);
    let requests = 0;
    const server = http.createServer((req, res) => {
        requests++;
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
        setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n'), 100);
    }).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => server.close());
    const store = new JobStore(dir, server.address().port); await store.initialize();
    const request = { id: crypto.randomUUID(), endpoint: '/api/backends/chat-completions/generate', body: { api_key: 'not-persisted' }, owner: 'default-user', context: { chatId: 'test' }, cookie: '', csrf: '' };
    const job = await store.create(request);
    assert.equal(await store.create(request), job);
    for (let n = 0; n < 100 && !job.finishedAt; n++) await new Promise(r => setTimeout(r, 20));
    assert.equal(job.state, 'complete'); assert.equal(requests, 1);
    const raw = await fsp.readFile(store.contentPath(job.id), 'utf8');
    assert.match(raw, /你/); assert.match(raw, /好/);
    assert.equal((await fsp.readFile(path.join(dir, job.id + '.json'), 'utf8')).includes('not-persisted'), false);
    const recovered = new JobStore(dir); await recovered.initialize();
    assert.equal((await recovered.get(job.id)).bytes, Buffer.byteLength(raw));
    await recovered.acknowledge((await recovered.get(job.id)));
    assert.equal((await recovered.get(job.id)).acknowledged, true);
    await assert.rejects(store.create({ ...request, body: { different: true } }), /identifier/);
});
test('unfinished jobs become interrupted without replaying a model request', async t => {
    const dir = await temporary(t), id = crypto.randomUUID();
    await fsp.writeFile(path.join(dir, id + '.json'), JSON.stringify({ id, owner: 'default-user', state: 'running', bytes: 1 }));
    await fsp.writeFile(path.join(dir, id + '.response'), 'partial');
    const store = new JobStore(dir); await store.initialize();
    assert.equal((await store.get(id)).state, 'interrupted');
    assert.equal(store.activeCount(), 0);
    assert.equal((await store.get(id)).bytes, 7);
});
test('cancel closes the upstream request and preserves partial output', async t => {
    const dir = await temporary(t);
    const server = http.createServer((req, res) => { req.resume(); res.writeHead(200); res.write('partial'); }).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
    const store = new JobStore(dir, server.address().port); await store.initialize();
    const job = await store.create({ id: crypto.randomUUID(), endpoint: '/api/backends/chat-completions/generate', body: {}, owner: 'default-user', cookie: '', csrf: '' });
    for (let i = 0; i < 100 && !job.bytes; i++) await new Promise(r => setTimeout(r, 10));
    await store.cancel(job);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(job.state, 'cancelled');
    assert.equal(await fsp.readFile(store.contentPath(job.id), 'utf8'), 'partial');
});



test('GitLab repository URLs use the canonical Git endpoint', () => {
    for (const suffix of ['', '/', '///', '.git', '.git/']) {
        assert.equal(repositoryUrl('https://gitlab.com/novi028/JS-Slash-Runner' + suffix),
            'https://gitlab.com/novi028/JS-Slash-Runner.git');
    }
    assert.equal(repositoryUrl('https://GITLAB.com/group/subgroup/plugin/'),
        'https://gitlab.com/group/subgroup/plugin.git');
    assert.equal(repositoryUrl('https://github.com/test/plugin/'), 'https://github.com/test/plugin');
    assert.equal(repositoryUrl('https://code.example.org/group/plugin'), 'https://code.example.org/group/plugin');
    for (const url of ['https://user:token@gitlab.com/a/b', 'http://gitlab.com/a/b', 'https://gitlab.com/a/b?token=x', 'https://gitlab.com/a/b#main']) {
        assert.throws(() => repositoryUrl(url));
    }
});




