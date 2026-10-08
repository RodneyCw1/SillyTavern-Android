import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const project = path.resolve(import.meta.dirname, '..');
const load = () => import(pathToFileURL(process.env.ST_APPLICATION_ACCEPTANCE_SOURCE || path.join(project, 'scripts/application-acceptance.mjs')));

test('application acceptance requires explicit synthetic-data mode and a complete desktop or Android target', async () => {
    const { parseArgs } = await load();
    assert.equal(parseArgs(['--synthetic-data', '--desktop-token-file', '.local/desktop-data/session-token']).mode, 'desktop');
    assert.equal(parseArgs(['--synthetic-data', '--serial', 'emulator-5558', '--apk', 'debug.apk']).mode, 'android');
    for (const args of [[], ['--desktop-token-file', 'token'], ['--synthetic-data', '--serial', 'phone'], ['--synthetic-data', '--apk', 'a'], ['--synthetic-data', '--serial', 'emulator-5558', '--apk', 'a', '--desktop-token-file', 'b'], ['--synthetic-data', '--unknown', 'a']]) assert.throws(() => parseArgs(args));
});

test('local model serves ordinary and streamed Unicode responses through real HTTP without paid endpoints', async t => {
    const { startMockModel } = await load();
    const model = await startMockModel(); t.after(() => model.close());
    assert.match(model.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    model.enqueue('普通回复😀');
    const ordinary = await fetch(model.url + '/chat/completions', { method: 'POST', body: JSON.stringify({ stream: false, messages: [] }) });
    assert.equal((await ordinary.json()).choices[0].message.content, '普通回复😀');
    model.enqueue('流式中文😀完成');
    const response = await fetch(model.url + '/chat/completions', { method: 'POST', body: JSON.stringify({ stream: true, messages: [] }) });
    const events = (await response.text()).split('\n\n').filter(part => part.startsWith('data: ') && !part.includes('[DONE]')).map(part => JSON.parse(part.slice(6)));
    assert.equal(events.map(event => event.choices[0].delta.content || '').join(''), '流式中文😀完成');
    assert.deepEqual(model.calls.map(call => call.stream), [false, true]);
    const models = await (await fetch(model.url + '/models')).json();
    assert.equal(models.data[0].id, 'acceptance-mock');
});

test('local model rejects unexpected unqueued generation so acceptance cannot silently consume another request', async t => {
    const { startMockModel } = await load();
    const model = await startMockModel(); t.after(() => model.close());
    const response = await fetch(model.url + '/chat/completions', { method: 'POST', body: '{}' });
    assert.equal(response.status, 409);
    assert.equal(model.calls.length, 0);
});

test('retention assertions compare complete long reply and require a saved acknowledged job', async () => {
    const { assertRecoveryResult } = await load();
    const text = '前文😀' + 'x'.repeat(64000) + '继续回复';
    const result = { text, length: 4, acknowledged: true, restored: true, complete: true };
    assert.doesNotThrow(() => assertRecoveryResult(result, { text, length: 4 }));
    assert.throws(() => assertRecoveryResult({ ...result, text: text.slice(-32000) }, { text, length: 4 }));
    assert.throws(() => assertRecoveryResult({ ...result, acknowledged: false }, { text, length: 4 }));
    assert.throws(() => assertRecoveryResult({ ...result, length: 5 }, { text, length: 4 }));
});

test('save failure injection targets the restored job save, not an earlier automatic chat save', async () => {
    const { isRestoredJobSave } = await load();
    const id = 'fixture-job';
    const request = extra => JSON.stringify({ chat: [{ mes: 'Synthetic reply', extra }] });
    assert.equal(isRestoredJobSave('/api/chats/save', request({ android_job_id: id, android_job_restored: true }), id), true);
    assert.equal(isRestoredJobSave('/api/chats/save', request({ android_job_id: 'previous-job', android_job_complete: true }), id), false);
    assert.equal(isRestoredJobSave('/api/chats/save', request({ android_job_id: id }), id), false);
    assert.equal(isRestoredJobSave('/api/settings/save', request({ android_job_id: id, android_job_restored: true }), id), false);
});

test('Android application evidence rejects stale runtime or a non-debuggable package', async () => {
    const { assertDebugIdentity } = await load();
    const expected = { appVersion: '1.1.3', sourceHash: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) };
    const dump = 'versionCode=6 minSdk=29\nversionName=1.1.3\npkgFlags=[ DEBUGGABLE HAS_CODE ]';
    assert.doesNotThrow(() => assertDebugIdentity(expected, expected, dump));
    assert.throws(() => assertDebugIdentity({ ...expected, sourceHash: 'c'.repeat(64) }, expected, dump));
    assert.throws(() => assertDebugIdentity(expected, expected, dump.replace('DEBUGGABLE', '')));
    assert.throws(() => assertDebugIdentity(expected, expected, dump.replace('versionCode=6', 'versionCode=5')));
});
