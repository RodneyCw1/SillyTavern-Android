import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, process.argv[2] || 'docs/source-before-1.1.0.json'), 'utf8').replace(/^\uFEFF/, ''));
const changed = [];
for (const file of snapshot.files) {
    const current = path.join(snapshot.sourceRoot, file.path);
    if (!fs.existsSync(current) || crypto.createHash('sha256').update(fs.readFileSync(current)).digest('hex').toUpperCase() !== file.sha256) changed.push(file.path);
}
const status = execFileSync('git', ['-C', snapshot.sourceRoot, 'status', '--short'], { encoding: 'utf8' }).trimEnd().split(/\r?\n/);
const statusMatches = JSON.stringify(status) === JSON.stringify(snapshot.status);
const report = { filesChecked: snapshot.files.length, changed, statusMatches };
fs.writeFileSync(path.join(root, 'docs/source-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (changed.length || !statusMatches) process.exitCode = 1;
