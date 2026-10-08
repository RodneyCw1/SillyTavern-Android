import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const root = path.resolve(import.meta.dirname, '..');
const token = fs.readFileSync(path.join(root, '.local/desktop-data/session-token'), 'utf8');
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: path.join(root, '.local/browser-test'), args: ['--no-first-run', '--no-default-browser-check'] });
const errors = [], requests = [];
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await browser.setCookie({ name: 'st_android_auth', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 500)); });
    page.on('requestfailed', request => requests.push({ url: request.url().split('?')[0], error: request.failure()?.errorText }));
    await page.goto('http://127.0.0.1:17614/', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => !!window.SillyTavern?.getContext?.(), { timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));
    const plugins = await page.evaluate(async () => {
        const results = [];
        for (const name of ['JS-Slash-Runner', 'opening-preset-forge', 'ST-Prompt-Template']) {
            const base = '/scripts/extensions/third-party/' + name + '/';
            const manifest = await (await fetch(base + 'manifest.json')).json();
            try { await import(base + manifest.js); results.push({ name, version: manifest.version, loaded: true }); }
            catch (error) { results.push({ name, version: manifest.version, loaded: false, error: error.message }); }
        }
        return results;
    });
    const state = await page.evaluate(() => ({ title: document.title, tavernHelper: typeof window.TavernHelper, androidTransport: typeof window.STAndroid, text: document.body.innerText.slice(-1500) }));
    await fsp.mkdir(path.join(root, 'docs/screenshots'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'docs/screenshots/desktop-mobile-view.png'), fullPage: false });
    const report = { plugins, errors, failedRequests: requests, state };
    await fsp.writeFile(path.join(root, 'docs/browser-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (plugins.some(p => !p.loaded) || errors.length) process.exitCode = 1;
} finally { await browser.close(); }
