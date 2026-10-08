// Local, disposable child server: a parser crash must not terminate the test runner.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import http from 'node:http';
const require = createRequire(path.join(process.argv[2], 'package.json'));
const express = require('express');
const multer = require('multer');
const app = express();
app.post('/upload', multer().none(), (req, res) => res.status(201).json({ accepted: req.body.normal === 'ok' }));
app.use((error, req, res, next) => res.status(400).json({ code: error.code }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
    const send = fields => new Promise((resolve, reject) => {
        const parts = fields.map(([name, value]) => `--regression-boundary\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
        const ending = '--regression-boundary--\r\n';
        const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/upload', method: 'POST',
            headers: { 'Content-Type': 'multipart/form-data; boundary=regression-boundary', 'Content-Length': Buffer.byteLength(parts.join('') + ending) },
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks)) }));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('Multipart probe timed out')));
        req.write(parts.shift());
        // Deliver the second field after middleware setup has returned so a
        // parser exception cannot be caught incidentally by Express dispatch.
        setTimeout(() => req.end(parts.join('') + ending), 50);
    });
    // Sparse array at maximum valid array index followed by a push used to throw
    // outside Express's error handler (GHSA-wc9g-mqfw-jrwm).
    const invalid = await send([['field[4294967294]', 'a'], ['field', 'b']]);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_FIELD_NAME');
    const valid = await send([['normal', 'ok']]);
    assert.equal(valid.status, 201);
    assert.equal((await valid.json()).accepted, true);
    console.log('Malformed multipart rejected; same server accepts the next request.');
} finally { server.closeAllConnections(); server.close(); }
