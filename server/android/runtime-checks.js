import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function checkRuntime(home) {
    const file = path.join(home, '运行时读写验证.tmp');
    const text = '中文、emoji 😀 和流式 UTF-8';
    await fs.writeFile(file, text);
    assert.equal(await fs.readFile(file, 'utf8'), text);
    await fs.unlink(file);
    assert.ok(/^\p{Script=Han}+$/u.test('中文'));
    assert.equal(new Intl.NumberFormat('zh-CN').format(1234), '1,234');
    const wasm = await WebAssembly.instantiate(Buffer.from('0061736d010000000105016000017f0302010007070103616e7300000a06010400412a0b', 'hex'));
    assert.equal(wasm.instance.exports.ans(), 42);
    // Exercise Android explicit bounds checks, including memory after growth.
    const memoryModule = await WebAssembly.instantiate(Buffer.from('0061736d0100000001060160017f017f03020100050401010102071102046c6f61640000066d656d6f727902000a0901070020002802000b', 'hex'));
    const { memory, load } = memoryModule.instance.exports;
    new Uint32Array(memory.buffer)[0] = 123;
    assert.equal(load(0), 123);
    assert.throws(() => load(65536), WebAssembly.RuntimeError);
    assert.equal(memory.grow(1), 1);
    assert.equal(load(65536), 0);
    assert.throws(() => load(131072), WebAssembly.RuntimeError);
    assert.throws(() => memory.grow(1), RangeError);
    const report = { node: process.version, platform: process.platform, arch: process.arch, icu: process.versions.icu, pageSize: Number(process.env.ST_ANDROID_PAGE_SIZE) || null, fileReadWrite: true, unicodeProperties: true, intl: true, wasm: true, wasmMemoryBounds: true, wasmMemoryGrowth: true };
    await fs.writeFile(path.join(home, 'runtime-checks.json'), JSON.stringify(report, null, 2));
    console.log('Android runtime checks passed:', report);
}
