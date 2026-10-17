import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { read, write } from '../server/src/character-card-parser.js';
import encode from '../server/src/png/encode.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const extract = require('png-chunks-extract');
const image = fs.readFileSync(new URL('../server/public/img/ai4.png', import.meta.url));
const text = (keyword, content) => ({ name: 'tEXt', data: Buffer.from(keyword + '\0' + content, 'latin1') });
function withText(...metadata) {
    const chunks = extract(image).filter(chunk => chunk.name !== 'tEXt');
    chunks.splice(-1, 0, ...metadata);
    return Buffer.from(encode(chunks));
}

test('card reader prefers the first case-insensitive V3 chunk and retains UTF-8 data', () => {
    const v2 = JSON.stringify({ name: 'V2' });
    const v3 = JSON.stringify({ name: '中文角色😀' });
    assert.equal(read(withText(text('ChArA', Buffer.from(v2).toString('base64')), text('CCV3', Buffer.from(v3).toString('base64')), text('ccv3', 'e30='))), v3);
    assert.equal(read(withText(text('CHARA', Buffer.from(v2).toString('base64')))), v2);
});

test('metadata replacement keeps pixels and unrelated text while replacing both card chunks', () => {
    const input = withText(text('Author', 'Keep this'), text('ChArA', 'e30='), text('CCV3', 'e30='));
    const data = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '角色', extensions: { keep: true } } });
    const output = write(input, data);
    const chunks = extract(output);
    assert.deepEqual(chunks.filter(chunk => chunk.name === 'IDAT'), extract(input).filter(chunk => chunk.name === 'IDAT'));
    const metadata = chunks.filter(chunk => chunk.name === 'tEXt').map(chunk => Buffer.from(chunk.data).toString('latin1'));
    assert.equal(metadata.length, 3);
    assert.equal(metadata[0], 'Author\0Keep this');
    const loaded = JSON.parse(read(output));
    assert.equal(loaded.spec, 'chara_card_v3');
    assert.equal(loaded.data.name, '角色');
    assert.equal(loaded.data.extensions.keep, true);
});

test('card parsing still rejects missing metadata, corrupt CRCs and embedded NULL text', () => {
    assert.throws(() => read(withText()), /No PNG metadata/);
    assert.throws(() => read(withText(text('Author', 'Keep'))), /No PNG metadata/);
    assert.throws(() => read(withText(text('chara', 'e30=\0'))), /Invalid NULL/);
    const corrupt = withText(text('chara', 'e30='));
    corrupt[corrupt.length - 13] ^= 1;
    assert.throws(() => read(corrupt), /CRC/);
});

test('large dual-metadata cards can be read, edited and reloaded within a 256 MiB JS heap', () => {
    const result = spawnSync(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('./fixtures/large-character-card-probe.mjs', import.meta.url))], {
        encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /large card round trip preserved/);
});
