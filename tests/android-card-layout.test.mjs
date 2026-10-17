import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import puppeteer from 'puppeteer-core';

const chrome = [process.env.ST_TEST_CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(file => file && existsSync(file));

test('Android cards fit narrow screens, dismiss stuck drawers and survive iframe navigation without changing other messages', { skip: !chrome && 'Chromium is required for layout acceptance' }, async t => {
    const source = await fs.readFile(new URL('../server/public/scripts/android-card-layout.js', import.meta.url), 'utf8');
    const fixture = await fs.readFile(new URL('./fixtures/embedded-card.html', import.meta.url), 'utf8');
    const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>*{box-sizing:border-box}body{margin:0}#chat .mes{display:flex;padding:8px 16px}
        .mesAvatarWrapper{width:64px;flex-shrink:0}.mes_block{flex:1;min-width:0;padding-left:16px}iframe{width:100%;height:650px;border:0}</style>
        <div id="chat"><div class="mes" id="ordinary"><div class="mesAvatarWrapper">Avatar</div><div class="mes_block">Regular message</div></div>
        <div class="mes" id="embedded"><div class="mesAvatarWrapper">Avatar</div><div class="mes_block"><iframe id="TH-message--0--0" src="/frame"></iframe></div></div>`;
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', req.url === '/layout.js' ? 'text/javascript' : 'text/html');
        res.end(req.url === '/layout.js' ? source : req.url === '/frame' ? fixture : html);
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = path.resolve('.local/tests');
    await fs.mkdir(base, { recursive: true });
    const profile = await fs.mkdtemp(path.join(base, 'card-layout-browser-'));
    let browser;
    t.after(async () => { await browser?.close(); await fs.rm(profile, { recursive: true, force: true }); });
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 360, height: 800 });
    await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'load' });
    const frame = page.frames().find(frame => frame.url().endsWith('/frame'));
    const clipped = await frame.evaluate(() => [...document.querySelectorAll('.mode-name,.mode-description')].some(e => {
        const text = e.getBoundingClientRect(), card = e.closest('.mode-card').getBoundingClientRect();
        return text.width < 60 || text.right > card.right || text.top < card.top || text.bottom > card.bottom;
    }));
    assert.equal(clipped, true, 'Fixture must reproduce squeezed or clipped text before adaptation');
    await frame.click('#open-left');
    await frame.click('#left-drawer .drawer-close span');
    assert.equal(await frame.$eval('#left-drawer', e => e.classList.contains('open')), true,
        'Fixture must reproduce a drawer that cannot close before adaptation');
    await page.evaluate(async () => (await import('/layout.js')).installAndroidCardLayout());

    await frame.click('#left-drawer .drawer-close span');
    assert.equal(await frame.$eval('#left-drawer', e => e.classList.contains('open')), false);
    assert.equal(await frame.$eval('.drawer-overlay', e => e.classList.contains('active')), false);
    assert.ok(await frame.$eval('#left-drawer .drawer-close', e => e.getBoundingClientRect().width >= 44));
    for (let cycle = 0; cycle < 3; cycle++) {
        await frame.click('#open-left');
        assert.equal(await frame.$eval('#left-drawer', e => e.classList.contains('open')), true);
        await frame.click('.drawer-overlay', { offset: { x: 310, y: 200 } });
        assert.equal(await frame.$eval('#left-drawer', e => e.classList.contains('open')), false);
    }
    await frame.evaluate(() => {
        document.getElementById('left-drawer').classList.add('open');
        document.getElementById('right-drawer').classList.add('open');
        document.querySelector('.drawer-overlay').classList.add('active');
    });
    await frame.click('#left-drawer .drawer-close');
    assert.equal(await frame.$eval('.drawer-overlay', e => e.classList.contains('active')), true,
        'Closing one panel must retain the overlay while the other is open');
    await frame.click('#right-drawer .drawer-close');
    assert.equal(await frame.$eval('.drawer-overlay', e => e.classList.contains('active')), false);
    await frame.click('#unrelated-modal .drawer-close');
    assert.equal(await frame.$eval('#unrelated-modal', e => e.classList.contains('open')), true);
    await frame.click('#open-left');
    await page.keyboard.press('Escape');
    assert.equal(await frame.$eval('#left-drawer', e => e.classList.contains('open')), false);

    for (const width of [320, 360, 393, 412]) {
        await page.setViewport({ width, height: 800 });
        const checks = await frame.evaluate(() => [...document.querySelectorAll('.mode-card')].map(card => {
            const c = card.getBoundingClientRect();
            return [...card.querySelectorAll('.num,.art,.mode-name,.mode-description')].every(e => {
                const r = e.getBoundingClientRect();
                return r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom;
            });
        }));
        assert.deepEqual(checks, [true, true], 'All mode content must remain inside its card at ' + width + 'px');
        assert.equal(await page.$eval('#ordinary .mesAvatarWrapper', e => getComputedStyle(e).display), 'block');
    }
    await frame.goto('http://127.0.0.1:' + server.address().port + '/frame');
    await frame.waitForSelector('#st-android-card-layout');
    await frame.click('#open-left');
    await frame.click('#left-drawer .drawer-close');
    assert.equal(await frame.$eval('#left-drawer', e => e.classList.contains('open')), false);
    await page.evaluate(() => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = '<iframe id="TH-message--1--0" src="/frame"></iframe><iframe id="other-frame" src="/frame"></iframe><iframe id="TH-message--opaque" sandbox srcdoc="opaque"></iframe>';
        document.getElementById('chat').append(wrapper);
    });
    await page.waitForFunction(() => document.getElementById('TH-message--1--0').contentDocument?.getElementById('st-android-card-layout'));
    assert.equal(await page.$eval('#other-frame', e => !!e.contentDocument?.getElementById('st-android-card-layout')), false);
    assert.equal(await page.$eval('#TH-message--opaque', e => e.contentDocument), null);
    await page.evaluate(async () => (await import('/layout.js')).installAndroidCardLayout());
    assert.equal(await page.$$eval('#st-android-card-layout', elements => elements.length), 1);
});
