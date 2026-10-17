import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import vm from 'node:vm';
import puppeteer from 'puppeteer-core';
import { getAndroidChatWindow, resolveAndroidChatSelection, resolveAndroidTokenCountText } from '../server/public/scripts/android-chat-window.js';

const large = { markdownOnly: true, placement: [2], replaceString: '<!doctype html>' + 'x'.repeat(300 * 1024) };

test('large embedded cards page Android message surfaces without truncating the conversation', () => {
    const options = { android: true, scripts: [large], total: 31 };
    assert.deepEqual(getAndroidChatWindow(options), { start: 29, end: 31, total: 31 });
    assert.deepEqual(getAndroidChatWindow({ ...options, end: 29 }), { start: 27, end: 29, total: 31 });
    assert.deepEqual(getAndroidChatWindow({ ...options, end: 1 }), { start: 0, end: 1, total: 31 });
    assert.deepEqual(getAndroidChatWindow({ ...options, end: 100 }), { start: 29, end: 31, total: 31 });
    assert.equal(getAndroidChatWindow({ ...options, total: 0 }), null);
});

test('desktop, ordinary cards and disabled or prompt-only templates keep normal history rendering', () => {
    const options = { android: true, scripts: [large], total: 30 };
    for (const scripts of [[], [{ ...large, disabled: true }], [{ ...large, markdownOnly: false }],
        [{ ...large, placement: [1] }], [{ ...large, replaceString: '<html>small</html>' }],
        [{ ...large, replaceString: 'plain text'.repeat(40000) }]]) {
        assert.equal(getAndroidChatWindow({ ...options, scripts }), null);
    }
    assert.equal(getAndroidChatWindow({ ...options, android: false }), null);
});

test('selected Android history persists per avatar without mutating card contents or losing new selections', () => {
    const selections = {}, first = { avatar: 'large.png', chat: 'old', data: { description: 'keep' } };
    assert.equal(resolveAndroidChatSelection(first, selections), true);
    first.chat = 'fifteen-rounds';
    assert.equal(resolveAndroidChatSelection(first, selections), true);
    const reloaded = { avatar: first.avatar, chat: 'old', data: first.data };
    assert.equal(resolveAndroidChatSelection(reloaded, selections), false);
    assert.equal(reloaded.chat, 'fifteen-rounds');
    reloaded.chat = 'new conversation';
    resolveAndroidChatSelection(reloaded, selections);
    assert.equal(selections[first.avatar], 'new conversation');
    assert.deepEqual(first.data, { description: 'keep' });
});

test('display-only expanded HTML is counted as its raw reply while real large prompts remain intact', () => {
    const html = '<!doctype html><html>' + 'x'.repeat(300 * 1024) + '</html>';
    const message = { mes: '<gametxt>Actual reply</gametxt>', extra: { reasoning: 'Reasoning' } };
    const document = { querySelectorAll: () => [{ getAttribute: () => '0', querySelectorAll: () => [{ textContent: html }] }] };
    const options = { android: true, document, messages: [message] };
    assert.equal(resolveAndroidTokenCountText('display style\n' + html, options), 'Reasoning' + message.mes);
    assert.equal(resolveAndroidTokenCountText(html, { ...options, android: false }), html);
    assert.equal(resolveAndroidTokenCountText('large actual prompt '.repeat(20000), options), 'large actual prompt '.repeat(20000));
    assert.equal(resolveAndroidTokenCountText(html, { ...options, messages: [{ mes: html }] }), html);
    assert.equal(resolveAndroidTokenCountText(html, { ...options, messages: [{ ...message, is_user: true }] }), html);
    const delayed = { ...options, document: { querySelectorAll: () => [] },
        templates: [{ ...large, replaceString: html, findRegex: 'gametxt' }], matches: (template, raw) => raw.includes(template.findRegex) };
    assert.equal(resolveAndroidTokenCountText('display style\n' + html, delayed), 'Reasoning' + message.mes,
        'A delayed callback must remain safe after its iframe was released');
    assert.equal(resolveAndroidTokenCountText(html, { ...delayed, templates: [{ ...delayed.templates[0], promptOnly: true }] }), html);
    assert.equal(resolveAndroidTokenCountText('Prompt context '.repeat(1000) + html, delayed), 'Prompt context '.repeat(1000) + html);
});

test('opening large Android history never resubmits the full card editor', async () => {
    const source = (await fs.readFile(new URL('../server/public/script.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    const start = source.indexOf('export async function openCharacterChat(');
    const code = source.slice(start, source.indexOf('\n////////', start)).replace('export ', '');
    const calls = [], character = { chat: 'old' };
    let largeAndroid = true;
    const context = vm.createContext({
        waitUntilCondition: async () => {}, isChatSaving: false, debounce_timeout: {},
        characters: [character], this_chid: 0, chat: [], chat_metadata: {}, clearChat: async () => {}, getChat: async () => {},
        $: () => ({ val() {} }), androidMessageRange: () => largeAndroid ? {} : null,
        updateAndroidChatSelection: () => {},
        createOrEditCharacter: async () => calls.push(['editor']), CustomEvent: class {},
    });
    vm.runInContext(code, context);
    await context.openCharacterChat('fifteen-rounds');
    assert.deepEqual(calls, []);
    await context.openCharacterChat('fifteen-rounds');
    assert.equal(calls.length, 0, 'Reopening history must not rewrite a multi-megabyte PNG');
    largeAndroid = false;
    await context.openCharacterChat('ordinary');
    assert.deepEqual(calls.at(-1), ['editor']);
});

const chrome = [process.env.ST_TEST_CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(file => file && existsSync(file));

test('actual chat rendering and navigation keep large DOM bounded across history and new replies', { skip: !chrome && 'Chromium is required' }, async t => {
    const source = (await fs.readFile(new URL('../server/public/script.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    const policy = await fs.readFile(new URL('../server/public/scripts/android-chat-window.js', import.meta.url), 'utf8');
    const jquery = await fs.readFile(new URL('../server/public/lib/jquery-3.5.1.min.js', import.meta.url));
    const windowCode = source.slice(source.indexOf('let androidChatWindow = null;'), source.indexOf('export function scrollOnMediaLoad()'));
    const addStart = source.indexOf('export function addOneMessage(');
    const addCode = source.slice(addStart, source.indexOf('\n/**', addStart));
    assert.ok(windowCode.includes('export async function redisplayChat(') && addCode.includes('return messageElement;'));
    const harness = `import { ANDROID_CHAT_PAGE_SIZE, createAndroidChatNavigation, getAndroidChatWindow, resolveAndroidChatSelection } from '/policy.js';
        window.AndroidHost = {}; let heavy = true;
        const chat = Array.from({length:30}, (_,id)=>({mes:'turn-'+id,is_user:id%2===0,extra:{variables:{round:id}}}));
        const original = JSON.stringify(chat), formatted = [], retainedOnFormat = [], chatElement = $('#chat');
        const extension_settings={disabledExtensions:[]}, getRegexScripts=()=>heavy?[${JSON.stringify(large)}]:[];
        const power_user={chat_truncation:100}, characters=[{}], this_chid=0, event_types={CHAT_LOADED:'loaded',MORE_MESSAGES_LOADED:'more'};
        let runtimes=[]; const eventSource={async emit(type,event){if(type==='loaded'){if(!event.detail)throw Error('Missing chat lifecycle payload');runtimes=[...document.querySelectorAll('.mes')];}}};
        const SCROLL_BEHAVIOR={}, debounce_timeout={short:0}, delay=()=>Promise.resolve(), scrollOnMediaLoad=()=>{};
        const refreshSwipeButtons=()=>{}, applyStylePins=()=>{}, updateEditArrowClasses=()=>{}, scrollChatToBottom=()=>{}, applyCharacterTagsToMessageDivs=()=>{};
        const lodash={range:(start,end)=>Array.from({length:end-start},(_,i)=>i+start)};
        function updateMessageElement(message,{messageId}){formatted.push(messageId);retainedOnFormat.push(runtimes.length);const e=$('<div class="mes">').attr('mesid',messageId);$('<span>').text(message.mes).appendTo(e);if(!message.is_user)$('<pre><code></code></pre>').find('code').text('x'.repeat(1024*1024)).end().appendTo(e);return e;}
        ${windowCode} ${addCode}
        $(document).on('click','[data-android-chat-page]',async function(){await showAndroidChatPage(this.dataset.androidChatPage);});
        window.harness={chat,formatted,retainedOnFormat,original,printMessages,redisplayChat,addOneMessage,showMoreMessages,async loaded(){await eventSource.emit('loaded',{detail:{id:0,character:{}}});},get runtimeCount(){return runtimes.length},normal(){heavy=false}};
        await printMessages(); await window.harness.loaded(); window.ready=true;`;
    const server = http.createServer((req,res) => {
        const body = req.url === '/policy.js' ? policy : req.url === '/jquery.js' ? jquery : req.url === '/harness.js' ? harness
            : '<!doctype html><div id="chat"></div><script src="/jquery.js"></script><script type="module" src="/harness.js"></script>';
        res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(body);
    }).listen(0,'127.0.0.1');
    await once(server,'listening');
    t.after(()=>{server.closeAllConnections();server.close();});
    const base=path.resolve('.local/tests');await fs.mkdir(base,{recursive:true});
    const profile=await fs.mkdtemp(path.join(base,'chat-window-'));let browser;
    t.after(async()=>{await browser?.close();await fs.rm(profile,{recursive:true,force:true});});
    browser=await puppeteer.launch({executablePath:chrome,headless:true,userDataDir:profile,args:['--no-sandbox']});
    const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>window.ready);
    const ids=()=>page.$$eval('#chat .mes',e=>e.map(x=>Number(x.getAttribute('mesid'))));
    assert.deepEqual(await ids(),[28,29]);
    assert.deepEqual(await page.evaluate(()=>harness.formatted),[28,29],'Older templates must never be expanded on initial load');
    for(let cycle=0;cycle<8;cycle++){
        await page.click('[data-android-chat-page="older"]');await page.waitForFunction(()=>document.querySelector('.mes')?.getAttribute('mesid')==='26');
        assert.deepEqual(await ids(),[26,27]);
        assert.equal(await page.evaluate(()=>harness.runtimeCount),2);
        await page.click(`[data-android-chat-page="${cycle % 2 ? 'latest' : 'newer'}"]`);await page.waitForFunction(()=>document.querySelector('.mes')?.getAttribute('mesid')==='28');
        assert.deepEqual(await ids(),[28,29]);
        assert.equal(await page.$$eval('pre code',e=>e.reduce((n,x)=>n+x.textContent.length,0)),1024*1024);
    }
    assert.ok(await page.evaluate(()=>harness.retainedOnFormat.every(count=>count===0)), 'Old iframe runtimes must be released before formatting another large template');
    assert.equal(await page.evaluate(()=>JSON.stringify(harness.chat)===harness.original),true,'Rendering must preserve every message and variable');
    await page.click('[data-android-chat-page="older"]');await page.waitForFunction(()=>document.querySelector('.mes')?.getAttribute('mesid')==='26');
    await page.evaluate(()=>{for(const is_user of [true,false]){const message={mes:'new-'+is_user,is_user,extra:{}};harness.chat.push(message);harness.addOneMessage(message,{scroll:false});}});
    assert.deepEqual(await ids(),[30,31]);
    assert.equal(await page.evaluate(()=>harness.chat.length),32);
    await page.evaluate(async()=>{harness.normal();await harness.redisplayChat();});
    assert.equal((await ids()).length,32,'Ordinary cards must keep full rendering');
    assert.equal(await page.$('#android_chat_navigation'),null);
});
