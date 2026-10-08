import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { unpackMigration } from '../server/android/migration.js';

const project = path.resolve(import.meta.dirname, '..');
const sourceRoot = process.env.ST_ANDROID_TEST_SOURCE_ROOT || project;
const load = () => import(pathToFileURL(path.join(sourceRoot, 'scripts/import-ui-acceptance.mjs')));

test('import acceptance requires a dedicated debug emulator and explicit data reset', async () => {
    const { requireImportFixture } = await load();
    const device = { packageName: 'io.sillytavern.standalone.debug', text: (...args) => ({
        'shell getprop ro.kernel.qemu': '1', 'emu avd name': 'Import-Test\nOK', 'shell id -u': '2000',
    }[args.join(' ')]) };
    assert.throws(() => requireImportFixture(device, 'Import-Test', false), /reset-test-data/);
    assert.throws(() => requireImportFixture(device, 'Other', true), /AVD/);
    assert.doesNotThrow(() => requireImportFixture(device, 'Import-Test', true));
});

test('owned import reset grants notifications only on API 33+ after clearing and refuses unguarded devices', async () => {
    const { resetImportFixture } = await load();
    for (const api of [29, 35]) {
        let cleared = false, granted = false;
        const device = { packageName: 'io.sillytavern.standalone.debug', text: (...args) => {
            const command = args.join(' ');
            const fixed = { 'shell getprop ro.kernel.qemu': '1', 'emu avd name': 'Import-Test\r\r\nOK', 'shell id -u': '2000', 'shell getprop ro.build.version.sdk': String(api) };
            if (command in fixed) return fixed[command];
            if (command === 'shell am force-stop ' + device.packageName) return '';
            if (command === 'shell pm clear ' + device.packageName) { cleared = true; return 'Success'; }
            if (command === 'shell pm grant ' + device.packageName + ' android.permission.POST_NOTIFICATIONS') { assert.equal(cleared, true); granted = true; return ''; }
            throw Error('Unexpected command');
        } };
        assert.throws(() => resetImportFixture(device, 'Other-AVD', true), /AVD/);
        assert.throws(() => resetImportFixture(device, 'Import-Test', false), /reset-test-data/);
        assert.equal(cleared, false);
        resetImportFixture(device, 'Import-Test', true);
        assert.equal(cleared, true);
        assert.equal(granted, api >= 33);
    }
});

test('UI nodes decode Android XML and tap only a unique enabled visible match', async () => {
    const { parseUiNodes, findUiNode } = await load();
    const nodes = parseUiNodes('<hierarchy><node text="导入数据" package="pkg" enabled="true" bounds="[0,10][200,60]"/><node text="A &amp; B" enabled="false" bounds="[0,0][0,0]"/></hierarchy>');
    assert.equal(nodes[1].text, 'A & B');
    assert.deepEqual(findUiNode(nodes, n => n.text === '导入数据').center, [100, 35]);
    assert.throws(() => findUiNode(nodes, n => n.text === 'A & B'), /unique/);
    assert.throws(() => findUiNode([...nodes, nodes[0]], n => n.text === '导入数据'), /unique/);
});

test('actual synthetic migration ZIP unpacks and a corrupt manifest is rejected', async t => {
    const { createMigrationFixtures } = await load();
    const directory = await fs.mkdtemp(path.join(project, '.local/import-ui-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const fixture = await createMigrationFixtures(project, directory, 'a'.repeat(32), 1024);
    const goodStage = path.join(directory, 'good-stage');
    const unpacked = await unpackMigration(fixture.valid, goodStage);
    assert.equal(unpacked.count, 4);
    assert.equal(JSON.parse(await fs.readFile(path.join(goodStage, 'user/settings.json'))).username, fixture.username);
    assert.equal(await fs.readFile(path.join(goodStage, 'user', fixture.worldPath), 'utf8'), fixture.world);
    await assert.rejects(unpackMigration(fixture.corrupt, path.join(directory, 'bad-stage')), /checksum/);
});

function driver(options = {}) {
    let phase = 'initial', ids = [], remaining = [];
    const calls = [];
    const api = {
        baseline: async () => ({ canaryHash: 'before', backups: 0 }),
        startMonitor: async () => {},
        openPicker: async () => { calls.push('picker'); },
        cancelPicker: async () => { calls.push('picker.cancel'); },
        choose: async type => { phase = type; calls.push('choose.' + type); },
        cancelConfirmation: async () => { calls.push('confirmation.cancel'); },
        confirm: async () => {
            ids.push((options.reusedId ? 'a' : phase === 'corrupt' ? 'a' : 'b').repeat(32));
            if (options.residue) remaining = ['incoming.zip'];
            calls.push('confirm.' + phase);
        },
        unchanged: async baseline => { assert.equal(baseline.canaryHash, 'before'); if (options.cancelMutates && !ids.length) throw Error('canary changed'); },
        waitRejected: async () => { calls.push('rejected'); },
        waitImported: async () => { if (options.pageNotReady) throw Error('WebView not ready'); calls.push('imported'); },
        snapshot: async () => ({ observedIds: options.missedIds ? [] : [...ids], remaining, backups: ids.length > 1 ? 1 : 0 }),
        stopMonitor: async () => { calls.push('monitor.stop'); },
    };
    return { api, calls };
}

test('import scenario requires picker cancel, confirmation cancel, rejection and true successful load', async () => {
    const { runImportScenario } = await load();
    const f = driver();
    const report = await runImportScenario(f.api);
    assert.equal(report.passed, true);
    assert.equal(report.observedIds.length, 2);
    assert.equal(f.calls.filter(c => c === 'picker').length, 4);
    assert.ok(f.calls.includes('picker.cancel') && f.calls.includes('confirmation.cancel') && f.calls.includes('rejected') && f.calls.includes('imported'));
});

test('missed or reused operation IDs, leftover files and an unloaded page cannot pass', async () => {
    const { runImportScenario } = await load();
    for (const options of [{ missedIds: true }, { reusedId: true }, { residue: true }, { pageNotReady: true }]) {
        const f = driver(options);
        assert.equal((await runImportScenario(f.api)).passed, false);
        assert.ok(f.calls.includes('monitor.stop'));
    }
});

test('cancelling an import must leave the synthetic canary unchanged', async () => {
    const { runImportScenario } = await load();
    const f = driver({ cancelMutates: true });
    assert.equal((await runImportScenario(f.api)).passed, false);
    assert.ok(!f.calls.includes('confirm.valid'));
    assert.ok(f.calls.includes('monitor.stop'));
});
