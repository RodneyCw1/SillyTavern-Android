import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const source = await fs.readFile(new URL('../server/public/scripts/android-standalone.js', import.meta.url), 'utf8');
function harness(text = 'Original answer') {
    const requests = [], replies = [];
    const ctx = {
        characters: [{ avatar: 'fixture.png' }], characterId: 0, groupId: null,
        chatId: 'fixture-chat', name2: 'Fixture',
        chat: [{ mes: text, name: 'Fixture', send_date: '2026-09-30', swipe_id: 0, is_user: false, extra: {} }],
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        async saveReply(value) { replies.push(value); this.chat.at(-1).mes = value.getMessage; },
        async saveChat() { return sandbox.window.fetch('/api/chats/save', { method: 'POST', body: JSON.stringify({ chat: this.chat }) }); },
    };
    const sandbox = {
        location: { origin: 'http://127.0.0.1:17614', href: 'http://127.0.0.1:17614/' },
        window: { SillyTavern: { getContext: () => ctx }, async fetch(input, options) {
            requests.push({ input, options }); return new Response('{}', { status: 200 });
        } },
        document: { addEventListener() {} }, console, URL, Request, Response,
        ReadableStream, AbortController, DOMException, TextEncoder, crypto,
        setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    };
    vm.runInNewContext(source.replace('window.STAndroid = {', 'window.STAndroid = { describeContext, restore, extractText, setType: value => generationType = value,'), sandbox);
    const api = sandbox.window.STAndroid;
    api.setType('continue');
    return { api, ctx, requests, replies, async job() {
        return { id: crypto.randomUUID(), endpoint: '/api/backends/chat-completions/generate', context: await api.describeContext({ chat_completion_source: 'makersuite' }) };
    } };
}

test('R01: continue recovery retains the complete original beyond 32000 characters', async () => {
    const original = '中文😀'.repeat(18000) + 'ORIGINAL_END';
    const h = harness(original), job = await h.job();
    await h.api.restore(job, ' continuation');
    assert.equal(h.ctx.chat[0].mes, original + ' continuation');
    assert.ok(h.requests.some(r => r.input.endsWith('/ack')));
    assert.ok(JSON.stringify(job.context).length < 4096, 'durable recovery metadata must stay bounded');
});
for (const change of ['edit', 'swipe', 'identity']) test(`R02: refuse recovery after ${change} without clearing the saved result`, async () => {
    const h = harness(), job = await h.job();
    if (change === 'edit') h.ctx.chat[0].mes = 'Edited answer';
    if (change === 'swipe') h.ctx.chat[0].swipe_id = 1;
    if (change === 'identity') h.ctx.chat[0].send_date = '2026-10-01';
    const current = h.ctx.chat[0].mes;
    await assert.rejects(h.api.restore(job, ' continuation'), /变化|校验|手动/);
    assert.equal(h.ctx.chat[0].mes, current);
    assert.equal(h.replies.length, 0);
    assert.equal(h.requests.some(r => r.input.endsWith('/ack')), false);
});
test('R02: legacy continue metadata cannot safely overwrite a message', async () => {
    const h = harness(), job = await h.job();
    job.context = { type: 'continue', avatar: 'fixture.png', groupId: null, chatId: 'fixture-chat', chatLength: 1, previousText: 'Original answer' };
    await assert.rejects(h.api.restore(job, ' continuation'), /旧|校验|手动/);
    assert.equal(h.requests.some(r => r.input.endsWith('/ack')), false);
});
test('R08: Gemini and Cohere recovery uses the recorded response protocol', () => {
    const h = harness();
    const gemini = 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'reasoning' }, { text: '中文' }, { text: '😀' }] } }] }) + '\n\n';
    const cohere = 'data: ' + JSON.stringify({ delta: { message: { content: { text: 'Cohere reply' } } } }) + '\r\n\r\n';
    assert.equal(h.api.extractText(gemini, { context: { provider: 'makersuite' } }), '中文😀');
    assert.equal(h.api.extractText(cohere, { context: { provider: 'cohere' } }), 'Cohere reply');
});
