import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const load = () => import(pathToFileURL(path.join(process.env.ST_ANDROID_TEST_SOURCE_ROOT || root, 'scripts/android-native-client.mjs')));
const binaryHash = '9'.repeat(64);
const response = Buffer.from([65, 13, 10, 66, 10, 0, 26, 255]);
function device({ peerUid = 10123, malformedResponse = false } = {}) {
    const operations = [];
    const requests = [];
    return { operations, requests, execute(args, options = {}) {
        operations.push(args);
        if (args.includes('getprop')) return 'x86_64';
        if (args.includes('id')) return '10123';
        if (args.includes('sha256sum')) return binaryHash + '  helper';
        if (args.includes('--check')) return `unix-http-probe-v1 uid=${peerUid}`;
        if (args[0] === 'shell' && args[1] === '-T') {
            requests.push({ args, options, bytes: Buffer.from(options.input.toString().trim(), 'base64') });
            return malformedResponse ? 'not base64!' : response.toString('base64') + '\r\n';
        }
        assert.equal(options.input, undefined, 'Only the binary-safe request pipeline may receive input');
        return '';
    } };
}
const build = () => ({ file: 'synthetic-native-probe', sha256: binaryHash });

test('same-UID request preserves CRLF, UTF-8, NUL and Ctrl-Z over Windows ADB', async () => {
    const { createNativeClient } = await load();
    const fake = device();
    const client = createNativeClient({ root, packageName: 'io.sillytavern.standalone.debug', execute: fake.execute, build });
    const request = Buffer.from('POST /fixture HTTP/1.0\r\nx-android-host: synthetic-secret\r\n\r\n中文😀\x00\x1a');
    assert.deepEqual(client.request(request), response);
    assert.deepEqual(fake.requests[0].bytes, request);
    assert.deepEqual(fake.requests[0].args.slice(0, 4), ['shell', '-T', 'run-as', 'io.sillytavern.standalone.debug']);
    assert.ok(fake.operations.every(args => !args.join(' ').includes('synthetic-secret')));
    client.close();
    assert.ok(fake.operations.some(args => args.includes('rmdir')));
    assert.ok(fake.operations.every(args => !args.includes('-R') && !args.includes('-r')));
});

test('release probe uses explicit app UID, never UID zero, with a bounded long import deadline', async () => {
    const { createNativeClient } = await load();
    const fake = device();
    const client = createNativeClient({ root, packageName: 'io.sillytavern.standalone', uid: 10123, execute: fake.execute, build });
    client.request(Buffer.from('GET / HTTP/1.0\r\n\r\n'), { responseTimeoutMs: 600000 });
    assert.deepEqual(fake.requests[0].args.slice(0, 4), ['shell', '-T', 'su', '10123']);
    assert.equal(fake.requests[0].options.timeout, 615000);
    assert.ok(fake.requests[0].args.at(-1).includes('600000'));
    assert.throws(() => createNativeClient({ root, packageName: 'io.sillytavern.standalone', uid: 0, execute: fake.execute, build }), /UID/);
});

test('wrong helper UID, oversized requests, invalid deadlines and corrupted transport fail closed', async () => {
    const { createNativeClient } = await load();
    const mismatch = device({ peerUid: 10124 });
    const badClient = createNativeClient({ root, packageName: 'io.sillytavern.standalone.debug', execute: mismatch.execute, build });
    assert.throws(() => badClient.request('GET / HTTP/1.0\r\n\r\n'), /UID/);
    assert.equal(mismatch.requests.length, 0);
    const fake = device();
    const client = createNativeClient({ root, packageName: 'io.sillytavern.standalone.debug', execute: fake.execute, build });
    assert.throws(() => client.request(Buffer.alloc(1024 ** 2 + 1)), /size|MiB/);
    for (const responseTimeoutMs of [0, 600001, Infinity, 123.4]) assert.throws(() => client.request('request', { responseTimeoutMs }), /timeout/i);
    assert.equal(fake.operations.length, 0);
    const broken = device({ malformedResponse: true });
    const brokenClient = createNativeClient({ root, packageName: 'io.sillytavern.standalone.debug', execute: broken.execute, build });
    assert.throws(() => brokenClient.request('GET / HTTP/1.0\r\n\r\n'), /base64|transport/i);
});
