import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { LimitedCache } from '../server/public/scripts/limited-cache.js';
import { getMessageDepth } from '../server/public/scripts/message-depth.js';

test('cache releases old entries and retains recently used values, including zero', () => {
    const cache = new LimitedCache(3);
    cache.set('a', 0).set('b', 2).set('c', 3);
    assert.equal(cache.get('a'), 0);
    cache.set('d', 4);
    assert.equal(cache.has('b'), false);
    assert.equal(cache.get('a'), 0);
    for (let i = 0; i < 10000; i++) cache.set('entry-' + i, i);
    assert.equal(cache.size, 3);
    assert.equal(cache.get('entry-9999'), 9999);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.weight, 0);
});

test('weighted cache bounds retained text and skips oversized input without changing its result', () => {
    const cache = new LimitedCache(100, { maxWeight: 20, sizeOf: key => key.length * 2 });
    cache.set('中文', 7).set('longer', 9);
    assert.equal(cache.weight, 16);
    cache.set('最新', 12);
    assert.equal(cache.weight, 20);
    cache.get('中文');
    cache.set('next', 4);
    assert.equal(cache.has('longer'), false);
    assert.equal(cache.get('中文'), 7);
    const before = [...cache];
    cache.set('x'.repeat(100), 123);
    assert.deepEqual([...cache], before);
    cache.set('next', 0);
    assert.equal(cache.get('next'), 0);
    cache.delete('next');
    assert.equal(cache.weight, 8);
    assert.throws(() => new LimitedCache(0), RangeError);
});

test('message depth matches existing regex semantics for system messages and invalid indices', () => {
    const oldDepth = (messages, id) => {
        const usable = messages.map((message, index) => ({ message, index })).filter(x => !x.message.is_system);
        const index = usable.findIndex(x => x.index === Number(id));
        return id >= 0 && index !== -1 ? usable.length - index - 1 : undefined;
    };
    const messages = Array.from({ length: 250 }, (_, i) => ({ is_system: i % 7 === 0 }));
    for (const id of [-1, 0.5, undefined, null, '', '02', 'bad', 250, ...messages.map((_, i) => i)]) {
        assert.equal(getMessageDepth(messages, id), oldDepth(messages, id), 'messageId=' + id);
    }
    assert.equal(getMessageDepth([], 0), undefined);
});

test('streaming the newest message does not visit the preceding long chat', () => {
    let reads = 0;
    const messages = new Proxy(Array.from({ length: 30000 }, () => ({ is_system: false })), {
        get(target, property) {
            if (/^\d+$/.test(String(property))) reads++;
            return Reflect.get(target, property);
        },
    });
    for (let i = 0; i < 1000; i++) assert.equal(getMessageDepth(messages, 29999), 0);
    assert.ok(reads <= 2000, 'Only the target message should be read, not 30 million preceding messages');
});

async function tokenHarness(initial = {}, filename = new URL('../server/public/scripts/tokenizers.js', import.meta.url)) {
    const store = {
        saved: initial,
        async getItem() { return structuredClone(this.saved); },
        async setItem(_key, value) { this.saved = structuredClone(value); },
        async removeItem() { this.saved = {}; },
    };
    const character = { chat: 'chat-0' }, group = { id: 'group-0', chat_id: 'group-chat' };
    const settings = { tokenizer: 0, token_padding: 7 };
    let requests = 0, reset;
    const context = vm.createContext({
        console: { debug() {}, log() {}, warn() {} },
        TextEncoder,
        toastr: { success() {} },
        jQuery: { ajax(options) {
            requests++;
            const data = { token_count: 123, count: 123 };
            if (options.success) options.success(data);
            return Promise.resolve(data);
        } },
    });
    const modules = {
        '../lib.js': { localforage: { createInstance: () => store } },
        '../script.js': { eventSource: { on() {} }, event_types: { ONLINE_STATUS_CHANGED: 'online' }, characters: [character], main_api: 'kobold', nai_settings: {}, online_status: 'no_connection', this_chid: 0 },
        './power-user.js': { power_user: settings, registerDebugFunction: (_id, _name, _description, action) => { reset = action; } },
        './openai.js': { chat_completion_sources: { OPENAI: 'openai' }, model_list: [], oai_settings: { chat_completion_source: 'openai', openai_model: 'gpt-test' } },
        './group-chats.js': { groups: [group], selected_group: null },
        './utils.js': { getStringHash: value => value },
        './kai-settings.js': { kai_flags: {}, kai_settings: {} },
        './textgen-settings.js': { textgen_types: {}, textgenerationwebui_settings: {}, getTextGenServer: () => '', getTextGenModel: () => '' },
        './textgen-models.js': { getCurrentDreamGenModelTokenizer() {}, getCurrentOpenRouterModelTokenizer() {}, openRouterModels: [] },
        './limited-cache.js': { LimitedCache },
    };
    const linked = {};
    const module = new vm.SourceTextModule(await fs.readFile(filename, 'utf8'), { context });
    await module.link(specifier => {
        const values = modules[specifier];
        assert.ok(values, 'Unexpected tokenizer dependency: ' + specifier);
        const dependency = new vm.SyntheticModule(Object.keys(values), function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context });
        linked[specifier] = dependency;
        return dependency;
    });
    await module.evaluate();
    settings.tokenizer = module.namespace.tokenizers.NONE;
    await module.namespace.initTokenizers();
    return { api: module.namespace, store, character, settings, linked, modules, reset: () => reset(), requests: () => requests };
}

test('legacy token cache is capped on load and preserves the existing JSON storage format', async () => {
    const initial = Object.fromEntries(Array.from({ length: 12 }, (_, chat) => [
        'chat-' + chat, Object.fromEntries(Array.from({ length: 9000 }, (_, entry) => ['entry-' + entry, entry])),
    ]));
    const h = await tokenHarness(initial);
    await h.api.saveTokenCache();
    assert.equal(Object.keys(h.store.saved).length, 8);
    assert.equal(h.store.saved['chat-0'], undefined);
    assert.equal(Object.keys(h.store.saved['chat-11']).length, 8192);
    assert.equal(h.store.saved['chat-11']['entry-8999'], 8999);
    assert.equal(h.store.saved['chat-11']['entry-0'], undefined);
    await h.reset();
    await h.api.saveTokenCache();
    assert.deepEqual(h.store.saved, {});
});

test('sync/async counts retain model, padding and chat isolation and recompute evicted entries', async () => {
    const h = await tokenHarness();
    const text = '中文测试，cached tokens';
    const expected = Math.ceil(new TextEncoder().encode(text).length / h.api.BYTES_PER_TOKEN);
    assert.equal(await h.api.getTokenCountAsync(text, 2), expected + 2);
    assert.equal(h.api.getTokenCount(text, 0), expected);
    assert.equal(h.api.countTokensOpenAI({ role: 'user', content: text }, true), 123);
    assert.equal(await h.api.countTokensOpenAIAsync({ role: 'user', content: text }, true), 123);
    assert.equal(h.requests(), 1, 'Async call should reuse the sync result');
    h.modules['./openai.js'].oai_settings.openai_model = 'different-model';
    assert.equal(await h.api.countTokensOpenAIAsync({ role: 'user', content: text }, true), 123);
    assert.equal(h.requests(), 2, 'Different model needs a separate count');
    h.linked['./group-chats.js'].setExport('selected_group', 'group-0');
    await h.api.countTokensOpenAIAsync({ role: 'user', content: text }, true);
    assert.equal(h.requests(), 3, 'Group chat needs a separate cache');
    h.linked['./group-chats.js'].setExport('selected_group', null);
    for (let i = 0; i < 9000; i++) await h.api.getTokenCountAsync('new text ' + i, 0);
    for (let i = 1; i <= 16; i++) {
        h.character.chat = 'chat-' + i;
        assert.equal(await h.api.getTokenCountAsync(text, 2), expected + 2);
    }
    h.character.chat = 'chat-0';
    assert.equal(await h.api.countTokensOpenAIAsync({ role: 'user', content: text }, true), 123);
    assert.equal(h.requests(), 4, 'Old count is recomputed rather than returning a wrong result');
    await h.api.saveTokenCache();
    assert.ok(Object.keys(h.store.saved).length <= 8);
    assert.ok(Object.values(h.store.saved).every(counts => Object.keys(counts).length <= 8192));
    const reloaded = await tokenHarness(h.store.saved);
    reloaded.modules['./openai.js'].oai_settings.openai_model = 'different-model';
    assert.equal(await reloaded.api.countTokensOpenAIAsync({ role: 'user', content: text }, true), 123);
    assert.equal(reloaded.requests(), 0, 'Saved bounded cache works after a page reload');
});
