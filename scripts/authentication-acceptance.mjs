import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createAndroidDevice, readBuildIdentity, verifyInstalledApk, writeAcceptanceReport, until as poll } from './android-test-tools.mjs';

const ORIGIN = 'http://127.0.0.1:17614';
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

export function assertBlockedNativeUi(xml, packageName) {
    const nodes = [...String(xml).matchAll(/<node\b([^>]*)>/g)].map(([, attributes]) =>
        Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value])));
    const ownNodes = nodes.filter(node => node.package === packageName);
    ensure(ownNodes.some(node => node.text?.includes('17614 端口被占用')), 'Live app occupied-port warning is missing.');
    ensure(ownNodes.some(node => node.class === 'android.webkit.WebView'), 'Live app WebView is missing.');
    return true;
}

export function assertBlockedTargets(targets, marker) {
    ensure(Array.isArray(targets), 'Invalid CDP target list.');
    for (const target of targets.filter(target => target.type === 'page')) {
        ensure(['about:blank', ''].includes(target.url), 'Blocked WebView was not blank.');
        ensure(!String(target.title || '').includes(marker), 'Attacker fake HTML appeared in the actual WebView.');
    }
}

export function requireDedicatedEmulator(device, expectedAvd) {
    ensure(typeof expectedAvd === 'string' && /^[A-Za-z0-9_.-]+$/.test(expectedAvd), 'Supply --avd with the dedicated test AVD name.');
    ensure(device.packageName.endsWith('.debug'), 'This probe only stops and starts a debug package.');
    ensure(device.text('shell', 'getprop', 'ro.kernel.qemu') === '1', 'Use a dedicated emulator; physical devices are refused.');
    ensure(device.text('emu', 'avd', 'name').split(/\r?\n/)[0].trim() === expectedAvd, 'Selected AVD differs from the dedicated test AVD.');
    ensure(device.text('shell', 'id', '-u') === '2000', 'Attacker fixture must run as shell UID 2000; use adb unroot first.');
}

/** Injectable orchestration for deterministic tests; real entry point supplies ADB/CDP implementations. */
export async function runAuthenticationScenario({ device, attacker, probe, expectedAvd, until = poll, wait = delay, observationMs = 5000 }) {
    requireDedicatedEmulator(device, expectedAvd);
    const report = { passed: false, checks: [], errors: [], captured: null };
    const check = (id, passed, description) => report.checks.push({ id, required: true, passed, description });
    let calibrated = false, blocked = false, cleaned = false, phase = 'fixture-start';
    device.text('shell', 'am', 'force-stop', device.packageName);
    try {
        await attacker.start();
        phase = 'fixture-calibration';
        await attacker.calibrate();
        calibrated = true;
        check('fixture', true, 'Shell UID 2000 fixture really serves fake ready JSON and the unique fake HTML marker.');
        device.start();
        phase = 'blocked-warning';
        await until(() => probe.blockedWarning(), 20000);
        phase = 'blocked-targets';
        await probe.assertBlockedPage();
        phase = 'observation';
        await wait(observationMs);
        phase = 'post-observation-warning';
        await until(() => probe.blockedWarning(), 20000);
        phase = 'post-observation-targets';
        await probe.assertBlockedPage();
        // A dead listener could otherwise produce a false zero-request result.
        // Prove the owned fake HTTP server still responds after observation.
        phase = 'post-observation-calibration';
        await attacker.calibrate();
        blocked = true;
    } catch (error) { report.errors.push(`${phase}: ${error.message}`); }
    finally {
        try { report.captured = await attacker.stats(); } catch { /* Fixture might not have started. */ }
        try {
            const finalCapture = await attacker.stop();
            if (finalCapture) report.captured = finalCapture;
            cleaned = true;
        } catch (error) { report.errors.push(error.message); }
    }
    check('blocked-ui', blocked, 'Live native UI has the occupied-port warning and WebView; connected CDP has no navigated or fake page before and after observation.');
    const noLeak = calibrated && report.captured?.connections === 0 && report.captured?.credentialSeen === false;
    check('no-app-requests', noLeak, 'During the observed blocked startup, the attacker received no non-control connection or credential header.');
    check('fixture-cleanup', cleaned, 'Only the owned fixture processes and directory were removed.');
    if (calibrated && cleaned) {
        try {
            device.text('shell', 'am', 'force-stop', device.packageName);
            device.start();
            await until(() => device.nativeStatus().ready, 120000);
            await probe.assertNormalPage();
            check('normal-recovery', true, 'After removing the attacker, same-UID Unix-socket status is ready and CDP sees a working SillyTavern page.');
        } catch (error) {
            report.errors.push(`normal-recovery: ${error.message}`);
            check('normal-recovery', false, 'Normal private status and actual WebView loading must both recover.');
        }
    } else check('normal-recovery', false, 'Recovery is not attempted unless the attacker was calibrated and safely removed.');
    report.passed = report.errors.length === 0 && report.checks.every(item => item.passed);
    return report;
}

export function buildAttackHandler(directory, nonce) {
    ensure(/^\/data\/local\/tmp\/st-auth-[a-f0-9]{32}$/.test(directory), 'Invalid fixture directory.');
    ensure(/^[a-f0-9]{32}$/.test(nonce), 'Invalid fixture nonce.');
    // No raw request, Cookie or token is persisted or printed. The only capture
    // is an opaque PID marker and a boolean saying a credential header was seen.
    return `#!/system/bin/sh
root='${directory}'
nonce='${nonce}'
umask 077
: > "$root/pids/$$"
: > "$root/requests/$$"
cr=$(printf '\\r')
IFS= read -r request || exit 0
control=0
while IFS= read -r line; do
  line=\${line%"$cr"}
  [ -z "$line" ] && break
  case "$line" in
    "X-ST-Acceptance-Control: $nonce"|"x-st-acceptance-control: $nonce") control=1 ;;
  esac
  lower=$(printf '%s' "$line" | /system/bin/toybox tr A-Z a-z)
  case "$lower" in
    x-android-host:*|*st_android_auth=*) : > "$root/credential-seen" ;;
  esac
done
if [ "$control" = 1 ]; then rm -f "$root/requests/$$"; fi
uid=$(/system/bin/toybox id -u)
case "$request" in
  "GET /api/android/native/status "*) body='{"ready":true,"fixture":"${nonce}","uid":'"$uid"'}'; mime='application/json' ;;
  *) body='<!doctype html><html><head><title>ST_AUTH_FAKE_${nonce}</title></head><body>ST_AUTH_FAKE_${nonce}</body></html>'; mime='text/html' ;;
esac
printf 'HTTP/1.1 200 OK\\r\\nContent-Type: %s\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\n\\r\\n%s' "$mime" "\${#body}" "$body"
`;
}

function safeCapture(value) {
    ensure(value && Number.isInteger(value.connections) && value.connections >= 0 && typeof value.credentialSeen === 'boolean', 'Invalid attacker capture counters.');
    return value;
}

async function createAttacker({ device, root, nonce }) {
    const directory = '/data/local/tmp/st-auth-' + nonce;
    const local = path.join(root, '.local/authentication-fixture', nonce);
    const handler = directory + '/handler.sh';
    const marker = 'ST_AUTH_FAKE_' + nonce;
    let pid, forward, initialized = false;
    const cmdline = id => { try { return device.text('shell', 'cat', `/proc/${id}/cmdline`); } catch { return ''; } };
    const stats = async () => {
        const names = device.text('shell', 'ls', directory + '/requests').split(/\s+/).filter(value => /^\d+$/.test(value));
        const credentialSeen = device.text('shell', `if [ -f '${directory}/credential-seen' ]; then echo yes; else echo no; fi`) === 'yes';
        return safeCapture({ connections: names.length, credentialSeen });
    };
    return {
        directory, marker,
        async start() {
            const help = device.text('exec-out', '/system/bin/toybox', 'nc', '--help');
            ensure(/-L\s+Listen/i.test(help) && /-p\s+Local port/i.test(help) && /-s\s+Local source/i.test(help) && /COMMAND/.test(help), 'Device toybox nc needs -L, -p, -s and COMMAND server support.');
            await fs.mkdir(local, { recursive: true });
            await fs.writeFile(path.join(local, 'handler.sh'), buildAttackHandler(directory, nonce), { flag: 'wx' });
            device.text('shell', `umask 077; mkdir '${directory}' && mkdir '${directory}/requests' '${directory}/pids'`);
            initialized = true;
            device.text('push', path.join(local, 'handler.sh'), handler);
            const launched = device.text('shell', `/system/bin/toybox nohup /system/bin/toybox nc -s 127.0.0.1 -p 17614 -L /system/bin/sh '${handler}' </dev/null >'${directory}/listener.log' 2>&1 & echo $!`);
            ensure(/^\d+$/.test(launched), 'Fixture did not return a listener PID.');
            pid = launched;
            forward = device.forward('tcp:17614');
        },
        async calibrate() {
            await poll(() => pid && cmdline(pid).includes(handler), 5000);
            const control = async endpoint => {
                const response = await fetch(`http://127.0.0.1:${forward}${endpoint}`, {
                    headers: { 'X-ST-Acceptance-Control': nonce }, redirect: 'error', signal: AbortSignal.timeout(3000),
                });
                ensure(response.status === 200, 'Attacker calibration HTTP status is not 200.');
                return response;
            };
            await poll(async () => {
                const result = await (await control('/api/android/native/status')).json();
                return result.ready === true && result.fixture === nonce && result.uid === 2000;
            }, 10000);
            ensure((await (await control('/')).text()).includes(marker), 'Attacker HTML calibration marker differs.');
            const captured = await stats();
            ensure(captured.connections === 0 && !captured.credentialSeen, 'Control calibration must not count as an app request.');
        },
        stats,
        async stop() {
            if (!initialized) return undefined;
            if (pid && cmdline(pid).includes(handler)) {
                device.text('shell', 'kill', '-TERM', pid);
                await poll(() => !cmdline(pid).includes(handler), 5000);
            }
            // The listener no longer accepts. Kill only remaining handlers whose
            // command line still contains this run's unpredictable path.
            for (const id of device.text('shell', 'ls', directory + '/pids').split(/\s+/).filter(value => /^\d+$/.test(value))) {
                if (cmdline(id).includes(handler)) {
                    device.text('shell', 'kill', '-TERM', id);
                    await poll(() => !cmdline(id).includes(handler), 5000);
                }
            }
            const captured = await stats();
            device.text('shell', `rm -rf '${directory}'`);
            initialized = false;
            return captured;
        },
    };
}

async function createWebViewProbe(device, attacker) {
    const { default: puppeteer } = await import('puppeteer-core');
    let browser, attachedPid, session;
    const connect = async () => {
        const pid = device.text('shell', 'pidof', device.packageName);
        ensure(/^\d+$/.test(pid), 'Expected exactly one main app PID.');
        if (attachedPid !== pid) {
            browser?.disconnect();
            const port = device.forward('localabstract:webview_devtools_remote_' + pid);
            browser = await poll(() => puppeteer.connect({ browserURL: 'http://127.0.0.1:' + port, defaultViewport: null, protocolTimeout: 10000 }), 20000);
            session = await browser.target().createCDPSession();
            attachedPid = pid;
        }
        return browser;
    };
    return {
        async blockedWarning() {
            const file = attacker.directory + '/blocked-ui.xml';
            device.text('shell', 'uiautomator', 'dump', file);
            return assertBlockedNativeUi(device.text('shell', 'cat', file), device.packageName);
        },
        async assertBlockedPage() {
            await connect();
            // Puppeteer hides a new WebView while its URL is empty. Inspect raw
            // CDP targets without navigating it just to make browser.pages work.
            const { targetInfos } = await session.send('Target.getTargets');
            assertBlockedTargets(targetInfos, attacker.marker);
        },
        async assertNormalPage() {
            const browser = await connect();
            const page = await poll(async () => (await browser.pages()).find(page => page.url().startsWith(ORIGIN + '/')), 90000);
            await page.waitForFunction(() => !!window.STAndroid && typeof window.SillyTavern?.getContext === 'function', { timeout: 90000 });
            ensure(!(await page.title()).includes(attacker.marker), 'Recovery loaded the attacker HTML.');
        },
        close() { browser?.disconnect(); },
    };
}

async function main() {
    const root = path.resolve(import.meta.dirname, '..');
    const { values } = parseArgs({ options: { serial: { type: 'string' }, package: { type: 'string' }, apk: { type: 'string' }, avd: { type: 'string' } } });
    const report = { passed: false, checks: [], scope: 'Dedicated debug emulator; real shell UID 2000 port squatter, live Android UI and WebView CDP; no release-device claim' };
    let device, attacker, probe;
    try {
        device = createAndroidDevice({ root, serial: values.serial, packageName: values.package });
        report.device = device.serial;
        report.package = device.packageName;
        requireDedicatedEmulator(device, values.avd);
        report.avd = values.avd;
        ensure(values.apk, 'Supply --apk with the exact installed debug APK artifact.');
        Object.assign(report, await readBuildIdentity(root));
        report.apkSha256 = await verifyInstalledApk(device, path.resolve(values.apk));
        device.checkNativeClient();
        device.text('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
        device.text('shell', 'wm', 'dismiss-keyguard');
        const nonce = crypto.randomBytes(16).toString('hex');
        attacker = await createAttacker({ device, root, nonce });
        probe = await createWebViewProbe(device, attacker);
        Object.assign(report, await runAuthenticationScenario({ device, attacker, probe, expectedAvd: values.avd }));
        ensure((await readBuildIdentity(root)).sourceHash === report.sourceHash, 'Source changed during acceptance.');
    } catch (error) { report.passed = false; report.error = error.message; }
    finally {
        probe?.close();
        if (attacker) try { await attacker.stop(); } catch { report.passed = false; report.cleanupError = 'Owned attacker cleanup failed; inspect this dedicated emulator before reuse.'; }
        device?.close();
        const evidence = await writeAcceptanceReport(root, 'authentication', report);
        console.log(JSON.stringify({ passed: report.passed, device: report.device, checks: report.checks, evidence }, null, 2));
    }
    if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
