import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function inside(root, relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(x => !x || x === '.' || x === '..' || x.includes(':'))) throw new Error('Invalid relative path');
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('Path escapes destination');
    return resolved;
}
export async function atomicJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fsp.rename(temp, file);
}
export async function sha256(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}
export async function replaceDirectory(staged, destination) {
    const backup = destination + '.previous-' + crypto.randomUUID();
    const exists = fs.existsSync(destination);
    if (exists) await fsp.rename(destination, backup);
    try {
        await fsp.rename(staged, destination);
    } catch (error) {
        if (exists) await fsp.rename(backup, destination);
        throw error;
    }
    return exists ? backup : null;
}
export const USER_FOLDERS = new Set(['assets', 'backgrounds', 'characters', 'chats', 'context', 'group chats', 'groups', 'instruct', 'KoboldAI Settings', 'movingUI', 'NovelAI Settings', 'OpenAI Settings', 'QuickReplies', 'reasoning', 'sysprompt', 'TextGen Settings', 'themes', 'user', 'User Avatars', 'vectors', 'worlds']);
export const USER_FILES = new Set(['settings.json', 'stats.json']);
export function isMigrationPath(relative) {
    const parts = relative.split('/');
    if (parts.some(x => x.startsWith('.') || /^(secrets?|credentials?|config)\.(json|ya?ml)$/i.test(x))) return false;
    return USER_FILES.has(relative) || (parts.length > 1 && USER_FOLDERS.has(parts[0]));
}
const credentialKey = /^(?:api[_-]?key|(?:.+[_-])api[_-]?key|api[_-]?secret|password|proxy[_-]?password|authorization|access[_-]?token|refresh[_-]?token|cookie|custom_include_headers|custom_headers|requestHeaders)$/i;
export function stripCredentials(value, changes = [], prefix = '') {
    if (Array.isArray(value)) return value.map((v, i) => stripCredentials(v, changes, prefix + '[' + i + ']'));
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        const location = prefix ? prefix + '.' + key : key;
        if (credentialKey.test(key)) {
            result[key] = typeof item === 'string' ? '' : null;
            changes.push(location);
        } else if (typeof item === 'string' && /url|endpoint|reverse[_-]?proxy/i.test(key) && /^https?:\/\//i.test(item)) {
            try {
                const url = new URL(item);
                if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
                    result[key] = '';
                    changes.push(location);
                } else {
                    url.username = ''; url.password = '';
                    for (const param of [...url.searchParams.keys()]) if (/key|token|secret|auth/i.test(param)) url.searchParams.delete(param);
                    result[key] = url.toString();
                    if (result[key] !== item) changes.push(location);
                }
            } catch {
                // An invalid proxy URL may still contain credentials; never
                // fall back to exporting the unsanitized original string.
                result[key] = '';
                changes.push(location);
            }
        } else result[key] = stripCredentials(item, changes, location);
    }
    return result;
}
