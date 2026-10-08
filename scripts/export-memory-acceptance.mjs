import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { getSourceHash } from './source-inventory.mjs';
import { writeAcceptanceReport } from './android-test-tools.mjs';

const root = path.resolve(import.meta.dirname, '..');
const workspace = await fs.mkdtemp(path.join(root, '.local/export-memory-'));
const meter = path.join(workspace, 'meter.mjs');
await fs.writeFile(meter, `import fs from 'node:fs';
let peak=process.memoryUsage().rss;const initial=peak;
const sample=()=>{peak=Math.max(peak,process.memoryUsage().rss);};
const timer=setInterval(sample,10);timer.unref();
process.on('exit',()=>{sample();fs.writeFileSync(process.env.ST_MEMORY_REPORT,JSON.stringify({initial,peak,maxRSS:process.resourceUsage().maxRSS*1024}));});`);
const report = { passed: false, device: 'windows-export-process', scope: 'Synthetic desktop migration export RSS; not Android process memory', checks: [], runs: [] };
let failure;
try {
    report.appVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
    report.sourceHash = await getSourceHash(root);
    report.runtimeSha256 = JSON.parse(await fs.readFile(path.join(root, 'android/app/src/main/assets/runtime.json'), 'utf8')).runtimeSha256;
    const source = path.join(workspace, 'user');
    await fs.mkdir(path.join(source, 'assets'), { recursive: true });
    await fs.writeFile(path.join(source, 'settings.json'), JSON.stringify({ proxy_password: 'synthetic-only', test: 'export-memory' }));
    const block = crypto.randomBytes(1024 ** 2);
    for (const mebibytes of [16, 256]) {
        const asset = await fs.open(path.join(source, 'assets/fixture.bin'), 'w');
        try { for (let i = 0; i < mebibytes; i++) await asset.write(block); } finally { await asset.close(); }
        const reading = path.join(workspace, `rss-${mebibytes}.json`);
        const child = spawn(process.execPath, ['--import', pathToFileURL(meter).href, path.join(root, 'scripts/export-migration.mjs'), source, path.join(workspace, `export-${mebibytes}.zip`)], {
            cwd: root, windowsHide: true, env: { ...process.env, ST_MEMORY_REPORT: reading }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', part => { output += part; });
        child.stderr.on('data', part => { output += part; });
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, output);
        const measurement = JSON.parse(await fs.readFile(reading, 'utf8'));
        report.runs.push({ inputBytes: mebibytes * 1024 ** 2, ...measurement, peakIncrease: measurement.peak - measurement.initial });
    }
    const difference = report.runs[1].peak - report.runs[0].peak;
    report.peakDifference = difference;
    assert.ok(difference < 96 * 1024 ** 2, 'Increasing a binary asset by 240 MiB must not add 96 MiB or more to peak RSS');
    report.checks.push({ id: 'bounded-binary-export', required: true, passed: true, description: '16 MiB and 256 MiB incompressible binary exports complete; peak RSS increase stays below 96 MiB.' });
    assert.equal(await getSourceHash(root), report.sourceHash, 'Source changed while measuring');
    report.passed = true;
} catch (error) { report.error = error.message; failure = error; }
finally {
    report.fixtureDirectory = path.relative(root, workspace).replaceAll('\\', '/');
    const evidence = await writeAcceptanceReport(root, 'export-memory', report);
    console.log(JSON.stringify({ ...report, evidence }, null, 2));
}
if (failure) { console.error(failure.message); process.exitCode = 1; }
