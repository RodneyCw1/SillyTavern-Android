import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const root = path.resolve(import.meta.dirname, '../..');
const serverRoot = path.join(root, 'server');
const data = process.argv[2], mode = process.argv[3];
process.chdir(serverRoot);
globalThis.DATA_ROOT = data;
const { setConfigFilePath } = await import('../../server/src/util.js');
setConfigFilePath(path.join(data, 'config.yaml'));
const { router, diskCache } = await import('../../server/src/endpoints/characters.js');
const { write, read } = await import('../../server/src/character-card-parser.js');
const require = createRequire(path.join(serverRoot, 'package.json'));
const express = require('express');
const extract = require('png-chunks-extract');
const directories = { characters: path.join(data, 'characters'), chats: path.join(data, 'chats') };
await fsp.mkdir(directories.characters, { recursive: true });
const file = path.join(directories.characters, 'fixture.png');
if (mode === 'save') {
    const image = await fsp.readFile(path.join(serverRoot, 'public/img/ai4.png'));
    const character = { name: 'fixture', data: { name: 'fixture', system_prompt: 'keep prompt', post_history_instructions: 'keep instructions',
        character_book: { entries: [{ content: 'keep worldbook' }] }, extensions: { other: { keep: true }, tavern_helper: { scripts: [] } } } };
    await fsp.writeFile(file, write(image, JSON.stringify(character)));
}
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.user = { profile: { handle: 'test' }, directories }; next(); });
app.use('/api/characters', router);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
const post = (endpoint, body) => fetch(base + '/api/characters/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
try {
    if (mode === 'save') {
        // Populate the old on-disk cache before saving, as an open card does.
        assert.equal((await post('get', { avatar_url: 'fixture.png' })).status, 200);
        const results = await Promise.all(Array.from({ length: 12 }, (_, i) => post('edit-extension', {
            avatar_url: 'fixture.png', field: 'field_' + i, value: { version: i, installed: ['download-' + i] },
        })));
        for (const result of results) assert.equal(result.status, 200, await result.text());
        for (const value of [
            { scripts: [{ id: 'workshop', content: 'import new version', data: { creative_workshop_install_registry: { fixture: { downloaded: true } } } }] },
            { scripts: [{ id: 'workshop', content: 'import newest version', data: { creative_workshop_install_registry: { fixture: { downloaded: true, second: true } } } }] },
        ]) {
            const result = await post('edit-extension', { avatar_url: 'fixture.png', field: 'tavern_helper', value });
            assert.equal(result.status, 200, await result.text());
        }
        const invalid = await post('edit-extension', { avatar_url: 'fixture.png', field: '__proto__', value: {} });
        assert.equal(invalid.status, 400);
        // Filesystem failure must never be acknowledged as a successful save.
        await fsp.rename(file, file + '.backup');
        await fsp.mkdir(file);
        const failed = await post('edit', { avatar_url: 'fixture.png', ch_name: 'fixture', description: 'new' });
        assert.equal(failed.status, 500);
        await fsp.rmdir(file); await fsp.rename(file + '.backup', file);
    }
    const disk = JSON.parse(read(fs.readFileSync(file)));
    const pixels = buffer => extract(new Uint8Array(buffer)).filter(chunk => chunk.name === 'IDAT').map(chunk => Buffer.from(chunk.data));
    assert.deepEqual(pixels(fs.readFileSync(file)), pixels(fs.readFileSync(path.join(serverRoot, 'public/img/ai4.png'))));
    assert.equal(disk.data.extensions.tavern_helper.scripts[0].content, 'import newest version');
    assert.equal(disk.data.extensions.tavern_helper.scripts[0].data.creative_workshop_install_registry.fixture.second, true);
    assert.equal(disk.data.extensions.other.keep, true);
    assert.equal(disk.data.system_prompt, 'keep prompt');
    assert.equal(disk.data.post_history_instructions, 'keep instructions');
    assert.equal(disk.data.character_book.entries[0].content, 'keep worldbook');
    for (let i = 0; i < 12; i++) assert.equal(disk.data.extensions['field_' + i].version, i);
    const result = await post('get', { avatar_url: 'fixture.png' });
    const loaded = await result.json();
    assert.equal(loaded.data.extensions.tavern_helper.scripts[0].content, 'import newest version');
    console.log(mode + ': workshop registry, newest script, other fields and PNG pixels retained');
} finally { diskCache.dispose(); server.closeAllConnections(); server.close(); }
