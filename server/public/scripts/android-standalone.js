/* Android host transport; dormant in ordinary SillyTavern browsers. */
(() => {
    'use strict';
    if (location.origin !== 'http://127.0.0.1:17614') return;
    const originalFetch = window.fetch.bind(window);
    const generationPaths = new Set(['/api/backends/chat-completions/generate', '/api/backends/text-completions/generate', '/api/backends/kobold/generate', '/api/novelai/generate']);
    const active = new Map();
    const restoring = new Map();
    const hostCalls = new Map();
    const pendingSaves = new Set();
    let recoveryPanel = null;
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
    async function exportResponse(response, name) {
        if (!response.ok) throw new Error('导出失败：' + response.status);
        const downloadId = await host('download.begin', { name, mime: response.headers.get('content-type') || 'application/octet-stream' });
        const reader = response.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                for (let offset = 0; offset < value.length; offset += 65536) {
                    let binary = '';
                    for (const byte of value.subarray(offset, offset + 65536)) binary += String.fromCharCode(byte);
                    await host('download.chunk', { downloadId, base64: btoa(binary) });
                }
            }
            await host('download.finish', { downloadId });
        } catch (error) {
            await reader.cancel().catch(() => {});
            await host('download.cancel', { downloadId }).catch(() => {});
            throw error;
        } finally { reader.releaseLock(); }
    }
    async function messageFingerprint(message, index) {
        const text = String(message?.mes || '');
        const bytes = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return { index, length: text.length, sha256: Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join(''),
            swipeId: message?.swipe_id ?? 0, sendDate: message?.send_date ?? null,
            name: message?.name ?? null, isUser: !!message?.is_user, isSystem: !!message?.is_system };
    }
    async function describeContext(body = {}) {
        const ctx = getContext();
        if (!ctx) return { type: 'plugin' };
        const context = {
            version: 2, provider: typeof body.chat_completion_source === 'string' ? body.chat_completion_source : null,
            type: generationType || 'plugin', avatar: ctx.characters[ctx.characterId]?.avatar,
            groupId: ctx.groupId || null, chatId: ctx.chatId, name: ctx.name2,
            chatLength: ctx.chat.length,
        };
        if (context.type === 'continue') context.previousMessage = await messageFingerprint({ ...ctx.chat.at(-1) }, context.chatLength - 1);
        return context;
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
    async function receive(job, signal, cleanup) {
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
                        try {
                            while (true) {
                                const chunk = await reader.read();
                                if (disposed) return;
                                if (chunk.done) break;
                                offset += chunk.value.byteLength;
                                controller.enqueue(chunk.value);
                            }
                        } finally { reader.releaseLock(); activeReader = null; }
                        const info = await (await originalFetch('/api/android/jobs/' + job.id, { signal })).json();
                        if (['complete', 'failed', 'cancelled', 'interrupted'].includes(info.state)) {
                            job.delivered = info.state === 'complete';
                            cleanup();
                            if (!job.delivered || ['plugin', 'quiet'].includes(job.context.type)) active.delete(job.id);
                            if (info.state === 'interrupted' || info.state === 'cancelled' || info.state === 'failed' && info.status < 400) controller.error(new Error('生成已中断，已接收的内容保存在恢复结果中'));
                            else controller.close();
                            return;
                        }
                    } catch (error) {
                        if (disposed) return;
                        if (signal?.aborted) { cleanup(); active.delete(job.id); controller.error(error); return; }
                        if (++failures > 120) { cleanup(); active.delete(job.id); controller.error(new Error('连接中断；返回应用后可从“恢复结果”查看')); return; }
                    }
                    await wait(Math.min(1000 * (failures + 1), 5000));
                    try { response = await originalFetch('/api/android/jobs/' + job.id + '/content?offset=' + offset, { signal }); }
                    catch (error) { if (signal?.aborted) { cleanup(); active.delete(job.id); controller.error(error); return; } failures++; }
                }
            },
            cancel() { disposed = true; cleanup(); active.delete(job.id); activeReader?.cancel().catch(() => {}); /* Model request remains owned by the backend. */ },
        });
        return new Response(stream, { status, headers: { 'Content-Type': contentType || 'application/octet-stream' } });
    }
    const androidFetch = async function(input, options = {}) {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
        if (url.origin !== location.origin) return originalFetch(input, options);
        if (generationPaths.has(url.pathname) && (options.method || input.method || 'GET').toUpperCase() === 'POST') {
            const rawBody = options.body ?? (input instanceof Request ? await input.clone().text() : '{}');
            const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
            const id = crypto.randomUUID();
            const context = await describeContext(body);
            const signal = options.signal || input.signal;
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const started = await originalFetch('/api/android/jobs', { method: 'POST', headers: options.headers || (input instanceof Request ? input.headers : headers()), body: JSON.stringify({ id, endpoint: url.pathname, body, context }) });
            if (!started.ok) return started;
            const job = await started.json();
            active.set(id, job);
            const delivered = [...active.values()].filter(item => item.delivered);
            for (const old of delivered.slice(0, Math.max(0, delivered.length - 16))) active.delete(old.id);
            const abort = () => { cancel(id).catch(console.error); };
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            const cleanup = () => signal?.removeEventListener('abort', abort);
            try { return await receive(job, signal, cleanup); }
            catch (error) { cleanup(); active.delete(id); throw error; }
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
        const partsText = parts => Array.isArray(parts) ? parts.filter(p => !p.thought && (!p.type || p.type === 'text')).map(p => typeof p.text === 'string' ? p.text : '').join('') : '';
        const readText = object => {
            if (object.candidates) return partsText(object.candidates?.[0]?.content?.parts);
            if (job.context?.provider === 'cohere') return object.delta?.message?.content?.text ?? partsText(object.message?.content);
            const value = object.choices?.[0]?.delta?.content ?? object.choices?.[0]?.message?.content ?? object.choices?.[0]?.text ??
                object.delta?.message?.content?.text ?? object.delta?.text ?? object.token ?? object.text ?? object.results?.[0]?.text ?? object.output ?? object.content;
            return typeof value === 'string' ? value : partsText(value);
        };
        try {
            return readText(JSON.parse(raw));
        } catch { /* Streaming response. */ }
        let text = '';
        for (const event of raw.split(/\r?\n\r?\n/)) {
            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            try {
                text += readText(JSON.parse(data));
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
            if (!old?.extra?.android_job_restored) {
                if (job.context.version !== 2 || !job.context.previousMessage) throw new Error('旧结果缺少原文校验，请复制结果后手动处理');
                const message = ctx.chat.at(-1), currentText = message?.mes;
                const fingerprint = await messageFingerprint({ ...message }, length - 1);
                const current = getContext();
                if (!sameChat(job.context, current) || current.chat.length !== length || current.chat.at(-1) !== message ||
                    message.mes !== currentText || (message.swipe_id ?? 0) !== fingerprint.swipeId ||
                    (message.send_date ?? null) !== fingerprint.sendDate || (message.name ?? null) !== fingerprint.name ||
                    !!message.is_user !== fingerprint.isUser || !!message.is_system !== fingerprint.isSystem ||
                    JSON.stringify(fingerprint) !== JSON.stringify(job.context.previousMessage)) {
                    throw new Error('聊天已发生变化，请复制结果后手动处理');
                }
                text = String(currentText || '') + text;
            }
            type = 'appendFinal';
        } else if (old && old === ctx.chat.at(-1)) type = 'appendFinal';
        else if (ctx.chat.length !== length) throw new Error('聊天已发生变化，请复制结果后手动处理');
        const previousLast = ctx.chat.at(-1);
        const initialLength = ctx.chat.length;
        const expectedLength = initialLength + (type === 'normal' && !old?.extra?.android_job_restored ? 1 : 0);
        let replyMessage = type === 'appendFinal' ? previousLast : null;
        const contextGuard = candidate => {
            const current = getContext();
            if (!sameChat(job.context, current) || current.chat !== ctx.chat) {
                throw new Error('聊天已发生变化，请复制结果后手动处理');
            }
            const expectedMessage = candidate || replyMessage;
            if (expectedMessage) {
                if ((replyMessage && expectedMessage !== replyMessage) || current.chat.length !== expectedLength ||
                    current.chat[expectedLength - 1] !== expectedMessage) {
                    throw new Error('聊天已发生变化，请复制结果后手动处理');
                }
                replyMessage = expectedMessage;
            } else if (current.chat.length !== initialLength || current.chat.at(-1) !== previousLast) {
                throw new Error('聊天已发生变化，请复制结果后手动处理');
            }
        };
        if (!old?.extra?.android_job_restored) await ctx.saveReply({ type, getMessage: text, contextGuard });
        contextGuard(ctx.chat.at(-1));
        const message = replyMessage;
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
        } catch (error) {
            message.extra.android_job_complete = false;
            throw error;
        } finally { restoring.delete(job.id); }
    }
    async function showRecovery() {
        recoveryPanel?.dispose();
        const controller = new AbortController();
        const panel = document.createElement('dialog');
        panel.id = 'st-android-recovery';
        panel.style.cssText = 'width:92vw;max-width:650px;max-height:80vh;overflow:auto;background:#242731;color:#eee;border:1px solid #cfb58b;border-radius:12px;padding:18px';
        let disposed = false, detailController = null;
        const dispose = () => {
            if (disposed) return;
            disposed = true; controller.abort(); detailController?.abort();
            panel.replaceChildren(); panel.remove();
            if (recoveryPanel?.element === panel) recoveryPanel = null;
        };
        recoveryPanel = { element: panel, dispose };
        panel.addEventListener('close', dispose, { once: true });
        const title = document.createElement('h3'); title.textContent = '已保存的生成结果'; panel.append(title);
        const close = document.createElement('button'); close.textContent = '关闭'; close.onclick = dispose; panel.append(close);
        const list = document.createElement('div'); panel.append(list);
        const navigation = document.createElement('div'); panel.append(navigation);
        document.body.append(panel); panel.showModal();
        const cursors = [''];
        async function json(url, signal = controller.signal) {
            const response = await originalFetch(url, { signal });
            if (!response.ok) throw new Error('读取结果失败：' + response.status);
            return response.json();
        }
        const action = (container, label, fn) => {
            const button = document.createElement('button'); button.textContent = label;
            button.onclick = async () => {
                button.disabled = true;
                try { await fn(); } catch (error) { if (!disposed && error.name !== 'AbortError') alert(error.message); }
                finally { button.disabled = false; }
            };
            container.append(button); return button;
        };
        async function loadPage() {
            detailController?.abort(); list.replaceChildren(); navigation.replaceChildren();
            const page = await json('/api/android/jobs/page?limit=20&before=' + encodeURIComponent(cursors.at(-1)));
            if (disposed) return;
            if (!page.items.length) list.textContent = '没有待恢复的结果。';
            for (const summary of page.items) {
                const section = document.createElement('section'); section.dataset.jobId = summary.id;
                const label = document.createElement('p');
                label.textContent = (summary.context?.name || '插件生成') + ' · ' + summary.state + ' · ' + new Date(summary.createdAt).toLocaleString();
                section.append(label); list.append(section);
                if (!['complete', 'failed', 'interrupted', 'cancelled'].includes(summary.state)) {
                    action(section, '停止生成', async () => { await cancel(summary.id); await loadPage(); });
                    continue;
                }
                action(section, '查看结果', async () => {
                    detailController?.abort();
                    panel.querySelectorAll('.st-android-result-detail').forEach(element => element.remove());
                    const detail = document.createElement('div'); detail.className = 'st-android-result-detail'; section.append(detail);
                    const selection = new AbortController(); detailController = selection;
                    controller.signal.addEventListener('abort', () => selection.abort(), { once: true, signal: selection.signal });
                    const job = await json('/api/android/jobs/' + summary.id, selection.signal);
                    const preview = await json('/api/android/jobs/' + job.id + '/preview', selection.signal);
                    if (disposed || selection.signal.aborted) return;
                    const text = extractText(preview.raw, job) || preview.raw;
                    const area = document.createElement('textarea'); area.value = text; area.readOnly = true; area.style.cssText = 'width:100%;height:140px'; detail.append(area);
                    if (preview.truncated) {
                        const note = document.createElement('p'); note.textContent = '仅预览前 256 KB。完整内容仍保留，可分块导出。'; detail.append(note);
                    } else {
                        action(detail, '恢复到原聊天', async () => {
                            const reply = extractText(preview.raw, job);
                            if (!reply) throw new Error('这条结果没有可恢复的回复，请复制或导出原始结果');
                            await restore(job, reply); await loadPage();
                        });
                    }
                    action(detail, preview.truncated ? '复制预览' : '复制', () => host('clipboard.write', { text }));
                    action(detail, '导出原始结果', async () => {
                        const response = await originalFetch('/api/android/jobs/' + job.id + '/content', { signal: selection.signal });
                        await exportResponse(response, 'generation-' + job.id + '.txt');
                    });
                    action(detail, '标记已处理', async () => { await acknowledge(job.id); await loadPage(); });
                });
            }
            if (cursors.length > 1) action(navigation, '上一页', async () => { cursors.pop(); await loadPage(); });
            if (page.nextCursor) action(navigation, '下一页', async () => { cursors.push(page.nextCursor); await loadPage(); });
        }
        try { await loadPage(); } catch (error) { if (error.name !== 'AbortError') { dispose(); alert(error.message); } }
    }
    function back() {
        const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
        if (dialog) { dialog.close(); return true; }
        const popup = [...document.querySelectorAll('.popup-button-close, .popup-button-cancel, .drawer-icon.openIcon')].find(e => e.getClientRects().length);
        if (popup) { popup.click(); return true; }
        return false;
    }
    window.fetch = function(input, options = {}) {
        const request = androidFetch(input, options);
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
        const method = (options.method || input.method || 'GET').toUpperCase();
        if (url.origin === location.origin && method === 'POST' && /^\/api\/(characters|settings|chats|worldinfo)\//.test(url.pathname)) {
            const save = request.then(response => { if (!response.ok) throw new Error('保存失败：' + response.status); });
            pendingSaves.add(save);
            save.finally(() => pendingSaves.delete(save)).catch(() => {});
        }
        return request;
    };
    async function flushSaves() {
        const ctx = getContext();
        const flushing = [ctx?.saveSettingsDebounced?.flush?.(), ctx?.saveMetadataDebounced?.flush?.()];
        window.dispatchEvent(new CustomEvent('st-android-flush-saves', { detail: flushing }));
        await Promise.all(flushing);
        while (pendingSaves.size) await Promise.all([...pendingSaves]);
    }
    function prepareLifecycle(action) {
        flushSaves().then(() => host('runtime.' + action, {})).catch(error => {
            host('runtime.save-failed', {}).catch(() => {});
            alert('保存尚未完成，已取消退出或重启。' + error.message);
        });
        return true;
    }
    function prepareUpdateInstall(nonce) {
        (async () => {
            if (!getContext()) throw new Error('页面尚未准备好，请稍后安装更新');
            if (active.size) throw new Error('聊天生成尚未结束，请稍后安装更新');
            await flushSaves();
            if (active.size) throw new Error('聊天生成尚未结束，请稍后安装更新');
            await host('runtime.update-ready', { nonce });
        })().catch(error => {
            host('runtime.save-failed', {}).catch(() => {});
            alert('已取消安装更新：' + error.message);
        });
        return true;
    }
    window.STAndroid = { showRecovery, back, exportBlob, host, flushSaves, prepareLifecycle, prepareUpdateInstall, diagnostics: () => ({ trackedJobs: active.size, pendingHostCalls: hostCalls.size }) };
    document.addEventListener('click', event => {
        const anchor = event.target.closest?.('a[download]');
        if (!anchor || !anchor.href || !window.AndroidHost) return;
        event.preventDefault();
        originalFetch(anchor.href).then(response => exportResponse(response, anchor.download || 'sillytavern-export')).catch(error => alert(error.message));
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
