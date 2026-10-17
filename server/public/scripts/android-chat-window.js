/* Bound live message surfaces for cards that expand each turn into a large HTML page. */
export const ANDROID_CHAT_PAGE_SIZE = 2;
const restoredCharacters = new WeakSet();

/** Keep the selected history in small host settings instead of rewriting a large PNG. */
export function resolveAndroidChatSelection(character, selections) {
    if (!restoredCharacters.has(character)) {
        const saved = selections[character.avatar];
        if (typeof saved === 'string' && saved) character.chat = saved;
        restoredCharacters.add(character);
    }
    const changed = selections[character.avatar] !== character.chat;
    selections[character.avatar] = character.chat;
    return changed;
}

/** Display plugins may count a regex-expanded page instead of the small reply behind it. */
export function resolveAndroidTokenCountText(text, { android, document, messages, templates = [], matches = () => false }) {
    if (!android || typeof text !== 'string' || text.length < 256 * 1024 || !document?.querySelectorAll) return text;
    const elements = [...document.querySelectorAll('#chat > .mes')].reverse();
    for (const element of elements) {
        const message = messages[Number(element.getAttribute('mesid'))];
        if (!message || message.is_user || typeof message.mes !== 'string' || message.mes.length >= 256 * 1024) continue;
        for (const code of element.querySelectorAll('.mes_text pre code')) {
            const html = code.textContent;
            if (html.length >= 256 * 1024 && /<!doctype\s+html|<html\b/i.test(html.slice(0, 2048)) && text.includes(html)) {
                return (message.extra?.reasoning || '') + message.mes;
            }
        }
    }
    // A plugin's delayed counter can run after its old message was paged out.
    // Only recognize a standalone, known display-only template, never a large prompt.
    for (const template of templates) {
        const replacement = template.replaceString;
        if (template.disabled || !template.markdownOnly || template.promptOnly || !template.placement?.includes(2)
            || typeof replacement !== 'string' || replacement.length < 256 * 1024) continue;
        const start = replacement.slice(0, 4096).search(/<!doctype\s+html|<html\b/i);
        if (start < 0) continue;
        const signature = replacement.slice(start, start + 256).replaceAll('\r\n', '\n');
        const position = text.indexOf(signature);
        if (position < 0 || position > 4096 || text.length < replacement.length * .8 || text.length > replacement.length + 8192) continue;
        for (let id = messages.length - 1; id >= 0; id--) {
            const message = messages[id];
            if (!message?.is_user && !message?.is_system && typeof message?.mes === 'string'
                && message.mes.length < 256 * 1024 && matches(template, message.mes)) {
                return (message.extra?.reasoning || '') + message.mes;
            }
        }
    }
    return text;
}

export function getAndroidChatWindow({ android, scripts, total, end = total }) {
    if (!android || total < 1 || !scripts.some(script =>
        !script.disabled && script.markdownOnly && script.placement?.includes(2)
        && typeof script.replaceString === 'string' && script.replaceString.length >= 256 * 1024
        && /<!doctype\s+html|<html\b|```html/i.test(script.replaceString.slice(0, 2048)))) {
        return null;
    }
    end = Math.max(1, Math.min(total, Number.isFinite(end) ? Math.trunc(end) : total));
    return { start: Math.max(0, end - ANDROID_CHAT_PAGE_SIZE), end, total };
}

export function createAndroidChatNavigation(document, range) {
    if (!range || range.total <= ANDROID_CHAT_PAGE_SIZE) return null;
    const navigation = document.createElement('div');
    navigation.id = 'android_chat_navigation';
    navigation.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;padding:8px;flex-shrink:0';
    const label = document.createElement('span');
    label.textContent = `${range.start + 1}–${range.end} / ${range.total} 条`;
    navigation.append(label);
    for (const [action, text, disabled] of [
        ['older', '较早对话', range.start === 0],
        ['newer', '较新对话', range.end === range.total],
        ['latest', '回到最新', range.end === range.total],
    ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button';
        button.dataset.androidChatPage = action;
        button.textContent = text;
        button.disabled = disabled;
        navigation.append(button);
    }
    return navigation;
}
