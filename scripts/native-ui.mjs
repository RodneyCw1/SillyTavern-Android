import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { createAndroidDevice, readBuildIdentity, verifyInstalledApk, writeAcceptanceReport, until } from './android-test-tools.mjs';
import { waitForAcceptanceReady } from './folder-export-acceptance.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { serial: { type: 'string' }, package: { type: 'string' }, apk: { type: 'string' } } });
const report = { passed: false, checks: [], scope: 'Debug emulator WebView native UI; no Magic Compendium workflow claim' };
const check = (id, description) => report.checks.push({ id, description, required: true, passed: true });
let device, browser, failure;
try {
    Object.assign(report, await readBuildIdentity(root));
    device = createAndroidDevice({ root, serial: values.serial, packageName: values.package });
    report.device = device.serial;
    report.package = device.packageName;
    assert.equal(device.text('shell', 'getprop', 'ro.kernel.qemu'), '1', 'Use a disposable debug emulator.');
    report.apkSha256 = await verifyInstalledApk(device, path.resolve(values.apk || path.join(root, `releases/SillyTavern-Standalone-${report.appVersion}-debug.apk`)));
    device.start();
    const pid = await until(() => device.text('shell', 'pidof', device.packageName).split(/\s+/)[0]);
    assert.match(pid, /^\d+$/);
    const cdpPort = device.forward('localabstract:webview_devtools_remote_' + pid);
    browser = await until(() => puppeteer.connect({ browserURL: 'http://127.0.0.1:' + cdpPort, defaultViewport: null }));
    const page = await until(async () => (await browser.pages()).find(candidate => candidate.url().startsWith('http://127.0.0.1:17614/')));
    // Start with the normal chat surface, independent of a preceding plugin dialog.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    await waitForAcceptanceReady(page);
    await page.waitForFunction(() => !!window.STAndroid && !!window.SillyTavern.getContext(), { timeout: 30000 });
    const exportName = '中文文件验证-' + crypto.randomUUID() + '.txt';
    const exported = await page.evaluate(async name => {
        await STAndroid.host('clipboard.write', { text: '安卓剪贴板验证😀' });
        await STAndroid.exportBlob(new Blob(['中文导出😀'], { type: 'text/plain' }), name);
        return true;
    }, exportName);
    assert.equal(exported, true);
    assert.equal(device.text('shell', 'cat', '/sdcard/Download/SillyTavern/' + exportName), '中文导出😀');
    report.exportFile = exportName;
    check('export', 'Native clipboard write is acknowledged and a new Chinese filename exports UTF-8 correctly.');

    await page.evaluate(async () => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        for (const id of ['opf-root', 'opf-overlay']) { const element = document.getElementById(id); if (element) element.style.display = 'none'; }
        const context = SillyTavern.getContext();
        await context.getCharacters();
        if (SillyTavern.getContext().characters.length) await context.selectCharacterById(0);
        document.querySelector('#send_textarea')?.scrollIntoView();
    });
    const input = await page.waitForSelector('#send_textarea:not([disabled])', { timeout: 15000 });
    await input.tap();
    await until(() => /mInputShown=true|isInputViewShown=true/.test(device.text('shell', 'dumpsys', 'input_method')), 10000);
    report.layout = await page.evaluate(() => {
        const bounds = document.querySelector('#send_textarea').getBoundingClientRect();
        return { height: innerHeight, top: bounds.top, bottom: bounds.bottom };
    });
    assert.ok(report.layout.top >= 0 && report.layout.bottom <= report.layout.height + 2, JSON.stringify(report.layout));
    await fs.mkdir(path.join(root, 'docs/acceptance'), { recursive: true });
    const imageName = `native-ui-${report.appVersion}-${crypto.randomUUID()}`;
    report.screenshots = [`${imageName}-webview.png`, `${imageName}-screen.png`];
    await page.screenshot({ path: path.join(root, 'docs/acceptance', report.screenshots[0]) });
    await fs.writeFile(path.join(root, 'docs/acceptance', report.screenshots[1]), device.bytes('exec-out', 'screencap', '-p'), { flag: 'wx' });
    check('keyboard', 'The Android keyboard opens and the real chat input stays inside the resized WebView.');
    device.text('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await page.evaluate(() => STAndroid.showRecovery());
    await page.waitForSelector('#st-android-recovery[open]');
    device.text('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await page.waitForFunction(() => !document.querySelector('#st-android-recovery[open]'));
    check('back', 'Native Back closes the recovery dialog.');
    assert.equal((await readBuildIdentity(root)).sourceHash, report.sourceHash, 'Source changed during acceptance.');
    report.passed = true;
} catch (error) { report.error = error.message; failure = error; }
finally {
    browser?.disconnect();
    device?.close();
    const evidence = await writeAcceptanceReport(root, 'native-ui', report);
    console.log(JSON.stringify({ passed: report.passed, evidence, device: report.device, checks: report.checks }, null, 2));
}
if (failure) { console.error(failure.message); process.exitCode = 1; }
