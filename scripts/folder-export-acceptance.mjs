import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'http://127.0.0.1:17614';
const DIST = '/scripts/extensions/third-party/JS-Slash-Runner/dist/index.js';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

export function createFixture(runId, variant) {
    assert.match(runId, /^[a-f0-9]{12}$/); assert.ok(['data', 'buttons'].includes(variant));
    return { type: 'folder', id: crypto.randomUUID(), name: `FolderAcceptance-${runId}-${variant}`, enabled: false, icon: 'fa-solid fa-folder', color: '#abc123', scripts: [{
        type: 'script', id: crypto.randomUUID(), name: 'Synthetic child ' + variant, enabled: false, content: '// Acceptance only; never enabled.', info: '',
        data: { marker: runId, payload: '中文😀' + 'x'.repeat(70000) },
        button: { enabled: true, buttons: [{ name: 'Synthetic button ' + runId, visible: true }] }, export_with: { data: true, button: true },
    }] };
}

export function assertExport(value, fixture, included) {
    assert.equal(value.type, 'folder'); assert.equal(value.name, fixture.name); assert.equal(value.id, fixture.id);
    assert.equal(value.scripts.length, 1);
    const script = value.scripts[0], original = fixture.scripts[0];
    assert.equal(script.id, original.id); assert.equal(script.content, original.content);
    assert.deepEqual(script.data, included.data ? original.data : {});
    assert.deepEqual(script.button.buttons, included.buttons ? original.button.buttons : []);
    assert.equal(script.export_with.data, included.data); assert.equal(script.export_with.button, included.buttons);
}

// Desktop protocol probe only: this object never writes to an Android filesystem.
// Installed before the real adapter loads so its original onmessage wiring is exercised.
export function desktopBridgeProbe() {
    const entries = new Map();
    window.__folderBridge = { calls: [], exports: [], nativeDiskWrite: false };
    window.AndroidHost = { postMessage(raw) {
        const { id, method, data } = JSON.parse(raw);
        window.__folderBridge.calls.push(method);
        let result = true, error;
        try {
            if (method === 'download.begin') {
                result = crypto.randomUUID(); entries.set(result, { name: data.name, mime: data.mime, chunks: [] });
            } else if (method === 'download.chunk') entries.get(data.downloadId).chunks.push(data.base64);
            else if (method === 'download.finish') { window.__folderBridge.exports.push(entries.get(data.downloadId)); entries.delete(data.downloadId); }
            else if (method === 'download.cancel') entries.delete(data.downloadId);
            else throw new Error('Unsupported desktop fixture bridge method');
        } catch (failure) { error = failure.message; }
        queueMicrotask(() => window.AndroidHost.onmessage({ data: JSON.stringify({ id, ok: !error, result, error }) }));
    } };
}

export function controlledDownloadPath(name, runId, variant) {
    assert.match(runId, /^[a-f0-9]{12}$/); assert.ok(['data', 'buttons'].includes(variant));
    assert.ok(typeof name === 'string' && /^[\p{L}\p{N}_. ()-]+$/u.test(name), 'Invalid synthetic download filename');
    assert.ok(name.endsWith(`FolderAcceptance-${runId}-${variant}.json`), 'Only this invocation\'s synthetic export may be read');
    return '/sdcard/Download/SillyTavern/' + name;
}
export const quoteShell = value => "'" + value.replaceAll("'", "'\\''") + "'";

export async function waitForAcceptanceReady(page) {
    await page.waitForFunction(() => window.SillyTavern?.getContext, { timeout: 90000 });
    // The helper is registered during getSettings, before the core finishes firstLoadInit.
    // Closing its loader dialog would strand #preloader and invalidate pointer testing.
    await page.waitForSelector('#preloader', { hidden: true, timeout: 90000 });
    await page.waitForSelector('#loader', { hidden: true, timeout: 90000 });
    const onboarding = 'dialog[open]:has(.onboarding)';
    // getSettings hides the splash before creating onboarding; await either branch.
    await page.waitForFunction(async () => document.querySelector('dialog[open]:has(.onboarding)') || (await import('/script.js')).settingsReady, { timeout: 90000 });
    let completedOnboarding = false;
    if (await page.$(onboarding)) {
        await page.waitForSelector(onboarding + ' .popup-input', { visible: true });
        // First-run persona is fixture setup, not an input-method acceptance case.
        // Avoid autofocus/selection animation races while keeping real confirmation.
        await page.$eval(onboarding + ' .popup-input', input => {
            input.value = 'Synthetic acceptance';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        assert.equal(await page.$eval(onboarding + ' .popup-input', input => input.value), 'Synthetic acceptance');
        await page.locator(onboarding + ' .popup-button-ok').click();
        await page.waitForSelector(onboarding, { hidden: true });
        completedOnboarding = true;
    }
    await page.waitForFunction(async () => (await import('/script.js')).settingsReady, { timeout: 90000 });
    await page.waitForSelector('#preloader', { hidden: true, timeout: 90000 });
    await page.waitForSelector('#loader', { hidden: true, timeout: 90000 });
    if (completedOnboarding) {
        const name = await page.evaluate(async () => {
            const core = await import('/script.js');
            await core.saveSettings();
            return SillyTavern.getContext().name1;
        });
        assert.equal(name, 'Synthetic acceptance', 'Synthetic persona must be saved with the exact fixture name');
    }
    return { completedOnboarding };
}

export async function runFolderUi(page, { runId, mode, device, report, evidenceDirectory }) {
    const readiness = await waitForAcceptanceReady(page);
    report.checks.push({ id: 'application-ready', passed: true, required: true, description: 'Core settings initialized and startup overlays absent before real pointer interaction', ...readiness });
    await page.waitForFunction(() => window.STAndroid?.exportBlob && window.TavernHelper?.replaceScriptTrees, { timeout: 90000 });
    const fixtures = [createFixture(runId, 'data'), createFixture(runId, 'buttons')];
    const original = await page.evaluate(fixtures => {
        const original = TavernHelper.getScriptTrees({ type: 'global' });
        TavernHelper.replaceScriptTrees([...original, ...fixtures], { type: 'global' });
        window.__folderExports = [];
        window.__originalFolderExportBlob = STAndroid.exportBlob;
        STAndroid.exportBlob = async (blob, name) => {
            const record = { name, mime: blob.type, text: await blob.text(), completed: false };
            window.__folderExports.push(record);
            try { await window.__originalFolderExportBlob(blob, name); record.completed = true; }
            catch (error) { record.error = error.message; throw error; }
        };
        return original;
    }, fixtures);
    try {
        if (!(await page.$eval('#rm_extensions_block', element => element.getClientRects().length > 0))) await page.click('#extensions-settings-button .drawer-toggle');
        await page.waitForSelector('#tavern_helper .inline-drawer-toggle', { visible: true });
        if (!(await page.$eval('#tavern_helper .inline-drawer-content', element => element.getClientRects().length > 0))) await page.click('#tavern_helper .inline-drawer-toggle');
        await page.click('#tavern_helper .fa-dice-d6');
        for (const [index, fixture] of fixtures.entries()) {
            const variant = index === 0 ? 'data' : 'buttons';
            const selector = `[data-folder-id="${fixture.id}"] .fa-file-export`;
            await page.waitForSelector(selector, { visible: true }); await page.click(selector);
            const popup = '.TH-popup [role="dialog"]';
            await page.waitForSelector(popup + ' input[type="checkbox"]', { visible: true });
            const boxes = await page.$$(popup + ' input[type="checkbox"]');
            assert.equal(boxes.length, 2, 'The actual folder dialog must render two independent checkboxes');
            assert.deepEqual(await Promise.all(boxes.map(box => box.evaluate(element => element.checked))), [true, true]);
            // Real pointer clicks, not assignment to Vue state or checkbox.checked.
            await boxes[index === 0 ? 1 : 0].click();
            const state = await Promise.all(boxes.map(box => box.evaluate(element => element.checked)));
            assert.deepEqual(state, index === 0 ? [true, false] : [false, true]);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            let screenshot;
            if (evidenceDirectory) {
                screenshot = path.join(evidenceDirectory, `folder-export-${runId}-${variant}.png`);
                await fs.mkdir(evidenceDirectory, { recursive: true });
                await page.screenshot({ path: screenshot });
            }
            await page.click(popup + ' .popup-button-ok');
            await page.waitForFunction(index => window.__folderExports[index]?.completed || window.__folderExports[index]?.error, { timeout: 45000 }, index);
            const exported = await page.evaluate(index => window.__folderExports[index], index);
            assert.equal(exported.error, undefined, 'Actual exportBlob failed'); assert.equal(exported.completed, true);
            assertExport(JSON.parse(exported.text), fixture, { data: index === 0, buttons: index === 1 });
            let written;
            if (mode === 'desktop') {
                const bridge = await page.evaluate(index => window.__folderBridge.exports[index], index);
                assert.equal(bridge.name, exported.name); assert.equal(bridge.mime, 'application/json');
                written = Buffer.concat(bridge.chunks.map(chunk => Buffer.from(chunk, 'base64')));
                if (index === 0) assert.ok(bridge.chunks.length > 1, 'Large variable payload must use multiple real adapter chunks');
            } else {
                const destination = controlledDownloadPath(exported.name, runId, variant);
                // exec-out passes argv directly: a shell must interpret the path quotes.
                written = device.bytes('exec-out', 'sh', '-c', 'cat ' + quoteShell(destination));
                report.downloadPaths ||= []; report.downloadPaths.push(destination);
            }
            assert.equal(written.toString('utf8'), exported.text, 'Bridge output must exactly match the selected export JSON');
            assertExport(JSON.parse(written), fixture, { data: index === 0, buttons: index === 1 });
            const current = await page.evaluate(id => TavernHelper.getScriptTrees({ type: 'global' }).find(folder => folder.id === id), fixture.id);
            assert.deepEqual(current.scripts[0].data, fixture.scripts[0].data);
            assert.deepEqual(current.scripts[0].button, fixture.scripts[0].button);
            assert.deepEqual(current.scripts[0].export_with, { data: true, button: true });
            report.checks.push({ id: 'folder-' + variant, passed: true, required: true, description: `${mode === 'android' ? 'Native saved JSON' : 'Desktop captured bridge JSON'} preserves only selected ${variant}; source script stays unchanged`, bytes: written.length, sha256: hash(written), filename: exported.name, checkboxState: state, screenshot });
            console.log('PASS folder-' + variant);
        }
        report.transport = mode === 'desktop' ? { nativeDiskWrite: false, ...await page.evaluate(() => ({ calls: window.__folderBridge.calls, pending: STAndroid.diagnostics().pendingHostCalls })) } : { nativeDiskWrite: true, verifiedBy: 'adb exec-out cat of two exact generated Download/SillyTavern files' };
        if (mode === 'desktop') assert.equal(report.transport.pending, 0, 'Completed downloads must leave no pending host calls');
    } finally {
        const restored = await page.evaluate(original => {
            TavernHelper.replaceScriptTrees(original, { type: 'global' });
            if (window.__originalFolderExportBlob) STAndroid.exportBlob = window.__originalFolderExportBlob;
            delete window.__originalFolderExportBlob;
            return TavernHelper.getScriptTrees({ type: 'global' });
        }, original);
        assert.deepEqual(restored, original, 'Original global script trees must be restored after the fixture');
        report.checks.push({ id: 'fixture-cleanup', passed: true, required: true, description: 'Original global script store restored and compared after synthetic fixture removal' });
    }
}

export async function runAcceptance(options, { root = path.resolve(import.meta.dirname, '..') } = {}) {
    const puppeteer = createRequire(path.join(root, 'package.json'))('puppeteer-core');
    const helper = await import(pathToFileURL(path.join(root, 'scripts/android-test-tools.mjs')));
    const { assertDebugIdentity } = await import(pathToFileURL(path.join(root, 'scripts/application-acceptance.mjs')));
    const { getSourceHash } = await import(pathToFileURL(path.join(root, 'scripts/source-inventory.mjs')));
    const app = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const core = JSON.parse(await fs.readFile(path.join(root, 'server/package.json'), 'utf8'));
    const bundle = path.join(root, 'server/android/bundled-extensions/JS-Slash-Runner');
    const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    const bundleHash = hash(await fs.readFile(path.join(bundle, 'dist/index.js')));
    const runId = crypto.randomBytes(6).toString('hex');
    console.log('Checking source identity before folder UI acceptance');
    const report = { appVersion: app.version, coreVersion: core.version, nodeVersion: process.version, sourceHash: await getSourceHash(root), runtimeSha256: null, mode: options.mode, device: options.serial || 'desktop-chrome', runId, passed: false, checks: [], errors: [], coverage: { nativeDiskWrite: options.mode === 'android' ? 'required' : 'not-run: desktop captures the real adapter protocol using an explicit synthetic bridge', runtimeArtifact: options.mode === 'android' ? 'required: exact installed Debug APK and deployed runtime' : 'not-run: desktop serves workspace files directly; runtimeSha256 is null', api: 'no model calls' } };
    let browser, page, device;
    const loaded = [];
    const captureDist = response => {
        if (new URL(response.url()).pathname !== DIST) return;
        void response.buffer().then(bytes => loaded.push({ sha256: hash(bytes), status: response.status() }), error => report.errors.push(error.message));
    };
    const observePage = page => {
        page.on('dialog', dialog => { report.errors.push(dialog.message()); void dialog.accept(); });
        page.on('pageerror', error => report.errors.push(error.message));
        page.on('console', message => {
            if (['error', 'warn'].includes(message.type())) {
                report.consoleDiagnostics ||= [];
                report.consoleDiagnostics.push({ level: message.type(), message: message.text().slice(0, 500) });
            }
        });
        page.on('response', captureDist);
    };
    try {
        if (options.mode === 'desktop') {
            const file = await fs.realpath(options.tokenFile), local = await fs.realpath(path.join(root, '.local'));
            assert.ok(file.startsWith(local + path.sep), 'Desktop test token must be in the workspace .local fixture tree');
            const token = (await fs.readFile(file, 'utf8')).trim(); assert.match(token, /^[a-f0-9]{64}$/);
            browser = await puppeteer.launch({ executablePath: process.env.ST_CHROME_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: path.join(root, '.local/folder-export-browser', runId), args: ['--no-first-run'] });
            await browser.setCookie({ name: 'st_android_auth', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' });
            page = await browser.newPage(); observePage(page); await page.setViewport({ width: 1280, height: 1000 });
            await page.evaluateOnNewDocument(desktopBridgeProbe);
            await page.goto(ORIGIN, { waitUntil: 'networkidle2', timeout: 90000 });
        } else {
            Object.assign(report, await helper.readBuildIdentity(root)); report.driverNodeVersion = process.version;
            const { readApkRuntime } = await import(pathToFileURL(path.join(root, 'scripts/release-upgrade-acceptance.mjs')));
            const runtime = await readApkRuntime(options.apk, root);
            device = helper.createAndroidDevice({ root, serial: options.serial, packageName: 'io.sillytavern.standalone.debug' });
            assert.equal(device.text('shell', 'getprop', 'ro.kernel.qemu'), '1');
            report.apkSha256 = await helper.verifyInstalledApk(device, options.apk);
            assertDebugIdentity(runtime, report, device.text('shell', 'dumpsys', 'package', device.packageName));
            device.start(); await helper.until(() => device.nativeStatus().ready, 180000);
            assert.equal(device.readPrivate(`runtimes/${runtime.runtimeSha256}/.complete`), runtime.runtimeSha256);
            report.checks.push({ id: 'android-artifact-identity', passed: true, required: true, description: 'Installed Debug APK SHA/version/code, embedded runtime and deployed completion marker match the current build' });
            const pid = device.text('shell', 'pidof', device.packageName); assert.match(pid, /^\d+$/);
            const port = device.forward('localabstract:webview_devtools_remote_' + pid);
            browser = await helper.until(() => puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }), 90000);
            page = await helper.until(async () => (await browser.pages()).find(page => page.url().startsWith(ORIGIN + '/')));
            observePage(page); await page.setCacheEnabled(false);
            await page.reload({ waitUntil: 'networkidle2', timeout: 90000 });
        }
        await page.waitForFunction(() => window.TavernHelper && window.STAndroid, { timeout: 90000 });
        await helper.until(() => loaded.length, 30000);
        assert.ok(loaded.some(response => response.status === 200 && response.sha256 === bundleHash), 'The actual loaded helper dist differs from the reviewed bundle');
        report.loadedHelper = { ...manifest, distSha256: bundleHash, runtimeVersion: await page.evaluate(() => TavernHelper.getTavernHelperVersion()) };
        assert.equal(report.loadedHelper.runtimeVersion, manifest.version);
        report.checks.push({ id: 'loaded-helper-dist', passed: true, required: true, description: 'Actual browser-loaded helper dist bytes match the current bundled file', sha256: bundleHash, androidPatchRevision: manifest.androidPatchRevision });
        await runFolderUi(page, { runId, mode: options.mode, device, report, evidenceDirectory: path.join(root, 'docs/acceptance') });
        assert.deepEqual(report.errors, [], 'Unexpected uncaught browser errors or dialogs during the real folder export flow');
        report.checks.push({ id: 'uncaught-browser-errors', passed: true, required: true, description: 'No uncaught browser exceptions or unexpected JavaScript dialogs from navigation through both exports' });
        const screenshot = path.join(root, 'docs/acceptance', `folder-export-${runId}.png`);
        await fs.mkdir(path.dirname(screenshot), { recursive: true }); await page.screenshot({ path: screenshot }); report.screenshot = screenshot;
        report.sourceHashAfter = await getSourceHash(root);
        assert.equal(report.sourceHashAfter, report.sourceHash, 'Workspace source changed during folder export acceptance');
        report.checks.push({ id: 'source-stability', passed: true, required: true, description: 'Source identity unchanged during browser evidence collection' });
        report.passed = true;
    } catch (error) {
        report.error = error.message;
        if (page) {
            const screenshot = path.join(root, 'docs/acceptance', `folder-export-${runId}-failure.png`);
            await fs.mkdir(path.dirname(screenshot), { recursive: true });
            await page.screenshot({ path: screenshot }).then(() => { report.failureScreenshot = screenshot; }, failure => { report.errors.push('Failure screenshot: ' + failure.message); });
        }
        throw error;
    }
    finally {
        if (page) { page.off('response', captureDist); if (options.mode === 'android') await page.setCacheEnabled(true).catch(() => {}); }
        if (browser) options.mode === 'android' ? browser.disconnect() : await browser.close();
        device?.close();
        report.reportPath = await helper.writeAcceptanceReport(root, 'folder-export-' + options.mode, report);
        console.log(JSON.stringify({ passed: report.passed, report: report.reportPath, coverage: report.coverage }, null, 2));
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    // application-acceptance imports waitForAcceptanceReady from this module.
    // Finish evaluating our exports before loading its shared CLI helpers.
    void import('./application-acceptance.mjs')
        .then(({ parseArgs }) => runAcceptance(parseArgs(process.argv.slice(2))))
        .catch(error => { console.error(error); process.exitCode = 1; });
}
