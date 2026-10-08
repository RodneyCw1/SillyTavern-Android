import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const project = path.resolve(import.meta.dirname, '..');
const sourceRoot = process.env.ST_ANDROID_TEST_SOURCE_ROOT || project;
const load = () => import(pathToFileURL(path.join(sourceRoot, 'scripts/authentication-acceptance.mjs')));
const avd = 'SillyTavern-R04-Test';
function fixture(options = {}) {
    const calls = [];
    const device = {
        packageName: options.packageName || 'io.sillytavern.standalone.debug', serial: 'emulator-9912',
        text: (...args) => {
            calls.push(args.join(' '));
            if (args.join(' ') === 'shell getprop ro.kernel.qemu') return options.qemu ?? '1';
            if (args.join(' ') === 'emu avd name') return options.avdOutput ?? ((options.avd || avd) + '\nOK');
            if (args.join(' ') === 'shell id -u') return options.uid || '2000';
            return '';
        },
        start: () => { calls.push('app.start'); },
        nativeStatus: () => { calls.push('native.status'); return { ready: options.ready ?? true }; },
    };
    const attacker = {
        start: async () => { calls.push('attacker.start'); if (options.startFailure) throw Error('bind failed'); },
        calibrate: async () => { calls.push('attacker.calibrate'); if (options.badCalibration) throw Error('wrong listener'); },
        stats: async () => { calls.push('attacker.stats'); return options.captured || { connections: 0, credentialSeen: false }; },
        stop: async () => { calls.push('attacker.stop'); if (options.cleanupFailure) throw Error('cleanup failed'); },
    };
    const probe = {
        blockedWarning: async () => { calls.push('ui.blocked'); return options.blocked ?? true; },
        assertBlockedPage: async () => { calls.push('webview.blank'); if (options.fakePage) throw Error('fake page loaded'); },
        assertNormalPage: async () => { calls.push('webview.real'); if (options.normalPageFailure) throw Error('app page not ready'); },
    };
    const until = async fn => { const value = await fn(); if (!value) throw Error('condition did not become true'); return value; };
    const wait = async ms => { calls.push(`wait:${ms}`); };
    return { device, attacker, probe, until, wait, calls, expectedAvd: avd };
}

test('authentication acceptance rejects physical/release/wrong-AVD/root-shell targets before any mutation', async () => {
    const { runAuthenticationScenario } = await load();
    for (const options of [{ qemu: '0' }, { packageName: 'io.sillytavern.standalone' }, { avd: 'personal-avd' }, { uid: '0' }]) {
        const f = fixture(options);
        await assert.rejects(runAuthenticationScenario(f), /emulator|debug|AVD|2000/i);
        assert.ok(!f.calls.some(value => /force-stop|app.start|attacker.start/.test(value)));
    }
});

test('authentication acceptance requires the exact dedicated AVD name', async () => {
    const { runAuthenticationScenario } = await load();
    const f = fixture();
    delete f.expectedAvd;
    await assert.rejects(runAuthenticationScenario(f), /AVD/);
    assert.ok(!f.calls.some(value => /force-stop/.test(value)));
});

test('dedicated emulator identity accepts Windows ADB CRCRLF without accepting a different AVD', async () => {
    const { requireDedicatedEmulator } = await load();
    assert.doesNotThrow(() => requireDedicatedEmulator(fixture({ avdOutput: avd + '\r\r\nOK\r\r\n' }).device, avd));
    assert.throws(() => requireDedicatedEmulator(fixture({ avdOutput: avd + '-other\r\r\nOK\r\r\n' }).device, avd), /AVD/);
});

test('successful authentication scenario observes a blank blocked WebView then actual private readiness and page load', async () => {
    const { runAuthenticationScenario } = await load();
    const f = fixture();
    const result = await runAuthenticationScenario(f);
    assert.equal(result.passed, true);
    assert.deepEqual(result.captured, { connections: 0, credentialSeen: false });
    assert.ok(f.calls.indexOf('attacker.calibrate') < f.calls.indexOf('app.start'));
    assert.ok(f.calls.indexOf('ui.blocked') < f.calls.indexOf('attacker.stats'));
    assert.ok(f.calls.indexOf('webview.blank') < f.calls.indexOf('attacker.stop'));
    assert.ok(f.calls.indexOf('attacker.stop') < f.calls.indexOf('native.status'));
    assert.ok(f.calls.indexOf('native.status') < f.calls.indexOf('webview.real'));
    assert.equal(f.calls.filter(value => value === 'app.start').length, 2);
    assert.ok(result.checks.every(check => check.passed));
});

test('any non-control connection or credentials makes acceptance fail even if the UI looks blocked', async () => {
    const { runAuthenticationScenario } = await load();
    for (const captured of [{ connections: 1, credentialSeen: false }, { connections: 0, credentialSeen: true }]) {
        const f = fixture({ captured });
        const result = await runAuthenticationScenario(f);
        assert.equal(result.passed, false);
        assert.deepEqual(result.captured, captured);
        assert.ok(f.calls.includes('attacker.stop'));
        assert.ok(f.calls.includes('webview.real'));
        assert.ok(!JSON.stringify(result).includes('x-android-host:'));
    }
});

test('a fake page or missing live native UI cannot pass and the owned attacker is always stopped', async () => {
    const { runAuthenticationScenario } = await load();
    for (const options of [{ fakePage: true }, { blocked: false }, { startFailure: true }, { badCalibration: true }]) {
        const f = fixture(options);
        const result = await runAuthenticationScenario(f);
        assert.equal(result.passed, false);
        assert.ok(f.calls.includes('attacker.stop'));
    }
});

test('a failed attacker cleanup never starts a supposedly normal recovery against the fake origin', async () => {
    const { runAuthenticationScenario } = await load();
    const f = fixture({ cleanupFailure: true });
    const result = await runAuthenticationScenario(f);
    assert.equal(result.passed, false);
    assert.ok(!f.calls.includes('native.status'));
    assert.equal(f.calls.filter(value => value === 'app.start').length, 1);
});

test('private ready alone does not substitute for an actual WebView page', async () => {
    const { runAuthenticationScenario } = await load();
    const f = fixture({ normalPageFailure: true });
    assert.equal((await runAuthenticationScenario(f)).passed, false);
    assert.ok(f.calls.includes('native.status'));
    assert.ok(f.calls.includes('webview.real'));
});

test('an attacker that exits after calibration cannot establish fail-closed isolation', async () => {
    const { runAuthenticationScenario } = await load();
    const f = fixture();
    let calibrations = 0;
    f.attacker.calibrate = async () => {
        if (++calibrations > 1) throw Error('owned listener exited during observation');
    };
    assert.equal((await runAuthenticationScenario(f)).passed, false);
    assert.ok(f.calls.includes('attacker.stop'));
});

test('attack fixture accepts only its generated directory and nonce', async () => {
    const { buildAttackHandler } = await load();
    const nonce = 'a'.repeat(32);
    assert.throws(() => buildAttackHandler('/data/local/tmp/; rm -r /', nonce), /fixture|directory/i);
    assert.throws(() => buildAttackHandler('/data/local/tmp/st-auth-' + nonce, 'bad; command'), /nonce/i);
});

test('blocked startup requires the live app warning and WebView even when CDP has no page target', async () => {
    const { assertBlockedNativeUi, assertBlockedTargets } = await load();
    const pkg = 'io.sillytavern.standalone.debug';
    const warning = `<node package="${pkg}" class="android.widget.TextView" text="本机 17614 端口被占用，已停止启动以保护本地数据。"/>`;
    const webview = `<node package="${pkg}" class="android.webkit.WebView" text=""/>`;
    assert.doesNotThrow(() => assertBlockedNativeUi(`<hierarchy>${warning}${webview}</hierarchy>`, pkg));
    for (const xml of [warning, webview, (warning + webview).replaceAll(pkg, 'another.app')]) {
        assert.throws(() => assertBlockedNativeUi(xml, pkg), /warning|WebView/i);
    }
    assert.doesNotThrow(() => assertBlockedTargets([], 'FAKE_MARKER'));
    assert.doesNotThrow(() => assertBlockedTargets([{ type: 'page', url: '', title: '' }, { type: 'page', url: 'about:blank', title: '' }], 'FAKE_MARKER'));
    for (const target of [{ type: 'page', url: 'http://127.0.0.1:17614/', title: '' }, { type: 'page', url: 'https://example.test/', title: '' }, { type: 'page', url: '', title: 'FAKE_MARKER' }]) {
        assert.throws(() => assertBlockedTargets([target], 'FAKE_MARKER'), /blank|fake|attacker/i);
    }
});

test('warning disappearance or navigation during observation fails at the final blocked check', async () => {
    const { runAuthenticationScenario } = await load();
    for (const changed of ['warning', 'page']) {
        const f = fixture();
        let observed = false;
        f.wait = async () => { observed = true; };
        f.probe.blockedWarning = async () => !(observed && changed === 'warning');
        f.probe.assertBlockedPage = async () => { if (observed && changed === 'page') throw Error('fake page loaded'); };
        const result = await runAuthenticationScenario(f);
        assert.equal(result.passed, false);
        assert.match(result.errors[0], /post-observation/);
        assert.ok(f.calls.includes('attacker.stop'));
    }
});
