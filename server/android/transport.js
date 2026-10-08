import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

// Android only accepts its private filesystem socket. Windows named pipes are
// supported for the desktop integration harness, never on an Android device.
export function androidSocketPath(home, requested, platform = process.platform) {
    if (platform === 'win32' && requested?.startsWith('\\\\.\\pipe\\')) return requested;
    const expected = path.join(path.resolve(home), 'runtime.sock');
    if (requested && path.resolve(requested) !== expected) throw new Error('Android socket must be inside the private application home');
    return expected;
}

export async function listenPrivate(app, socketPath) {
    if (!socketPath) throw new Error('Private socket path is required');
    const pipe = process.platform === 'win32' && socketPath.startsWith('\\\\.\\pipe\\');
    if (!pipe) {
        let previous;
        try { previous = await fs.lstat(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (previous) {
            if (!previous.isSocket()) throw new Error('Refusing to replace a non-socket file');
            await new Promise((resolve, reject) => {
                const probe = net.connect(socketPath);
                probe.once('connect', () => { probe.destroy(); reject(new Error('Private socket is already in use')); });
                probe.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
                probe.setTimeout(1000, () => probe.destroy(new Error('Private socket is busy')));
            });
            await fs.unlink(socketPath);
        }
        if (process.platform === 'win32') throw new Error('Windows integration requires a named pipe');
    }
    const server = http.createServer(app);
    server.requestTimeout = 0; // Generation streaming can legitimately exceed five minutes.
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    try { if (!pipe) await fs.chmod(socketPath, 0o600); }
    catch (error) { server.close(); throw error; }
    return server;
}
