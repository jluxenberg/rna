import { promises } from 'fs';
import path from 'path';
import swc from '@swc/core';
import nodeResolve from 'resolve';

const { readFile } = promises;
const SCRIPT_LOADERS = ['tsx', 'ts', 'jsx', 'js'];

/**
 * @param {string} spec
 * @param {string} importer
 */
function resolve(spec, importer) {
    return new Promise((resolve, reject) => nodeResolve(spec, {
        basedir: path.dirname(importer.replace('file://', '')),
        preserveSymlinks: true,
    }, (err, data) => (err ? reject(err) : resolve(data))));
}

/**
 * @param {import('esbuild').OnLoadArgs & { contents?: string }} args
 * @param {string} target
 * @param {import('@swc/core').Plugin[]} plugins
 * @param {{ code?: string, ast?: import('@swc/core').Program }} cache
 * @param {boolean} pipe
 * @return {Promise<import('esbuild').OnLoadResult|undefined>}
 */
async function run({ path: filePath }, target, plugins, cache, pipe) {
    let contents = cache.code || await readFile(filePath, 'utf-8');

    if (!plugins.length) {
        if (pipe) {
            cache.code = contents;
            return;
        }
        return {
            contents,
            loader: 'tsx',
        };
    }

    if (target === 'es5') {
        let { code } = await swc.transform(contents, {
            sourceFileName: filePath,
            jsc: {
                parser: {
                    syntax: 'typescript',
                    tsx: true,
                    decorators: true,
                    dynamicImport: true,
                },
                externalHelpers: true,
            },
            env: {
                targets: {
                    ie: '11',
                },
                shippedProposals: true,
            },
        });

        contents = code;

        if (pipe) {
            cache.code = contents;
            return;
        }
        return {
            contents,
            loader: 'tsx',
        };
    }

    /** @type {import('@swc/core').Program} */
    let program = await swc.parse(contents, {
        syntax: 'typescript',
        tsx: true,
        decorators: true,
        dynamicImport: true,
    });

    program = swc.plugins(plugins)(program);

    let { code } = await swc.print(program, {
        // @TODO swc sourcemaps are incorrect for esbuild. Must investigate.
        // sourceMaps: 'inline',
    });

    // swc renders decorators after the export statement, we revert it
    // @TODO handle sourcemaps
    contents = code.replace(/(export(?:\s+default)?\s+)(@(?:\s|.)*?)\s*class/g, '$2\n$1class');

    if (pipe) {
        cache.code = contents;
        cache.ast = program;
        return;
    }
    return {
        contents,
        loader: 'tsx',
    };
}

/**
 * @param {{ target?: string, plugins?: import('@swc/core').Plugin[], pipe?: boolean, cache?: Map<string, *> }} plugins
 * @return An esbuild plugin.
 */
export default function({ target = 'esnext', plugins = [], pipe = false, cache = new Map() } = {}) {
    /**
     * @type {import('esbuild').Plugin}
     */
    const plugin = {
        name: 'swc',
        setup(build) {
            let options = build.initialOptions;
            let { loader = {} } = options;
            let keys = Object.keys(loader);
            let tsxExtensions = keys.filter((key) => SCRIPT_LOADERS.includes(loader[key]));
            let tsxRegex = new RegExp(`\\.(${tsxExtensions.map((ext) => ext.replace('.', '')).join('|')})$`);

            build.onResolve({ filter: /@swc\/helpers/ }, async () => ({
                path: await resolve('@swc/helpers', import.meta.url),
            }));
            build.onLoad({ filter: tsxRegex, namespace: 'file' }, (args) => {
                cache.set(args.path, cache.get(args.path) || {});
                return run(args, target, plugins, cache.get(args.path), pipe);
            });
        },
    };

    return plugin;
}
