import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { protectAndroidHtmlBlocks } from '../server/public/scripts/android-html-blocks.js';

const html = '<!doctype html><html><script>const sample = "<thinking>literal</thinking>";\n'
    + 'const value = "& < > $1 $&";\n'.repeat(12000) + '</script></html>\n';

test('large fenced HTML survives later text rules without changing its bytes', () => {
    const input = `before\n\`\`\`html\n${html}\`\`\`\nafter`;
    const block = protectAndroidHtmlBlocks(input, { android: true });
    assert.ok(block.text.length < 100);
    assert.equal(block.restore(block.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '')), input);
    const next = protectAndroidHtmlBlocks(block.text + '\n~~~\n' + html + '~~~\n', { android: true });
    assert.equal(block.restore(next.restore(next.text)), input + '\n~~~\n' + html + '~~~\n');
});

test('unterminated HTML and longer fences remain code instead of entering Markdown span parsing', () => {
    for (const [fence, end] of [['```', ''], ['````', '````\n'], ['~~~', '~~~~\n']]) {
        const payload = html + '```\n';
        const protectedHtml = protectAndroidHtmlBlocks(fence + '\n' + payload + end, { android: true, render: true });
        assert.ok(protectedHtml.text.length < 100);
        const output = protectedHtml.restore(protectedHtml.text);
        assert.ok(output.includes('&lt;script&gt;'));
        assert.ok(!output.includes('<script>'));
        assert.ok(output.includes('&amp; &lt; &gt; $1 $&amp;'));
    }
});

test('desktop and ordinary code keep their existing formatting', () => {
    for (const [input, android] of [[`\`\`\`html\n${html}\`\`\``, false],
        [`\`\`\`js\n${html}\`\`\``, true], ['```html\n<html>small</html>\n```', true],
        ['plain '.repeat(100000), true]]) {
        const block = protectAndroidHtmlBlocks(input, { android });
        assert.equal(block.text, input);
        assert.equal(block.restore(input), input);
    }
});

test('actual regex pipeline hides raw thoughts while preserving tag examples inside a large embedded UI', async () => {
    const source = await fs.readFile(new URL('../server/public/scripts/extensions/regex/engine.js', import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('export function getRegexedString(')).replaceAll('export ', '');
    const ui = html.replaceAll('$1', 'capture');
    const scripts = [
        { findRegex: '<ui/>', replaceString: '```html\n' + ui + '```\n' },
        { findRegex: '<thinking>[\\s\\S]*?</thinking>', replaceString: '' },
    ].map(x => ({ ...x, markdownOnly: true, placement: [2], substituteRegex: 0, trimStrings: [] }));
    const context = vm.createContext({
        protectAndroidHtmlBlocks, window: { AndroidHost: {} }, extension_settings: { disabledExtensions: [] },
        getRegexScripts: () => scripts, RegexProvider: { instance: { get: s => new RegExp(s, 'g') } },
        substitute_find_regex: { NONE: 0 }, substituteParams: x => x,
    });
    vm.runInContext(code, context);
    const raw = '<ui/>\n<thinking>raw private thought</thinking>';
    const result = context.getRegexedString(raw, 2, { isMarkdown: true });
    assert.ok(result.includes(ui));
    assert.ok(!result.includes('raw private thought'));
    assert.equal(context.getRegexedString(raw, 2, { isPrompt: true }), raw);
    context.window.AndroidHost = undefined;
    assert.ok(!context.getRegexedString(raw, 2, { isMarkdown: true }).includes('<thinking>literal</thinking>'));
});

const chrome = [process.env.ST_TEST_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && existsSync(file));

test('actual message formatter renders multi-megabyte unterminated HTML as inert code with bounded heap', { skip: !chrome && 'Chromium is required' }, async t => {
    const source = (await fs.readFile(new URL('../server/public/script.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    const start = source.indexOf('export function messageFormatting(');
    const formatting = source.slice(start, source.indexOf('\n/**', start)).replace('export ', '');
    const processorStart = source.indexOf('export function reloadMarkdownProcessor(');
    const processor = source.slice(processorStart, source.indexOf('\nexport function getCurrentChatId(', processorStart)).replace('export ', '');
    const harness = `import {protectAndroidHtmlBlocks} from '/blocks.js';
        import {markdownUnderscoreExt} from '/underscore.js'; import {addShowdownPatch} from '/patch.js';
        window.AndroidHost={}; let mesForShowdownParse, converter;
        const power_user={reasoning:{prefix:'',suffix:''},allow_name2_display:true};
        const chat=[], COMMENT_NAME_DEFAULT='comment',systemUserName='system',substituteParams=x=>x,getMessageDepth=()=>0,getRegexedString=x=>x,regex_placement={AI_OUTPUT:2};
        const encodeStyleTags=x=>x,decodeStyleTags=x=>x,markdownExclusionExt=()=>[];
        const MessageFormatter={stage:{},runStage:(_,text)=>text};
        ${processor} ${formatting}
        addShowdownPatch(showdown); reloadMarkdownProcessor();
        window.formatFixture=input=>{const output=messageFormatting(input,'test',false,false,1);document.querySelector('#result').innerHTML=output;
            return {code:document.querySelector('#result code')?.textContent,escaped:!document.querySelector('#result script'),ran:!!window.payloadRan};};window.ready=true;`;
    const files = new Map([
        ['/blocks.js', await fs.readFile(new URL('../server/public/scripts/android-html-blocks.js', import.meta.url))],
        ['/underscore.js', await fs.readFile(new URL('../server/public/scripts/showdown-underscore.js', import.meta.url))],
        ['/patch.js', await fs.readFile(new URL('../server/public/scripts/util/showdown-patch.js', import.meta.url))],
        ['/showdown.js', await fs.readFile(new URL('../server/node_modules/showdown/dist/showdown.min.js', import.meta.url))],
        ['/purify.js', await fs.readFile(new URL('../server/node_modules/dompurify/dist/purify.min.js', import.meta.url))],
        ['/harness.js', harness],
    ]);
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/html');
        res.end(files.get(req.url) || '<!doctype html><div id="result"></div><script src="/showdown.js"></script><script src="/purify.js"></script><script type="module" src="/harness.js"></script>');
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');t.after(() => { server.closeAllConnections();server.close(); });
    const base = path.resolve('.local/tests');await fs.mkdir(base, { recursive: true });
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--js-flags=--max-old-space-size=256'], userDataDir: await fs.mkdtemp(path.join(base, 'html-')) });
    t.after(() => browser.close());
    const page = await browser.newPage();const errors=[];page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:' + server.address().port);await page.waitForFunction(() => window.ready);
    const payload = '<!doctype html><html><script>window.payloadRan=true;\n' + 'const label = "_text_ <thinking>literal</thinking> &amp;";\n'.repeat(90000) + '</script></html>\n';
    for (const closing of ['', '```\n']) {
        const result = await page.evaluate(input => window.formatFixture(input), '```html\n' + payload + closing);
        assert.equal(result.code, payload);assert.equal(result.escaped, true);assert.equal(result.ran, false);
    }
    assert.deepEqual(errors, []);
    const cdp = await page.createCDPSession();await cdp.send('HeapProfiler.collectGarbage');await cdp.send('Performance.enable');
    const metrics = (await cdp.send('Performance.getMetrics')).metrics;
    assert.ok(metrics.find(x => x.name === 'JSHeapUsedSize').value < 128 * 1024 * 1024);
});
