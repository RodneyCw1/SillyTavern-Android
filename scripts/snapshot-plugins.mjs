import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const base = path.join(root, 'server/android/bundled-extensions');
const plugins = [];
for (const name of ['JS-Slash-Runner', 'opening-preset-forge', 'ST-Prompt-Template']) {
    const folder = path.join(base, name);
    const originFile = path.join(folder, '.android-origin.json');
    let origin;
    if (fs.existsSync(path.join(folder, '.git'))) {
        const git = args => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' }).trim();
        origin = { url: git(['remote', 'get-url', 'origin']), branch: git(['branch', '--show-current']) || 'main', commit: git(['rev-parse', 'HEAD']) };
        fs.writeFileSync(originFile, JSON.stringify(origin, null, 2));
        const metadata = path.resolve(folder, '.git');
        if (!metadata.startsWith(base + path.sep) || path.basename(metadata) !== '.git') throw new Error('Unexpected metadata location');
        const backup = path.join(root, '.local/plugin-git', name);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.cpSync(metadata, backup, { recursive: true });
        fs.rmSync(metadata, { recursive: true });
    } else origin = JSON.parse(fs.readFileSync(originFile, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json')));
    plugins.push({ name, version: manifest.version, ...origin });
}
fs.writeFileSync(path.join(root, 'docs/plugins-lock.json'), JSON.stringify(plugins, null, 2));
console.log(JSON.stringify(plugins, null, 2));
