import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const coreSource = (await fs.readFile(process.env.ST_SAVE_REPLY_REVIEW_SOURCE || new URL('../server/public/script.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const adapterSource = await fs.readFile(process.env.ST_RECOVERY_REVIEW_SOURCE || new URL('../server/public/scripts/android-standalone.js', import.meta.url), 'utf8');
const start = coreSource.indexOf('export async function saveReply(');
assert.ok(start >= 0);
const end = coreSource.indexOf('\n}\n', start);
assert.ok(end > start, 'The complete saveReply function must be extracted');
const saveReplySource = coreSource.slice(start, end + 3).replace('export async function', 'async function');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function message(text) {
    return { mes: text, name: 'Fixture', is_user: false, send_date: '2026-09-30', swipe_id: 0, swipes: [text], swipe_info: [{ extra: { kept: true } }], extra: { kept: true } };
}
function harness(pauseAt = null) {
    const gate = deferred(), entered = deferred(), effectsAfterSwitch = [], requests = [];
    let switched = false, chatId = 'fixture-chat';
    const chat = [message('Original')];
    async function boundary(name) { if (pauseAt === name) { entered.resolve(); await gate.promise; } }
    const sandbox = {
        chat, characters: [{ avatar: 'fixture.png' }], this_chid: 0, selected_group: null, name2: 'Fixture',
        generation_started: new Date('2026-09-30'), group_generation_id: 1,
        power_user: { message_token_count_enabled: true, trim_spaces: false },
        getMessageTimeStamp: () => 'new timestamp', getGeneratingApi: () => 'synthetic', getGeneratingModel: () => 'synthetic',
        async processImageAttachment() { await boundary('image'); },
        async getTokenCountAsync() { await boundary('tokens'); return 7; },
        event_types: { MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
        eventSource: { async emit(event) { if (switched) effectsAfterSwitch.push('event:' + event); await boundary(event); } },
        addOneMessage() { if (switched) effectsAfterSwitch.push('render'); },
        statMesProcess() { if (switched) effectsAfterSwitch.push('stats'); },
        parseReasoningInSwipes() {}, structuredClone, Date,
        location: { origin: 'http://127.0.0.1:17614', href: 'http://127.0.0.1:17614/' },
        document: { addEventListener() {} }, console: { ...console, debug() {} }, URL, Request, Response,
        ReadableStream, AbortController, DOMException, TextEncoder, crypto,
        setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    };
    sandbox.window = { SillyTavern: { getContext: () => ({
        chat, characters: sandbox.characters, characterId: 0, groupId: null, chatId, name2: 'Fixture',
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        saveReply: sandbox.realSaveReply,
        async saveChat() { await sandbox.window.fetch('/api/chats/save', { method: 'POST', body: JSON.stringify({ file_name: chatId, chat }) }); },
    }) }, async fetch(input, options) { requests.push({ input, options }); return new Response('{}', { status: 200 }); } };
    vm.createContext(sandbox);
    vm.runInContext(saveReplySource + '\nglobalThis.realSaveReply = saveReply;', sandbox);
    vm.runInContext(adapterSource.replace('window.STAndroid = {', 'window.STAndroid = { describeContext, restore, setType: value => generationType = value,'), sandbox);
    const api = sandbox.window.STAndroid;
    return { api, chat, requests, effectsAfterSwitch, entered: entered.promise, release: () => gate.resolve(),
        realSaveReply: sandbox.realSaveReply,
        switchChat(returnToOriginalId) {
            switched = true; chatId = 'other-chat';
            chat.splice(0, chat.length, message('Different message'));
            if (returnToOriginalId) chatId = 'fixture-chat';
            return structuredClone(chat[0]);
        },
        async job(type) { api.setType(type); return { id: crypto.randomUUID(), context: await api.describeContext({}) }; },
    };
}

for (const type of ['normal', 'continue']) {
    for (const phase of ['image', 'tokens', 'received', 'rendered']) {
        for (const returnToOriginalId of [false, true]) {
            test(`R02 real saveReply ${type}: ${phase} await detects ${returnToOriginalId ? 'A-B-A with replaced message' : 'chat switch'} before touching the new chat`, async () => {
                const h = harness(phase), job = await h.job(type);
                const pending = h.api.restore(job, ' recovered');
                await h.entered;
                const expected = h.switchChat(returnToOriginalId);
                h.release();
                await assert.rejects(pending, /变化|校验|手动/);
                assert.deepEqual(h.chat, [expected]);
                assert.deepEqual(h.effectsAfterSwitch, []);
                assert.equal(h.requests.some(item => item.input.endsWith('/ack')), false);
            });
        }
    }
    test(`R02 real saveReply ${type}: successful recovery is saved and acknowledged`, async () => {
        const h = harness(), job = await h.job(type);
        await h.api.restore(job, ' recovered');
        assert.equal(h.chat.at(-1).mes, type === 'continue' ? 'Original recovered' : ' recovered');
        assert.equal(h.requests.filter(item => item.input.endsWith('/ack')).length, 1);
    });
}

test('saveReply keeps its ordinary behavior when no recovery context guard is supplied', async () => {
    const h = harness();
    await h.realSaveReply({ type: 'normal', getMessage: 'ordinary reply' });
    assert.equal(h.chat.length, 2);
    assert.equal(h.chat[1].mes, 'ordinary reply');
    assert.deepEqual(Array.from(h.chat[1].swipes), ['ordinary reply']);
});
