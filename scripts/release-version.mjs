import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
export const releaseConfig = JSON.parse(fs.readFileSync(path.join(root, 'release-config.json'), 'utf8'));
export function releaseVersion(env = process.env) {
    const versionCode = Number(env.ST_ANDROID_VERSION_CODE || 8);
    const versionName = env.ST_ANDROID_VERSION_NAME || releaseConfig.baseVersion + '-dev';
    if (!Number.isSafeInteger(versionCode) || versionCode < 8 || versionCode > 2100000000) throw new Error('Invalid Android version code');
    if (!/^[\w.+-]{1,100}$/.test(versionName)) throw new Error('Invalid Android version name');
    return { versionCode, versionName };
}
