import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Fixed loopback endpoints: browser scripts never forward host cookies/tokens
// to LocalDream and do not need cross-origin/private-network browser access.
export async function localDreamRequest(req, res) {
    const generating = req.method === 'POST';
    if (generating && (typeof req.body?.prompt !== 'string' || !req.body.prompt.trim())) {
        return res.status(400).json({ error: 'LocalDream prompt is required' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), generating ? 30 * 60 * 1000 : 2000);
    const closed = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', closed);
    try {
        const upstream = await fetch('http://127.0.0.1:8081/' + (generating ? 'generate' : 'health'), {
            method: generating ? 'POST' : 'GET',
            headers: generating ? { 'Content-Type': 'application/json', Accept: 'text/event-stream' } : {},
            body: generating ? JSON.stringify(req.body) : undefined,
            signal: controller.signal,
        });
        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
        else res.end();
    } catch (error) {
        if (!res.headersSent && !res.destroyed) res.status(503).json({
            error: '无法连接 LocalDream。请打开 LocalDream，选择模型并保持生图页面或设备连接主机模式运行。',
        });
        else if (!res.destroyed) res.destroy(error);
    } finally {
        clearTimeout(timeout);
        res.off('close', closed);
    }
}
