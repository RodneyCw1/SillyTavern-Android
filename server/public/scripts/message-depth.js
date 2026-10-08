/**
 * Counts non-system messages after the requested message for regex placement.
 * Avoids allocating a wrapper object for every message on each streaming update.
 * @param {Array<{is_system?: boolean}>} messages Chat messages.
 * @param {number|string} messageId Message index.
 * @returns {number|undefined} Depth, or undefined for a system/missing message.
 */
export function getMessageDepth(messages, messageId) {
    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0 || index >= messages.length || !messages[index] || messages[index].is_system) {
        return undefined;
    }
    let depth = 0;
    for (let i = messages.length - 1; i > index; i--) {
        if (messages[i] && !messages[i].is_system) depth++;
    }
    return depth;
}
