import fs from 'node:fs';
import path from 'node:path';
import webpack from 'webpack';
import getPublicLibConfig from '../../webpack.config.js';

export default function getWebpackServeMiddleware() {
    /**
     * A very spartan recreation of webpack-dev-middleware.
     * @param {import('express').Request} req Request object.
     * @param {import('express').Response} res Response object.
     * @param {import('express').NextFunction} next Next function.
     * @type {import('express').RequestHandler}
     */
    function devMiddleware(req, res, next) {
        if (process.env.ST_PREBUILT_LIB && req.method === 'GET' && req.path === '/lib.js') {
            return res.sendFile(process.env.ST_PREBUILT_LIB);
        }
        const publicLibConfig = getPublicLibConfig();
        const outputPath = publicLibConfig.output?.path;
        const outputFile = publicLibConfig.output?.filename;
        const parsedPath = path.parse(req.path);

        if (req.method === 'GET' && parsedPath.dir === '/' && parsedPath.base === outputFile) {
            return res.sendFile(outputFile, { root: outputPath });
        }

        next();
    }

    /**
     * Wait until Webpack is done compiling.
     * @param {object} param Parameters.
     * @param {boolean} [param.forceDist=false] Whether to force the use the /dist folder.
     * @param {boolean} [param.pruneCache=false] Whether to prune old cache directories before compiling.
     * @returns {Promise<void>}
     */
    devMiddleware.runWebpackCompiler = ({ forceDist = false, pruneCache = false } = {}) => {
        if (process.env.ST_PREBUILT_LIB) {
            if (!fs.existsSync(process.env.ST_PREBUILT_LIB)) throw new Error('Missing prebuilt frontend library; run prepare:runtime first.');
            return Promise.resolve();
        }
        console.log();
        console.log('Compiling frontend libraries...');

        const publicLibConfig = getPublicLibConfig({ forceDist, pruneCache });
        const compiler = webpack(publicLibConfig);

        return new Promise((resolve, reject) => {
            compiler.run((error, stats) => {
                const output = stats?.toString(publicLibConfig.stats);
                if (output) {
                    console.log(output);
                    console.log();
                }
                const compilationError = error || (stats?.hasErrors() ? new Error(output || 'Frontend compilation failed') : null);
                compiler.close((closeError) => {
                    if (compilationError || closeError) {
                        reject(compilationError || closeError);
                        return;
                    }
                    resolve();
                });
            });
        });
    };

    return devMiddleware;
}
