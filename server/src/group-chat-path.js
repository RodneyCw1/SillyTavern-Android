import path from 'node:path';
import sanitize from 'sanitize-filename';
import { isPathUnderParent } from './util.js';

/**
 * Resolves a group chat ID without changing it into a different filename.
 * Numeric IDs are retained for older groups.
 * @param {string} directory Group chat directory
 * @param {unknown} chatId Chat ID
 * @returns {string|null} Contained path, or null for an invalid ID
 */
export function getGroupChatPath(directory, chatId) {
    if (typeof chatId !== 'string' && !(typeof chatId === 'number' && Number.isFinite(chatId))) {
        return null;
    }
    const id = String(chatId);
    if (!id || sanitize(id) !== id) {
        return null;
    }
    const filePath = path.resolve(directory, `${id}.jsonl`);
    return isPathUnderParent(directory, filePath) ? filePath : null;
}
