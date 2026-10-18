/** Keep large HTML documents out of text regexes and Markdown's span parser. */
export function protectAndroidHtmlBlocks(text, { android, render = false }) {
    const blocks = [];
    const unchanged = { text, restore: value => value };
    if (!android || typeof text !== 'string' || text.length < 256 * 1024) return unchanged;

    let nonce = 0;
    while (text.includes(`STANDROIDHTML${nonce}BLOCK`)) nonce++;
    const fences = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/gm;
    const parts = [];
    let copied = 0;
    for (let opening; (opening = fences.exec(text));) {
        const start = fences.lastIndex;
        const closing = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*(?:\\r?\\n|$)`, 'gm');
        closing.lastIndex = start;
        const end = closing.exec(text);
        const contentEnd = end ? end.index : text.length;
        const blockEnd = end ? closing.lastIndex : text.length;
        // A closing fence belongs to this block even when it is ordinary code.
        fences.lastIndex = blockEnd;
        if (!/^(?:html)?\s*$/i.test(opening[2]) || contentEnd - start < 256 * 1024
            || !/<!doctype\s+html\b|<html\b/i.test(text.slice(start, start + 2048))) continue;

        const token = `STANDROIDHTML${nonce}BLOCK${blocks.length}END`;
        const content = text.slice(start, contentEnd);
        blocks.push({ token, value: render
            ? content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
            : text.slice(opening.index, blockEnd) });
        parts.push(text.slice(copied, opening.index), render ? `<pre><code>${token}</code></pre>\n` : token);
        copied = blockEnd;
    }
    if (!blocks.length) return unchanged;
    parts.push(text.slice(copied));
    return {
        text: parts.join(''),
        restore: value => {
            for (const block of blocks) value = value.replaceAll(block.token, () => block.value);
            return value;
        },
    };
}
