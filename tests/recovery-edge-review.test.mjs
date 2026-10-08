import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const source = await fs.readFile(process.env.ST_RECOVERY_REVIEW_SOURCE || new URL('../server/public/scripts/android-standalone.js', import.meta.url), 'utf8');
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function harness() {
    const requests = [], replies = [];
    const control = { saveStatus: 200, digest: null, afterReply: null };
    const state = {
        characters: [{ avatar: 'fixture.png' }], characterId: 0, groupId: null,
        chatId: 'fixture-chat', name2: 'Fixture',
        chat: [{ mes: 'Original', name: 'Fixture', send_date: '2026-09-30', swipe_id: 0, is_user: false, extra: {} }],
    };
    const getContext = () => ({ ...state,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        async saveReply(value) {
            replies.push(value);
            if (value.type === 'appendFinal') state.chat.at(-1).mes = value.getMessage;
            else state.chat.push({ mes: value.getMessage, extra: {}, is_user: false });
            if (control.afterReply) await control.afterReply();
        },
        async saveChat() {
            await sandbox.window.fetch('/api/chats/save', { method: 'POST', body: JSON.stringify({ file_name: state.chatId, chat: state.chat }) });
        },
    });
    const sandbox = {
        location: { origin: 'http://127.0.0.1:17614', href: 'http://127.0.0.1:17614/' },
        window: { SillyTavern: { getContext }, async fetch(input, options) {
            requests.push({ input, options });
            return new Response('{}', { status: input === '/api/chats/save' ? control.saveStatus : 200 });
        } },
        document: { addEventListener() {} }, console, URL, Request, Response,
        ReadableStream, AbortController, DOMException, TextEncoder,
        crypto: { randomUUID: crypto.randomUUID, subtle: { async digest(...args) {
            if (control.digest) await control.digest();
            return crypto.subtle.digest(...args);
        } } },
        setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    };
    vm.runInNewContext(source.replace('window.STAndroid = {', 'window.STAndroid = { describeContext, restore, extractText, setType: value => generationType = value,'), sandbox);
    const api = sandbox.window.STAndroid;
    return { api, state, requests, replies, control,
        async job(type = 'continue', provider = 'makersuite') {
            api.setType(type);
            return { id: crypto.randomUUID(), context: await api.describeContext({ chat_completion_source: provider }) };
        },
        pauseDigest() {
            const entered = deferred(), release = deferred();
            control.digest = async () => { entered.resolve(); await release.promise; };
            return { entered: entered.promise, release: () => release.resolve() };
        },
    };
}

for (const [field, value] of [['send_date', 'changed'], ['name', 'Changed'], ['is_user', true], ['is_system', true]]) {
    test(`R02 asynchronous fingerprint rejects a changed ${field}`, async () => {
        const h = harness(), job = await h.job(), pause = h.pauseDigest();
        const pending = h.api.restore(job, ' continuation');
        await pause.entered;
        h.state.chat[0][field] = value;
        pause.release();
        await assert.rejects(pending, /变化|校验|手动/);
        assert.equal(h.replies.length, 0);
        assert.equal(h.requests.some(r => r.input.endsWith('/ack')), false);
    });
}

test('R02 asynchronous fingerprint rejects a chat switch', async () => {
    const h = harness(), job = await h.job(), pause = h.pauseDigest();
    const pending = h.api.restore(job, ' continuation');
    await pause.entered;
    h.state.chatId = 'other-chat';
    pause.release();
    await assert.rejects(pending, /变化|校验|手动/);
    assert.equal(h.replies.length, 0);
});

test('R02 chat switch during saveReply does not mark a different chat or acknowledge the result', async () => {
    const h = harness(), job = await h.job();
    h.control.afterReply = async () => {
        h.state.chatId = 'other-chat';
        // clearChat({ clearData: true }) preserves the exported array identity.
        h.state.chat.splice(0, h.state.chat.length, { mes: 'Other chat', is_user: false, extra: {} });
    };
    await assert.rejects(h.api.restore(job, ' continuation'), /变化|校验|手动/);
    assert.equal(h.state.chat[0].mes, 'Other chat');
    assert.equal(h.state.chat[0].extra.android_job_id, undefined);
    assert.equal(h.requests.some(r => r.input.endsWith('/ack')), false);
});

for (const type of ['normal', 'continue']) test(`R02 ${type} save failure can retry without duplicating the recovered reply`, async () => {
    const h = harness(), job = await h.job(type);
    h.control.saveStatus = 500;
    await assert.rejects(h.api.restore(job, ' recovered'), /保存|错误|重试/);
    assert.equal(h.requests.some(r => r.input.endsWith('/ack')), false);
    const first = JSON.stringify(h.state.chat);
    h.control.saveStatus = 200;
    await h.api.restore(job, ' recovered');
    assert.equal(h.replies.length, 1);
    assert.equal(h.state.chat.length, type === 'normal' ? 2 : 1);
    assert.equal(h.state.chat.at(-1).mes, type === 'normal' ? ' recovered' : 'Original recovered');
    assert.ok(first.includes('recovered'));
    assert.equal(h.requests.filter(r => r.input.endsWith('/ack')).length, 1);
});

test('R08 Gemini non-stream recovery accepts the backend OpenAI response envelope', () => {
    const h = harness();
    const raw = JSON.stringify({ choices: [{ message: { content: '中文 reply' } }], responseContent: { parts: [{ text: '中文 reply' }] } });
    assert.equal(h.api.extractText(raw, { context: { provider: 'makersuite' } }), '中文 reply');
});

test('R08 real Gemini and Cohere SSE structures omit reasoning and retain all text deltas', () => {
    const h = harness();
    const gemini = [
        { candidates: [{ content: { parts: [{ thought: true, text: 'hidden reasoning' }] }, index: 0 }] },
        { candidates: [{ content: { parts: [{ text: '中文' }] }, index: 0 }] },
        { candidates: [{ content: { parts: [{ text: '😀' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { totalTokenCount: 5 } },
    ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('');
    const cohere = [
        { type: 'message-start', delta: { message: { role: 'assistant', content: [] } } },
        { type: 'content-start', index: 0, delta: { message: { content: { type: 'text', text: '' } } } },
        { type: 'content-delta', index: 0, delta: { message: { content: { text: 'Cohere ' } } } },
        { type: 'content-delta', index: 0, delta: { message: { content: { text: 'reply' } } } },
        { type: 'message-end', delta: { finish_reason: 'COMPLETE', usage: { tokens: { output_tokens: 2 } } } },
    ].map(value => 'event: ' + value.type + '\r\ndata: ' + JSON.stringify(value) + '\r\n\r\n').join('');
    assert.equal(h.api.extractText(gemini, { context: { provider: 'makersuite' } }), '中文😀');
    assert.equal(h.api.extractText(cohere, { context: { provider: 'cohere' } }), 'Cohere reply');
});
