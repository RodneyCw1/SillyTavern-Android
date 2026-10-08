import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const server = process.env.ST_MULTER_REGRESSION_SERVER || path.join(root, 'server');

test('R03 malformed multipart field names return an error without terminating the HTTP server', () => {
    const result = spawnSync(process.execPath, [path.join(root, 'tests/fixtures/multer-http-probe.mjs'), server], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.match(result.stdout, /same server accepts the next request/);
});

test('R03 the declared, locked and installed Multer dependency all use the patched version', async () => {
    const read = async file => JSON.parse(await fs.readFile(path.join(server, file), 'utf8'));
    assert.equal((await read('package.json')).dependencies.multer, '2.3.0');
    assert.equal((await read('package-lock.json')).packages['node_modules/multer'].version, '2.3.0');
    assert.equal((await read('node_modules/multer/package.json')).version, '2.3.0');
});
