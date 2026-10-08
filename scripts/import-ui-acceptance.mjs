import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAndroidDevice, readBuildIdentity, verifyInstalledApk, writeAcceptanceReport, until } from './android-test-tools.mjs';
import { requireDedicatedEmulator } from './authentication-acceptance.mjs';

const ensure = (ok, message) => { if (!ok) throw Error(message); };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

export function requireImportFixture(device, avd, reset) {
    requireDedicatedEmulator(device, avd);
    ensure(reset === true, 'Supply --reset-test-data: this suite resets only the selected dedicated debug package.');
}

export function resetImportFixture(device, avd, reset) {
    requireImportFixture(device, avd, reset);
    const api = Number(device.text('shell', 'getprop', 'ro.build.version.sdk'));
    ensure(Number.isSafeInteger(api) && api >= 29, 'Unexpected test Android API level');
    device.text('shell', 'am', 'force-stop', device.packageName);
    ensure(device.text('shell', 'pm', 'clear', device.packageName) === 'Success', 'Could not reset dedicated debug fixture data');
    if (api >= 33) device.text('shell', 'pm', 'grant', device.packageName, 'android.permission.POST_NOTIFICATIONS');
}

export function parseUiNodes(xml) {
    const decode = value => value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
        const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
        return named[entity] ?? String.fromCodePoint(entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10));
    });
    return [...xml.matchAll(/<node\b([^>]*)>/g)].map(([, attributes]) => {
        const node = Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)]));
        const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node.bounds || '')?.slice(1).map(Number);
        node.visible = !!bounds && bounds[2] > bounds[0] && bounds[3] > bounds[1] && node.enabled !== 'false';
        node.center = bounds && [Math.floor((bounds[0] + bounds[2]) / 2), Math.floor((bounds[1] + bounds[3]) / 2)];
        return node;
    });
}

export function findUiNode(nodes, predicate) {
    const matches = nodes.filter(node => node.visible && predicate(node));
    ensure(matches.length === 1, `Expected a unique visible UI target, found ${matches.length}.`);
    return matches[0];
}

export async function createMigrationFixtures(root, directory, nonce, paddingBytes = 16 * 1024 ** 2) {
    ensure(/^[a-f0-9]{32}$/.test(nonce), 'Invalid fixture ID');
    await fs.mkdir(directory, { recursive: true });
    const archiver = createRequire(path.join(root, 'server/package.json'))('archiver');
    const username = 'Import UI ' + nonce.slice(0, 8);
    const settings = JSON.parse(await fs.readFile(path.join(root, 'server/default/content/settings.json'), 'utf8'));
    Object.assign(settings, { username, firstRun: false });
    const worldPath = 'worlds/st-import-' + nonce + '.json';
    const world = JSON.stringify({ entries: { 0: { uid: 0, key: ['合成验收'], content: '仅用于导入验收：中文😀 ' + nonce, disable: true } } });
    const contents = new Map([
        ['settings.json', Buffer.from(JSON.stringify(settings))], [worldPath, Buffer.from(world)],
        ['chats/ST-Acceptance/fixture.jsonl', Buffer.from(JSON.stringify({ user_name: username, character_name: 'Synthetic', chat_metadata: {} }) + '\n' + JSON.stringify({ name: username, mes: '合成聊天😀', is_user: true }))],
        // Stored rather than deflated so native staging is observable on a fast emulator.
        ['assets/st-import-padding.bin', Buffer.alloc(paddingBytes, 0x41)],
    ]);
    const fixture = { username, worldPath, world, worldHash: sha256(world), valid: path.join(directory, `st-ui-${nonce.slice(0, 8)}-valid.zip`), corrupt: path.join(directory, `st-ui-${nonce.slice(0, 8)}-bad.zip`) };
    for (const [kind, destination] of [['valid', fixture.valid], ['corrupt', fixture.corrupt]]) {
        const zip = archiver('zip', { store: true });
        const done = pipeline(zip, createWriteStream(destination, { flags: 'wx' }));
        done.catch(() => {});
        const files = [];
        for (const [name, bytes] of contents) {
            zip.append(bytes, { name: 'user/' + name });
            files.push({ path: name, size: bytes.length, sha256: kind === 'corrupt' && name === 'settings.json' ? '0'.repeat(64) : sha256(bytes) });
        }
        zip.append(JSON.stringify({ format: 'sillytavern-android-migration', version: 1, files }), { name: 'manifest.json' });
        await zip.finalize(); await done;
    }
    return fixture;
}

export async function runImportScenario(driver) {
    const report = { passed: false, checks: [], observedIds: [] };
    const check = (id, description) => report.checks.push({ id, required: true, passed: true, description });
    try {
        const baseline = await driver.baseline();
        await driver.startMonitor();
        await driver.openPicker(); await driver.cancelPicker(); await driver.unchanged(baseline);
        ensure((await driver.snapshot()).observedIds.length === 0, 'Picker cancellation unexpectedly staged an archive');
        check('picker-cancel', 'Native import opens the real document picker; Back cancels without staging or changing the synthetic canary.');
        await driver.openPicker(); await driver.choose('valid'); await driver.cancelConfirmation(); await driver.unchanged(baseline);
        ensure((await driver.snapshot()).observedIds.length === 0, 'Confirmation cancellation unexpectedly staged an archive');
        check('confirmation-cancel', 'Selecting a real ZIP reaches the native confirmation dialog; Cancel keeps the synthetic data unchanged.');
        await driver.openPicker(); await driver.choose('corrupt'); await driver.confirm(); await driver.waitRejected(); await driver.unchanged(baseline);
        const rejected = await driver.snapshot();
        ensure(rejected.observedIds.length === 1 && rejected.remaining.length === 0, 'Rejected import must have one observed operation ID and no remaining archive');
        check('corrupt-rejection', 'A real picker-selected ZIP with a bad checksum is rejected in native UI and its staged archive is removed.');
        await driver.openPicker(); await driver.choose('valid'); await driver.confirm(); await driver.waitImported();
        const imported = await driver.snapshot();
        const ids = [...new Set(imported.observedIds)];
        report.observedIds = ids;
        ensure(ids.length === 2 && ids.every(id => /^[a-f0-9]{32}$/.test(id)), 'Two different native-generated 32-hex operation IDs must actually be observed');
        ensure(imported.remaining.length === 0, 'Staged import archives remain after completion');
        ensure(imported.backups > baseline.backups, 'Successful import did not create a previous-data backup');
        check('valid-import', 'The synthetic UTF-8 world data matches, the old canary was replaced, private status is ready and the restarted actual WebView loads.');
        check('operation-cleanup', 'Rejected and successful imports used two observed independent operation IDs and left no ZIP behind.');
    } catch (error) { report.error = error.message; }
    finally {
        try { await driver.stopMonitor(); }
        catch (error) { report.cleanupError = error.message; }
    }
    report.passed = !report.error && !report.cleanupError && report.checks.length === 5;
    return report;
}

async function createDriver({ root, device, fixture, nonce, evidence, avd }) {
    const { default: puppeteer } = await import('puppeteer-core');
    const cache = 'cache/st-import-ui-' + nonce;
    const calibration = crypto.randomBytes(16).toString('hex');
    const canary = 'files/tavern/data/default-user/worlds/st-before-' + nonce + '.json';
    const canaryBytes = JSON.stringify({ entries: {}, syntheticAcceptance: nonce });
    const remoteZips = [fixture.valid, fixture.corrupt].map(file => '/sdcard/Download/' + path.basename(file));
    let browser, monitorPid;
    const runAs = command => device.text('shell', `run-as ${quote(device.packageName)} /system/bin/sh -c ${quote(command)}`);
    const writePrivate = (destination, content) => runAs(`printf %s ${quote(Buffer.from(content).toString('base64'))} | /system/bin/toybox base64 -d > ${quote(destination)}`);
    const archiveNames = () => runAs('for f in files/tavern/imports/*.zip; do [ ! -f "$f" ] || printf "%s\\n" "${f##*/}"; done').split(/\s+/).filter(Boolean);
    const backupCount = () => runAs('for d in files/tavern/data/default-user.previous-*; do [ ! -d "$d" ] || echo one; done').split(/\s+/).filter(Boolean).length;
    const observed = () => [...new Set(runAs(`cat ${quote(cache + '/observed')}`).split(/\s+/).filter(name => name !== calibration + '.zip').map(name => name.replace(/\.zip$/, '')))];
    const dump = async name => {
        const remote = '/data/local/tmp/st-import-ui-' + nonce + '.xml';
        device.text('shell', 'uiautomator', 'dump', remote);
        const xml = device.text('shell', 'cat', remote);
        await fs.writeFile(path.join(evidence, name + '.xml'), xml);
        return parseUiNodes(xml);
    };
    const tap = node => device.text('shell', 'input', 'tap', ...node.center.map(String));
    const waitNode = async (name, predicate) => until(async () => findUiNode(await dump(name), predicate), 20000);
    const appVisible = async () => until(async () => (await dump('app')).some(n => n.package === device.packageName && n.text === '导入数据'), 20000);
    const readyPage = async () => {
        await until(() => device.nativeStatus().ready, 120000);
        browser?.disconnect();
        const pid = device.text('shell', 'pidof', device.packageName);
        ensure(/^\d+$/.test(pid), 'Expected exactly one main app PID');
        const port = device.forward('localabstract:webview_devtools_remote_' + pid);
        browser = await until(() => puppeteer.connect({ browserURL: 'http://127.0.0.1:' + port, defaultViewport: null }), 30000);
        const page = await until(async () => (await browser.pages()).find(p => p.url().startsWith('http://127.0.0.1:17614/')), 90000);
        await page.waitForFunction(() => !!window.STAndroid && typeof window.SillyTavern?.getContext === 'function', { timeout: 90000 });
        return page;
    };
    return {
        async prepare() {
            resetImportFixture(device, avd, true);
            device.text('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
            device.text('shell', 'wm', 'dismiss-keyguard');
            device.start(); await readyPage();
            runAs(`mkdir -p ${quote(cache)} files/tavern/imports files/tavern/data/default-user/worlds`);
            writePrivate(canary, canaryBytes);
            for (let i = 0; i < remoteZips.length; i++) device.text('push', [fixture.valid, fixture.corrupt][i], remoteZips[i]);
        },
        async baseline() { return { canaryHash: sha256(canaryBytes), backups: backupCount() }; },
        async startMonitor() {
            ensure(archiveNames().length === 0, 'Fixture starts with unexpected staged ZIPs');
            const script = `#!/system/bin/sh\nwhile [ ! -f ${quote(cache + '/stop')} ]; do\nfor f in files/tavern/imports/*.zip; do\n[ ! -f "$f" ] || printf '%s\\n' "\${f##*/}" >> ${quote(cache + '/observed')}\ndone\n/system/bin/toybox sleep 0.01\ndone\n`;
            writePrivate(cache + '/watch.sh', script); writePrivate(cache + '/observed', '');
            monitorPid = runAs(`/system/bin/toybox nohup /system/bin/sh ${quote(cache + '/watch.sh')} </dev/null >${quote(cache + '/watch.log')} 2>&1 & echo $!`);
            ensure(/^\d+$/.test(monitorPid), 'Import monitor PID missing');
            writePrivate('files/tavern/imports/' + calibration + '.zip', 'monitor calibration only');
            await until(() => runAs(`cat ${quote(cache + '/observed')}`).includes(calibration + '.zip'), 10000);
            runAs(`rm -f files/tavern/imports/${calibration}.zip`);
        },
        async openPicker() {
            tap(await waitNode('toolbar', n => n.package === device.packageName && n.text === '导入数据'));
            await until(async () => (await dump('picker')).some(n => /^(?:com\.android|com\.google\.android)\.documentsui$/.test(n.package)), 15000);
        },
        async cancelPicker() { device.text('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await appVisible(); },
        async choose(kind) {
            const filename = path.basename(fixture[kind]);
            let nodes = await dump('picker-before-select');
            let file = nodes.find(n => n.visible && n.text === filename);
            if (!file) {
                const navigation = findUiNode(nodes, n => /Show roots|Open navigation drawer|Show navigation drawer|显示根目录|显示存储空间|打开导航抽屉/i.test(n['content-desc'] || ''));
                tap(navigation);
                tap(await waitNode('picker-roots', n => /^(Downloads|下载)$/.test(n.text)));
                file = await waitNode('picker-downloads', n => n.text === filename);
            }
            tap(file);
            await waitNode('confirmation', n => n.package === device.packageName && n.text === '导入个人数据');
        },
        async cancelConfirmation() { tap(await waitNode('confirmation-cancel', n => n['resource-id'] === 'android:id/button2' && n.text === '取消')); await appVisible(); },
        async confirm() { tap(await waitNode('confirmation-import', n => n['resource-id'] === 'android:id/button1' && n.text === '导入')); },
        async unchanged(baseline) {
            await delay(500);
            ensure(runAs(`sha256sum ${quote(canary)}`).split(/\s+/)[0] === baseline.canaryHash, 'Synthetic pre-import canary changed');
            ensure(backupCount() === baseline.backups, 'Cancelled/rejected import unexpectedly created a backup');
        },
        async waitRejected() { await waitNode('import-rejected', n => n.package === device.packageName && n.text?.startsWith('导入未完成：')); },
        async waitImported() {
            const target = 'files/tavern/data/default-user/' + fixture.worldPath;
            await until(() => runAs(`sha256sum ${quote(target)}`).split(/\s+/)[0] === fixture.worldHash, 120000);
            ensure(runAs(`[ ! -f ${quote(canary)} ] && echo absent`) === 'absent', 'Import did not replace the previous synthetic profile');
            const page = await readyPage();
            await page.screenshot({ path: path.join(evidence, 'imported-webview.png') });
            await fs.writeFile(path.join(evidence, 'imported-screen.png'), device.bytes('exec-out', 'screencap', '-p'));
        },
        async snapshot() { return { observedIds: observed(), remaining: archiveNames(), backups: backupCount() }; },
        async stopMonitor() {
            if (!monitorPid) return;
            writePrivate(cache + '/stop', 'stop');
            await until(() => {
                try { return !runAs(`cat /proc/${monitorPid}/cmdline`).includes(cache + '/watch.sh'); } catch { return true; }
            }, 5000);
            monitorPid = undefined;
        },
        async close() {
            browser?.disconnect();
            await this.stopMonitor();
            runAs(`rm -f files/tavern/imports/${calibration}.zip`);
            for (const remote of remoteZips) device.text('shell', 'rm', '-f', remote);
            device.text('shell', 'rm', '-f', '/data/local/tmp/st-import-ui-' + nonce + '.xml');
            runAs(`rm -rf ${quote(cache)}`);
        },
    };
}

async function main() {
    const root = path.resolve(import.meta.dirname, '..');
    const { values } = parseArgs({ options: { serial: { type: 'string' }, package: { type: 'string' }, apk: { type: 'string' }, avd: { type: 'string' }, 'reset-test-data': { type: 'boolean', default: false } } });
    const report = { passed: false, checks: [], scope: 'Real system document picker on a dedicated debug emulator; synthetic data only; resets the selected debug package' };
    let device, driver;
    try {
        device = createAndroidDevice({ root, serial: values.serial, packageName: values.package });
        requireImportFixture(device, values.avd, values['reset-test-data']);
        ensure(values.apk, 'Supply the exact installed debug APK with --apk');
        Object.assign(report, await readBuildIdentity(root));
        Object.assign(report, { device: device.serial, package: device.packageName, avd: values.avd, androidApi: Number(device.text('shell', 'getprop', 'ro.build.version.sdk')), apkSha256: await verifyInstalledApk(device, path.resolve(values.apk)) });
        const nonce = crypto.randomBytes(16).toString('hex');
        const fixture = await createMigrationFixtures(root, path.join(root, '.local/import-ui-fixture', nonce), nonce);
        const evidence = path.join(root, 'docs/acceptance', 'import-ui-evidence-' + nonce);
        await fs.mkdir(evidence, { recursive: true }); report.uiEvidence = path.relative(root, evidence).replaceAll('\\', '/');
        driver = await createDriver({ root, device, fixture, nonce, evidence, avd: values.avd });
        await driver.prepare();
        // prepare clears the dedicated debug fixture; stage the private probe only
        // after that reset (readyPage also checks it when querying native status).
        device.checkNativeClient();
        Object.assign(report, await runImportScenario(driver));
        ensure((await readBuildIdentity(root)).sourceHash === report.sourceHash, 'Source changed during acceptance');
    } catch (error) { report.passed = false; report.error = error.message; }
    finally {
        if (driver) try { await driver.close(); } catch (error) { report.passed = false; report.cleanupError = error.message; }
        device?.close();
        const evidence = await writeAcceptanceReport(root, 'import-ui', report);
        console.log(JSON.stringify({ passed: report.passed, device: report.device, checks: report.checks, evidence }, null, 2));
    }
    if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
