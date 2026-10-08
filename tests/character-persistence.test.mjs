import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
test('HTTP character saves retain workshop downloads and script updates across a new server process', async t => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'st-card-save-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    await fsp.writeFile(path.join(dir, 'config.yaml'), 'performance:\n  useDiskCache: true\n');
    for (const mode of ['save', 'restart']) {
        const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'fixtures/character-persistence-probe.mjs'), dir, mode], { encoding: 'utf8', timeout: 20000 });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /workshop registry.*retained/);
    }
});
