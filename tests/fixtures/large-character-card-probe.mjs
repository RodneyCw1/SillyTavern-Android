import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { read, write } from '../../server/src/character-card-parser.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const image = fs.readFileSync(new URL('../../server/public/img/ai4.png', import.meta.url));
const card = { spec: 'chara_card_v2', spec_version: '2.0', data: {
    name: 'Large synthetic card 中文😀', character_book: { entries: [{ content: 'Keep worldbook' }] },
    extensions: { regex_scripts: [{ replaceString: 'x'.repeat(16 * 1024 * 1024) }] },
} };
const expected = hash(card.data.extensions.regex_scripts[0].replaceString);
let png = write(image, JSON.stringify(card));
assert.ok(png.length > 40 * 1024 * 1024);
let loaded = JSON.parse(read(png));
assert.equal(hash(loaded.data.extensions.regex_scripts[0].replaceString), expected);
loaded.data.extensions.saved = true;
png = write(png, JSON.stringify(loaded));
loaded = JSON.parse(read(png));
assert.equal(loaded.data.extensions.saved, true);
assert.equal(loaded.data.name, card.data.name);
assert.equal(loaded.data.character_book.entries[0].content, 'Keep worldbook');
assert.equal(hash(loaded.data.extensions.regex_scripts[0].replaceString), expected);
console.log('large card round trip preserved', JSON.stringify({ bytes: png.length, memory: process.memoryUsage(), maxRSS: process.resourceUsage().maxRSS }));
