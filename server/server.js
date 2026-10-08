#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { CommandLineParser } from './src/command-line.js';
import { serverDirectory } from './src/server-directory.js';

console.log(`Node version: ${process.version}. Running in ${process.env.NODE_ENV} environment. Server directory: ${serverDirectory}`);

// config.yaml will be set when parsing command line arguments
const cliArgs = new CommandLineParser().parse(process.argv);
globalThis.DATA_ROOT = cliArgs.dataRoot;
globalThis.COMMAND_LINE_ARGS = cliArgs;
process.chdir(serverDirectory);

try {
    await import('./src/server-main.js');
} catch (error) {
    console.error('A critical error has occurred while starting the server:', error);
    if (process.env.ST_ANDROID === '1') {
        fs.writeFileSync(path.join(process.env.ST_ANDROID_HOME, 'startup-error.txt'), String(error.stack || error));
        process.exitCode = 1;
        throw error;
    }
}
