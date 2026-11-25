import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { persistCharXAssets } from '../server/src/charx.js';

test('CharX stores a sprite under its character and skips assets for an unnamed character', async t => {
    const characters = await fs.mkdtemp(path.join(os.tmpdir(), 'st-charx-assets-'));
    t.after(() => fs.rm(characters, { recursive: true, force: true }));

    const sprite = { storageCategory: 'sprite', zipPath: 'assets/smile.png', baseName: 'smile', ext: 'png' };
    const bytes = Buffer.from('test sprite');
    const buffers = new Map([[sprite.zipPath, bytes]]);

    const skipped = persistCharXAssets([sprite], buffers, { characters }, '');
    assert.deepEqual(skipped, { sprites: 0, backgrounds: 0, misc: 0 });
    assert.deepEqual(await fs.readdir(characters), []);

    const saved = persistCharXAssets([sprite], buffers, { characters }, 'Mira');
    assert.deepEqual(saved, { sprites: 1, backgrounds: 0, misc: 0 });
    assert.deepEqual(await fs.readFile(path.join(characters, 'Mira', 'smile.png')), bytes);
});
