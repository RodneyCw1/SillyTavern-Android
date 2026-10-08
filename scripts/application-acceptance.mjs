import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { waitForAcceptanceReady } from './folder-export-acceptance.mjs';

const ORIGIN = 'http://127.0.0.1:17614';
export function parseArgs(args) {
    const result = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--synthetic-data' && !result.syntheticData) { result.syntheticData = true; continue; }
        const key = ({ '--desktop-token-file': 'tokenFile', '--serial': 'serial', '--apk': 'apk' })[args[i]];
        if (!key || result[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown, repeated or incomplete acceptance arguments');
        result[key] = args[++i];
    }
    if (!result.syntheticData) throw new Error('Explicit --synthetic-data acknowledgement is required');
    if (result.tokenFile && !result.serial && !result.apk) return { ...result, mode: 'desktop', tokenFile: path.resolve(result.tokenFile) };
    if (!result.tokenFile && /^emulator-\d+$/.test(result.serial || '') && result.apk) return { ...result, mode: 'android', apk: path.resolve(result.apk) };
    throw new Error('Choose --desktop-token-file PATH or --serial emulator-N --apk DEBUG_APK');
}

export async function startMockModel() {
    const queue = [], calls = [];
    const server = http.createServer(async (req, res) => {
        try {
            let raw = '';
            for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 4 * 1024 ** 2) throw new Error('Fixture request too large'); }
            if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'acceptance-mock' }] })); return; }
            if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
            if (!queue.length) { res.writeHead(409); res.end('No queued synthetic response'); return; }
            const request = JSON.parse(raw), output = queue.shift();
            calls.push({ stream: !!request.stream, textLength: output.length });
            if (!request.stream) {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: output }, finish_reason: 'stop' }], usage: { total_tokens: 10 } }));
            } else {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: output.slice(0, 4) } }] }) + '\n\n');
                setTimeout(() => res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: output.slice(4) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'), 30);
            }
        } catch (error) { res.writeHead(400); res.end(error.message); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return { port: server.address().port, url: `http://127.0.0.1:${server.address().port}/v1`, calls, enqueue: text => queue.push(text),
        close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

export function assertRecoveryResult(result, expected) {
    assert.equal(result.text, expected.text, 'The entire original and recovered reply must survive');
    assert.equal(result.length, expected.length, 'Recovery must not duplicate a message');
    for (const key of ['acknowledged', 'restored', 'complete']) assert.equal(result[key], true, `Recovery ${key}`);
}

export function isRestoredJobSave(pathname, body, id) {
    if (pathname !== '/api/chats/save') return false;
    try { return JSON.parse(body).chat?.some(message => message.extra?.android_job_id === id && message.extra?.android_job_restored === true) === true; }
    catch { return false; }
}

export function assertDebugIdentity(runtime, expected, packageDump) {
    for (const key of ['appVersion', 'sourceHash', 'runtimeSha256']) assert.equal(runtime[key], expected[key], 'Embedded APK runtime mismatch: ' + key);
    assert.equal(runtime.appVersion, '1.1.3');
    assert.match(packageDump, /versionCode=6\b/);
    assert.match(packageDump, /versionName=1\.1\.3\b/);
    assert.match(packageDump, /(?:pkgFlags|flags)=\[[^\]]*\bDEBUGGABLE\b/);
}

export async function runBrowserCore(page, model, modelUrl, report) {
    const check = (id, description, evidence = {}) => { report.checks.push({ id, passed: true, required: true, description, ...evidence }); console.log('PASS ' + id); };
    const names = ['A', 'B'].map(letter => `Acceptance-${report.runId}-${letter}`);
    await waitForAcceptanceReady(page);
    await page.waitForFunction(() => window.STAndroid && window.SillyTavern?.getContext && window.TavernHelper?.generateRaw, { timeout: 90000 });
    const original = await page.evaluate(async ({ names, modelUrl }) => {
        const ctx = SillyTavern.getContext();
        const saved = { completion: structuredClone(ctx.chatCompletionSettings), summary: ctx.extensionSettings.openingPresetForge?.summary?.enabled };
        for (const name of names) {
            const response = await fetch('/api/characters/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ ch_name: name, file_name: name, description: 'Synthetic acceptance data only', first_mes: '合成角色😀' }) });
            if (!response.ok) throw new Error('Fixture creation failed: ' + response.status);
        }
        await ctx.getCharacters();
        await ctx.selectCharacterById(SillyTavern.getContext().characters.findIndex(character => character.avatar === names[0] + '.png'));
        $('#main_api').val('openai').trigger('change');
        Object.assign(ctx.chatCompletionSettings, { chat_completion_source: 'custom', custom_url: modelUrl, custom_model: 'acceptance-mock', stream_openai: false });
        if (ctx.extensionSettings.openingPresetForge?.summary) ctx.extensionSettings.openingPresetForge.summary.enabled = false;
        window.__acceptanceEvents = 0;
        window.__acceptanceReceived = () => window.__acceptanceEvents++;
        ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, window.__acceptanceReceived);
        return saved;
    }, { names, modelUrl });
    const select = async name => {
        await page.evaluate(async name => {
            document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
            const ctx = SillyTavern.getContext();
            await ctx.selectCharacterById(ctx.characters.findIndex(character => character.avatar === name + '.png'));
        }, name);
        await page.waitForFunction(name => { const ctx = SillyTavern.getContext(); return ctx.characters[ctx.characterId]?.avatar === name + '.png' && ctx.chat.length > 0; }, {}, name);
    };
    const inspectRecovery = id => page.evaluate(async id => {
        const ctx = SillyTavern.getContext(), message = ctx.chat.at(-1);
        const job = await (await fetch('/api/android/jobs/' + id)).json();
        return { length: ctx.chat.length, text: message.mes, acknowledged: job.acknowledged, restored: !!message.extra?.android_job_restored, complete: !!message.extra?.android_job_complete, events: window.__acceptanceEvents };
    }, id);
    const recover = async id => {
        await page.evaluate(() => STAndroid.showRecovery());
        await page.click(`[data-job-id="${id}"] > button`);
        await page.waitForFunction(id => [...document.querySelectorAll(`[data-job-id="${id}"] button`)].some(button => button.textContent === '恢复到原聊天'), {}, id);
        await page.evaluate(id => {
            const button = [...document.querySelectorAll(`[data-job-id="${id}"] button`)].find(button => button.textContent === '恢复到原聊天');
            button.id = 'acceptance-restore'; button.click();
        }, id);
        await page.waitForFunction(() => !document.querySelector('#acceptance-restore') || !document.querySelector('#acceptance-restore').disabled, { timeout: 90000 });
    };
    try {
        await select(names[0]);
        for (const stream of [false, true]) {
            const output = `普通生成 stream=${stream} 中文😀`;
            model.enqueue(output);
            const result = await page.evaluate(async stream => {
                const ctx = SillyTavern.getContext(); ctx.chatCompletionSettings.stream_openai = stream;
                const core = await import('/script.js'); core.setOnlineStatus('acceptance-mock');
                const before = ctx.chat.length, events = window.__acceptanceEvents;
                $('#send_textarea').val('仅本地合成验收');
                await ctx.generate('normal'); await SillyTavern.getContext().saveChat();
                const after = SillyTavern.getContext();
                return { before, after: after.chat.length, text: after.chat.at(-1)?.mes, complete: after.chat.at(-1)?.extra?.android_job_complete, events: window.__acceptanceEvents - events };
            }, stream);
            assert.equal(result.after, result.before + 2); assert.equal(result.text, output); assert.equal(result.events, 1); assert.equal(result.complete, true);
            check(stream ? 'stream-generation' : 'ordinary-generation', 'Real generate, durable Android job, Unicode output, saved reply and one message event', { stream });
        }
        for (const stream of [false, true]) {
            model.enqueue('插件回复😀');
            const result = await page.evaluate(async stream => {
                const ctx = SillyTavern.getContext();
                const listener = async payload => { await new Promise(resolve => setTimeout(resolve, 25)); payload.message += ' asynchronous-before-end'; };
                ctx.eventSource.on('js_generation_before_end', listener);
                try { return await TavernHelper.generateRaw({ should_stream: stream, ordered_prompts: [{ role: 'user', content: 'Synthetic plugin fixture only' }] }); }
                finally { ctx.eventSource.removeListener('js_generation_before_end', listener); }
            }, stream);
            assert.equal(result, '插件回复😀 asynchronous-before-end');
            check(stream ? 'stream-plugin-before-end' : 'plugin-before-end', 'Actual bundled plugin waits for an asynchronous before_end mutation', { stream });
        }

        const originalText = '完整前文😀' + 'x'.repeat(64000);
        const continuedText = '续写😀' + 'y'.repeat(40000);
        model.enqueue(continuedText);
        const job = await page.evaluate(async ({ originalText, modelUrl }) => {
            const ctx = SillyTavern.getContext(), message = ctx.chat.at(-1);
            message.mes = originalText; await ctx.saveChat();
            const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(originalText));
            const previousMessage = { index: ctx.chat.length - 1, length: originalText.length, sha256: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''), swipeId: message.swipe_id ?? 0, sendDate: message.send_date ?? null, name: message.name ?? null, isUser: !!message.is_user, isSystem: !!message.is_system };
            const id = crypto.randomUUID();
            const response = await fetch('/api/android/jobs', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ id, endpoint: '/api/backends/chat-completions/generate', body: { chat_completion_source: 'custom', custom_url: modelUrl, model: 'acceptance-mock', messages: [{ role: 'user', content: 'Synthetic continuation' }], stream: false }, context: { version: 2, provider: 'custom', type: 'continue', avatar: ctx.characters[ctx.characterId].avatar, groupId: null, chatId: ctx.chatId, name: ctx.name2, chatLength: ctx.chat.length, previousMessage } }) });
            if (!response.ok) throw new Error(await response.text());
            return { id, length: ctx.chat.length };
        }, { originalText, modelUrl });
        await page.waitForFunction(async id => (await (await fetch('/api/android/jobs/' + id)).json()).state === 'complete', { timeout: 90000 }, job.id);
        await select(names[1]);
        const otherBefore = await page.evaluate(() => JSON.stringify(SillyTavern.getContext().chat));
        await recover(job.id);
        assert.equal(await page.evaluate(() => JSON.stringify(SillyTavern.getContext().chat)), otherBefore);
        assert.equal((await inspectRecovery(job.id)).acknowledged, false);
        check('wrong-character-conflict', 'Recovering while another synthetic character is selected leaves its chat unchanged');
        await select(names[0]);
        await page.evaluate(async () => { const ctx = SillyTavern.getContext(); ctx.chat.at(-1).mes += ' changed'; await ctx.saveChat(); });
        await recover(job.id);
        assert.equal((await inspectRecovery(job.id)).acknowledged, false);
        assert.equal((await inspectRecovery(job.id)).text, originalText + ' changed');
        check('changed-source-conflict', 'Continuation with a changed source is refused and remains unacknowledged');
        await page.evaluate(async originalText => { const ctx = SillyTavern.getContext(); ctx.chat.at(-1).mes = originalText; await ctx.saveChat(); window.__acceptanceEvents = 0; }, originalText);
        let rejectSave = true;
        const requestFailure = request => {
            if (rejectSave && isRestoredJobSave(new URL(request.url()).pathname, request.postData(), job.id)) {
                rejectSave = false;
                request.respond({ status: 500, contentType: 'application/json', body: '{"error":"Synthetic one-shot save failure"}' });
            } else request.continue();
        };
        await page.setRequestInterception(true); page.on('request', requestFailure);
        try { await recover(job.id); }
        finally { page.off('request', requestFailure); await page.setRequestInterception(false); }
        assert.equal(rejectSave, false, 'The synthetic failure must reach this restored job save');
        const failed = await inspectRecovery(job.id);
        assert.equal(failed.acknowledged, false); assert.equal(failed.complete, false); assert.equal(failed.length, job.length); assert.equal(failed.events, 1);
        await recover(job.id);
        const saved = await inspectRecovery(job.id);
        assertRecoveryResult(saved, { text: originalText + continuedText, length: job.length });
        assert.equal(saved.events, 1); assert.equal(model.calls.length, 5);
        check('long-recovery-save-retry', '64000-character source and 40000-character continuation survive save failure/retry without duplicate events or model calls', { textLength: saved.text.length, modelCalls: model.calls.length });
    } finally {
        await page.evaluate(saved => {
            document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
            const ctx = SillyTavern.getContext();
            Object.assign(ctx.chatCompletionSettings, saved.completion);
            if (ctx.extensionSettings.openingPresetForge?.summary) ctx.extensionSettings.openingPresetForge.summary.enabled = saved.summary;
            ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, window.__acceptanceReceived);
            delete window.__acceptanceReceived;
        }, original).catch(() => {});
    }
}

export async function runAcceptance(options, { root = path.resolve(import.meta.dirname, '..') } = {}) {
    const require = createRequire(path.join(root, 'package.json'));
    const puppeteer = require('puppeteer-core');
    const helper = await import(pathToFileURL(path.join(root, 'scripts/android-test-tools.mjs')));
    const { getSourceHash } = await import(pathToFileURL(path.join(root, 'scripts/source-inventory.mjs')));
    const app = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const core = JSON.parse(await fs.readFile(path.join(root, 'server/package.json'), 'utf8'));
    const runId = crypto.randomBytes(6).toString('hex');
    const report = { appVersion: app.version, coreVersion: core.version, nodeVersion: process.version, sourceHash: await getSourceHash(root), device: options.serial || 'desktop-chrome', mode: options.mode, scope: 'generation-recovery-plugin-callback-core', runId, passed: false, checks: [], errors: [], coverage: { nativeFolderExport: 'not-run: folder export options and native download bridge need a separate Android UI exercise', nativePicker: 'not-run', api: 'local synthetic mock only; no paid provider calls' } };
    const model = await startMockModel();
    let browser, device, page;
    try {
        let modelUrl = model.url;
        if (options.mode === 'desktop') {
            const file = await fs.realpath(options.tokenFile), local = await fs.realpath(path.join(root, '.local'));
            assert.ok(file.startsWith(local + path.sep), 'Desktop test token must be in this workspace .local fixture tree');
            const token = (await fs.readFile(file, 'utf8')).trim(); assert.match(token, /^[a-f0-9]{64}$/);
            browser = await puppeteer.launch({ executablePath: process.env.ST_CHROME_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: path.join(root, '.local/application-browser', runId), args: ['--no-first-run'] });
            await browser.setCookie({ name: 'st_android_auth', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' });
            page = await browser.newPage(); await page.goto(ORIGIN, { waitUntil: 'networkidle2', timeout: 90000 });
        } else {
            Object.assign(report, await helper.readBuildIdentity(root));
            report.driverNodeVersion = process.version;
            const { readApkRuntime } = await import(pathToFileURL(path.join(root, 'scripts/release-upgrade-acceptance.mjs')));
            const runtime = await readApkRuntime(options.apk, root);
            device = helper.createAndroidDevice({ root, serial: options.serial, packageName: 'io.sillytavern.standalone.debug' });
            assert.equal(device.text('shell', 'getprop', 'ro.kernel.qemu'), '1', 'Only a dedicated synthetic emulator is supported');
            report.apkSha256 = await helper.verifyInstalledApk(device, options.apk);
            assertDebugIdentity(runtime, report, device.text('shell', 'dumpsys', 'package', device.packageName));
            device.start(); await helper.until(() => device.nativeStatus().ready, 180000);
            assert.equal(device.readPrivate(`runtimes/${runtime.runtimeSha256}/.complete`), runtime.runtimeSha256);
            report.checks.push({ id: 'android-artifact-identity', passed: true, required: true, description: 'Installed Debug APK SHA/version/code, embedded runtime and deployed completion marker match the current build' });
            const pid = device.text('shell', 'pidof', device.packageName); assert.match(pid, /^\d+$/);
            const cdpPort = device.forward('localabstract:webview_devtools_remote_' + pid);
            modelUrl = `http://127.0.0.1:${device.reverse(model.port)}/v1`;
            browser = await helper.until(() => puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: null }), 90000);
            page = await helper.until(async () => (await browser.pages()).find(page => page.url().startsWith(ORIGIN + '/')), 90000);
        }
        page.on('dialog', dialog => { report.errors.push({ kind: 'dialog', message: dialog.message() }); void dialog.accept(); });
        page.on('pageerror', error => report.errors.push({ kind: 'pageerror', message: error.message }));
        await runBrowserCore(page, model, modelUrl, report);
        const screenshot = path.join(root, 'docs/acceptance', `application-${runId}.png`);
        await fs.mkdir(path.dirname(screenshot), { recursive: true }); await page.screenshot({ path: screenshot }); report.screenshot = screenshot;
        report.sourceHashAfter = await getSourceHash(root);
        assert.equal(report.sourceHashAfter, report.sourceHash, 'Workspace source changed during browser acceptance');
        report.checks.push({ id: 'source-stability', passed: true, required: true, description: 'Source identity unchanged while this browser evidence was collected' });
        report.passed = true;
    } catch (error) { report.error = error.message; throw error; }
    finally {
        if (browser) options.mode === 'android' ? browser.disconnect() : await browser.close();
        device?.close(); await model.close();
        report.reportPath = await helper.writeAcceptanceReport(root, options.mode === 'android' ? 'application-android' : 'application-desktop', report);
        console.log(JSON.stringify({ passed: report.passed, report: report.reportPath, coverage: report.coverage }, null, 2));
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runAcceptance(parseArgs(process.argv.slice(2)));
