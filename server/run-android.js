import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { checkRuntime } from './android/runtime-checks.js';
import { loadAndroidConfig } from './android/config.js';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { androidSocketPath } from './android/transport.js';

// Mobile networks can advertise IPv6 routes that do not reach the remote host.
net.setDefaultAutoSelectFamily(true);
const root = path.dirname(fileURLToPath(import.meta.url));
const home = path.resolve(process.argv[2] || path.join(root, 'data-android'));
const token = process.argv[3];
if (!/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Android host session token is missing.');
process.env.ST_ANDROID = '1';
process.env.ST_ANDROID_HOME = home;
process.env.ST_ANDROID_TOKEN = token;
process.env.ST_ANDROID_PORT = '17614';
process.env.ST_ANDROID_SOCKET = androidSocketPath(home, process.argv[4]);
process.env.ST_PREBUILT_LIB = path.join(root, 'android-lib.js');
fs.mkdirSync(home, { recursive: true });
const configPath = path.join(home, 'config.yaml');
const config = loadAndroidConfig(path.join(root, 'default/config.yaml'), configPath);
Object.assign(config, {
    dataRoot: path.join(home, 'data'),
    listen: false,
    port: 17614,
    // The private directory, same-UID native connection and session token guard
    // this listener; a Unix socket has no remote IP for the TCP whitelist.
    whitelistMode: false,
    whitelist: ['127.0.0.1', '::1'],
    enableServerPlugins: false,
    enableServerPluginsAutoUpdate: false,
    skipContentCheck: false,
});
config.browserLaunch = { ...(config.browserLaunch || {}), enabled: false };
config.protocol = { ipv4: true, ipv6: false };
config.extensions = { ...config.extensions, autoUpdate: false };
writeFileAtomicSync(configPath, yaml.stringify(config));
process.argv = [process.argv[0], path.join(root, 'server.js'), '--configPath', configPath, '--dataRoot', config.dataRoot, '--port', '17614', '--listen', 'false', '--browserLaunchEnabled', 'false'];
await checkRuntime(home);
process.chdir(root);
await import('./server.js');
