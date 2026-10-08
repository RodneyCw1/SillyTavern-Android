/* Android host transport; dormant in ordinary SillyTavern browsers. */
(() => {
    'use strict';
    if (location.origin !== 'http://127.0.0.1:17614') return;
    const originalFetch = window.fetch.bind(window);
    const generationPaths = new Set(['/api/backends/chat-completions/generate', '/api/backends/text-completions/generate', '/api/backends/kobold/generate', '/api/novelai/generate']);
    const active = new Map();
    const restoring = new Map();
    const hostCalls = new Map();
    let generationType = null;
    let contextReady = false;
    const getContext = () => { try { return window.SillyTavern?.getContext?.(); } catch (error) { if (error instanceof ReferenceError) return null; throw error; } };
    const headers = () => getContext()?.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    function host(method, data) {
        if (!window.AndroidHost) return Promise.reject(new Error('请更新 Android System WebView 后重试'));
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { hostCalls.delete(id); reject(new Error('原生操作超时')); }, 30000);
            hostCalls.set(id, { resolve, reject, timeout });
            window.AndroidHost.postMessage(JSON.stringify({ id, method, data }));
        });
    }
    if (window.AndroidHost) window.AndroidHost.onmessage = event => {
        const message = JSON.parse(event.data);
        const pending = hostCalls.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timeout); hostCalls.delete(message.id);
        message.ok ? pending.resolve(message.result) : pending.reject(new Error(message.error));
    };
    async function exportBlob(blob, name) {
        const downloadId = await host('download.begin', { name, mime: blob.type || 'application/octet-stream' });
        for (let offset = 0; offset < blob.size; offset += 65536) {
            const bytes = new Uint8Array(await blob.slice(offset, offset + 65536).arrayBuffer());
            let binary = '';
            for (const byte of bytes) binary += String.fromCharCode(byte);
            await host('download.chunk', { downloadId, base64: btoa(binary) });
        }
        await host('download.finish', { downloadId });
    }
    function describeContext() {
        const ctx = getContext();
        if (!ctx) return { type: 'plugin' };
        return {
            type: generationType || 'plugin', avatar: ctx.characters[ctx.characterId]?.avatar,
            groupId: ctx.groupId || null, chatId: ctx.chatId, name: ctx.name2,
            chatLength: ctx.chat.length, previousText: generationType === 'continue' ? String(ctx.chat.at(-1)?.mes || '').slice(0, 32000) : '',
        };
    }
    function sameChat(context, ctx = getContext()) {
        return !!ctx && context.chatId === ctx.chatId && (context.groupId || null) === (ctx.groupId || null) && context.avatar === ctx.characters[ctx.characterId]?.avatar;
    }
    async function cancel(id) {
        await originalFetch('/api/android/jobs/' + id + '/cancel', { method: 'POST', headers: headers(), body: '{}' });
    }
    async function acknowledge(id) {
        await originalFetch('/api/android/jobs/' + id + '/ack', { method: 'POST', headers: headers(), body: '{}' });
        active.delete(id);
    }
    async function receive(job, signal) {
        let offset = 0;
        let disposed = false;
        let activeReader;
        let response = await originalFetch('/api/android/jobs/' + job.id + '/content?offset=0', { signal });
        const status = response.status, contentType = response.headers.get('content-type');
        const stream = new ReadableStream({
            async start(controller) {
                let failures = 0;
                while (!disposed) {
                    try {
                        const reader = response.body.getReader();
                        activeReader = reader;
                        while (true) {
                            const chunk = await reader.read();
                            if (disposed) return;
                            if (chunk.done) break;
                            offset += chunk.value.byteLength;
                            controller.enqueue(chunk.value);
                        }
                        const info = await (await originalFetch('/api/android/jobs/' + job.id, { signal })).json();
                        if (['complete', 'failed', 'cancelled', 'interrupted'].includes(info.state)) {
                            job.delivered = info.state === 'complete';
                            if (info.state === 'interrupted' || info.state === 'cancelled' || info.state === 'failed' && info.status < 400) controller.error(new Error('生成已中断，已接收的内容保存在恢复结果中'));
                            else controller.close();
                            return;
                        }
                    } catch (error) {
                        if (disposed) return;
                        if (signal?.aborted) { controller.error(error); return; }
                        if (++failures > 120) { controller.error(new Error('连接中断；返回应用后可从“恢复结果”查看')); return; }
                    }
                    await wait(Math.min(1000 * (failures + 1), 5000));
                    try { response = await originalFetch('/api/android/jobs/' + job.id + '/content?offset=' + offset, { signal }); }
                    catch (error) { if (signal?.aborted) { controller.error(error); return; } failures++; }
                }
            },
            cancel() { disposed = true; activeReader?.cancel().catch(() => {}); /* Model request remains owned by the backend. */ },
        });
        return new Response(stream, { status, headers: { 'Content-Type': contentType || 'application/octet-stream' } });
    }
    window.fetch = async function(input, options = {}) {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
        if (url.origin !== location.origin) return originalFetch(input, options);
        if (generationPaths.has(url.pathname) && (options.method || input.method || 'GET').toUpperCase() === 'POST') {
            const rawBody = options.body ?? (input instanceof Request ? await input.clone().text() : '{}');
            const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
            const id = crypto.randomUUID();
            const context = describeContext();
            const signal = options.signal || input.signal;
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const started = await originalFetch('/api/android/jobs', { method: 'POST', headers: options.headers || (input instanceof Request ? input.headers : headers()), body: JSON.stringify({ id, endpoint: url.pathname, body, context }) });
            if (!started.ok) return started;
            const job = await started.json();
            active.set(id, job);
            const abort = () => { cancel(id).catch(console.error); };
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            return receive(job, signal);
        }
        const isSave = ['/api/chats/save', '/api/chats/group/save'].includes(url.pathname) && options.method === 'POST';
        const completed = [];
        let restoredId;
        if (isSave && typeof options.body === 'string') {
            const data = JSON.parse(options.body);
            const ctx = getContext();
            for (const job of active.values()) {
                if (!sameChat(job.context, ctx) || job.context.type === 'plugin' || job.context.type === 'quiet') continue;
                const expectedIndex = ['continue', 'swipe'].includes(job.context.type) ? job.context.chatLength - 1 : job.context.chatLength;
                if (ctx.chat.length - 1 !== expectedIndex) continue;
                const message = ctx?.chat?.at(-1);
                if (message && !message.is_user) {
                    message.extra ||= {};
                    message.extra.android_job_id = job.id;
                    if (job.delivered) { message.extra.android_job_complete = true; completed.push(job.id); }
                    const saved = data.chat?.at(-1);
                    if (saved) { saved.extra ||= {}; Object.assign(saved.extra, message.extra); }
                }
            }
            const lastId = data.chat?.at(-1)?.extra?.android_job_id;
            if (lastId && restoring.has(lastId)) restoredId = lastId;
            options = { ...options, body: JSON.stringify(data) };
        }
        const response = await originalFetch(input, options);
        if (isSave && response.ok) {
            if (restoredId) restoring.set(restoredId, true);
            for (const id of completed) await acknowledge(id);
        }
        return response;
    };
    function extractText(raw, job) {
        if (!raw.trim()) return '';
        try {
            const object = JSON.parse(raw);
            return getContext()?.extractMessageFromData?.(object, job.endpoint.includes('chat-completions') ? 'openai' : 'textgenerationwebui') ||
                object.choices?.[0]?.message?.content || object.choices?.[0]?.text || object.results?.[0]?.text || object.output || '';
        } catch { /* Streaming response. */ }
        let text = '';
        for (const line of raw.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            try {
                const item = JSON.parse(line.slice(5).trim());
                const value = item.choices?.[0]?.delta?.content ?? item.choices?.[0]?.text ?? item.delta?.text ?? item.token ?? item.text ?? item.content;
                if (typeof value === 'string') text += value;
            } catch { /* [DONE] and incomplete final chunks contain no text. */ }
        }
        return text;
    }
    async function restore(job, text) {
        const ctx = getContext();
        if (!sameChat(job.context, ctx)) throw new Error('请先打开这条回复原来的角色和聊天，再恢复');
        if (!['normal', 'regenerate', 'continue'].includes(job.context.type)) throw new Error('这条结果来自插件或特殊生成，请使用复制或导出');
        const old = ctx.chat.find(m => m.extra?.android_job_id === job.id);
        if (old?.extra?.android_job_complete) { await acknowledge(job.id); return; }
        const length = job.context.chatLength;
        let type = 'normal';
        if (job.context.type === 'continue') {
            if (ctx.chat.length !== length) throw new Error('聊天已发生变化，请复制结果后手动处理');
            type = 'appendFinal'; text = (job.context.previousText || '') + text;
        } else if (old && old === ctx.chat.at(-1)) type = 'appendFinal';
        else if (ctx.chat.length !== length) throw new Error('聊天已发生变化，请复制结果后手动处理');
        if (!old?.extra?.android_job_restored) await ctx.saveReply({ type, getMessage: text });
        const message = ctx.chat.at(-1);
        message.extra ||= {};
        message.extra.android_job_id = job.id;
        message.extra.android_job_complete = true;
        message.extra.android_job_restored = true;
        restoring.set(job.id, false);
        try {
            await ctx.saveChat();
            if (!restoring.get(job.id)) {
                message.extra.android_job_complete = false;
                throw new Error('聊天未能保存，生成结果仍然保留，请解决保存错误后重试');
            }
            await acknowledge(job.id);
        } finally { restoring.delete(job.id); }
    }
    async function showRecovery() {
        try {
            const jobs = await (await originalFetch('/api/android/jobs')).json();
            document.getElementById('st-android-recovery')?.remove();
            const panel = document.createElement('dialog');
            panel.id = 'st-android-recovery';
            panel.style.cssText = 'width:92vw;max-width:650px;max-height:80vh;overflow:auto;background:#242731;color:#eee;border:1px solid #cfb58b;border-radius:12px;padding:18px';
            const title = document.createElement('h3'); title.textContent = '已保存的生成结果'; panel.append(title);
            const close = document.createElement('button'); close.textContent = '关闭'; close.onclick = () => panel.remove(); panel.append(close);
            if (!jobs.length) { const p = document.createElement('p'); p.textContent = '没有待恢复的结果。'; panel.append(p); }
            for (const job of jobs) {
                const section = document.createElement('section');
                const label = document.createElement('p');
                label.textContent = (job.context?.name || '插件生成') + ' · ' + job.state + ' · ' + new Date(job.createdAt).toLocaleString();
                section.append(label);
                if (!['complete', 'failed', 'interrupted', 'cancelled'].includes(job.state)) {
                    const stop = document.createElement('button'); stop.textContent = '停止生成'; stop.onclick = async () => { await cancel(job.id); await showRecovery(); }; section.append(stop);
                } else {
                    const raw = await (await originalFetch('/api/android/jobs/' + job.id + '/content')).text();
                    const recoveredText = extractText(raw, job);
                    const text = recoveredText || raw;
                    const area = document.createElement('textarea'); area.value = text; area.readOnly = true; area.style.cssText = 'width:100%;height:140px'; section.append(area);
                    const button = (label, fn) => {
                        const b = document.createElement('button'); b.textContent = label;
                        b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { alert(e.message); } finally { b.disabled = false; } };
                        section.append(b);
                    };
                    button('恢复到原聊天', async () => { if (!recoveredText) throw new Error('这条结果没有可恢复的回复，请复制或导出原始结果'); await restore(job, recoveredText); await showRecovery(); });
                    button('复制', () => host('clipboard.write', { text }));
                    button('导出原始结果', () => exportBlob(new Blob([raw], { type: 'text/plain' }), 'generation-' + job.id + '.txt'));
                    button('标记已处理', async () => { await acknowledge(job.id); await showRecovery(); });
                }
                panel.append(section);
            }
            document.body.append(panel); panel.showModal();
        } catch (error) { alert('读取恢复结果失败：' + error.message); }
    }
    function back() {
        const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
        if (dialog) { dialog.close(); return true; }
        const popup = [...document.querySelectorAll('.popup-button-close, .popup-button-cancel, .drawer-icon.openIcon')].find(e => e.getClientRects().length);
        if (popup) { popup.click(); return true; }
        return false;
    }
    window.STAndroid = { showRecovery, back, exportBlob, host };
    document.addEventListener('click', event => {
        const anchor = event.target.closest?.('a[download]');
        if (!anchor || !anchor.href || !window.AndroidHost) return;
        event.preventDefault();
        originalFetch(anchor.href).then(r => r.blob()).then(blob => exportBlob(blob, anchor.download || 'sillytavern-export')).catch(error => alert(error.message));
    }, true);
    const bootstrap = setInterval(() => {
        const ctx = getContext();
        if (!ctx || contextReady) return;
        contextReady = true; clearInterval(bootstrap);
        ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, (type, _options, dryRun) => { if (!dryRun) generationType = type || 'normal'; });
        ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED, () => { generationType = null; });
        ctx.eventSource.on(ctx.eventTypes.GENERATION_STOPPED, () => {
            for (const job of active.values()) if (!job.delivered) cancel(job.id).catch(console.error);
        });
    }, 100);
})();
