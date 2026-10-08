import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
const root = path.resolve(import.meta.dirname, '..');
const home = path.join(root, '.local', 'desktop-data');
const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\st-android-' + crypto.createHash('sha256').update(home).digest('hex').slice(0, 20) : path.join(home, 'runtime.sock');
// This is a desktop test harness. Bind before creating a session, matching the
// Android gateway's fail-closed startup while exercising the real IPC backend.
const gateway = net.createServer(client => {
    const upstream = net.createConnection(socketPath);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close); upstream.on('error', close);
    client.pipe(upstream).pipe(client);
});
gateway.maxConnections = 24;
gateway.listen(Number(process.env.ST_TEST_PORT || 17614), '127.0.0.1');
await once(gateway, 'listening');
fs.mkdirSync(home, { recursive: true });
const token = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(path.join(home, 'session-token'), token, { mode: 0o600 });
const child = spawn(process.env.ST_TEST_NODE || process.execPath, [path.join(root, 'server/run-android.js'), home, token, socketPath], { stdio: 'inherit', cwd: path.join(root, 'server') });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { gateway.close(); child.kill(signal); });
child.on('exit', code => { gateway.close(); process.exit(code ?? 1); });
