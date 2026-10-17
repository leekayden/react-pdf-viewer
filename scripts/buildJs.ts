type PackageJson = {
    dependencies: Record<string, string>;
    name: string;
    peerDependencies: Record<string, string>;
};

import json from '@rollup/plugin-json';
import terser from '@rollup/plugin-terser';
import { createGenerateScopedName } from 'hash-css-selector';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
    rollup,
    type OutputOptions,
    type RollupBundleOutput,
    type RollupOptions,
    type WarningHandlerWithDefault,
} from 'rollup';
import esbuild from 'rollup-plugin-esbuild';
import postcss from 'rollup-plugin-postcss';

const generateTypes = (rootPackagePath: string) =>
    new Promise<void>((resolve, reject) => {
        exec(`tsc --project ${path.join(rootPackagePath, 'tsconfig.build.json')}`, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(String(stdout || stderr || error)));
            } else {
                resolve();
            }
        });
    });

// Packages that aggregate the styles of their dependencies ship a
// `src/styles/index.css` full of relative `@import`s pointing at the built
// CSS of sibling packages (default-layout -> toolbar -> search, ...).
// Inline that chain so consumers get one self-contained stylesheet instead
// of depending on their bundler to resolve cross-package @imports.
const inlineCssImports = (cssPath: string, seen: Set<string>): string => {
    const resolved = fs.realpathSync(cssPath);
    if (seen.has(resolved)) {
        return '';
    }
    seen.add(resolved);
    return fs
        .readFileSync(cssPath, { encoding: 'utf8' })
        .replace(/@import\s+['"]([^'"]+)['"]\s*;/g, (_match, target: string) => {
            const importPath = path.resolve(path.dirname(cssPath), target);
            if (!fs.existsSync(importPath)) {
                console.warn(`[buildJs] Unresolved @import ${target} in ${cssPath}`);
                return '';
            }
            return inlineCssImports(importPath, seen);
        });
};

const buildPackage = async (rootPackagePath: string) => {
    const input = path.join(rootPackagePath, 'src/index.ts');
    const packageContent = fs.readFileSync(path.join(rootPackagePath, 'package.json'), { encoding: 'utf8' });
    const packageJson = JSON.parse(packageContent) as unknown as PackageJson;

    const outputDir = path.join(rootPackagePath, 'lib');
    const packageName = packageJson.name.split('/').pop();

    const external = [
        ...Object.keys(packageJson.dependencies || {}),
        ...Object.keys(packageJson.peerDependencies || {}),
    ];
    const handleOnWarn: WarningHandlerWithDefault = (warning, warn) => {
        // Ignore the warning shown when the `use client` directive is used at the top of files
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') {
            return;
        }
        warn(warning);
    };

    // CSS modules are extracted by rollup-plugin-postcss as bundle assets.
    // Grabbing them here — instead of copying files from disk afterwards —
    // keeps the styles independent of rollup's write timing.
    const capturedCss: Record<string, string> = {};
    const captureCss = {
        name: 'capture-css',
        generateBundle(_options: unknown, bundle: RollupBundleOutput) {
            for (const [fileName, entry] of Object.entries(bundle)) {
                if (entry.type === 'asset' && fileName.endsWith('.css')) {
                    capturedCss[fileName] = String(entry.source);
                }
            }
        },
    };

    const rollupOptions: RollupOptions[] = [
        {
            input,
            output: {
                exports: 'named',
                dir: path.join(outputDir, 'cjs'),
                entryFileNames: `${packageName}.js`,
                chunkFileNames: `${packageName}-[name].js`,
                assetFileNames: `${packageName}.[ext]`,
                format: 'cjs',
            },
            external,
            plugins: [
                json(),
                esbuild({
                    sourceMap: false,
                    tsconfig: path.join(rootPackagePath, 'tsconfig.json'),
                }),
                postcss({
                    extract: `${packageName}.css`,
                    modules: {
                        // By default, all CSS classes are prefixed with `m-`
                        generateScopedName: createGenerateScopedName('rpv'),
                    },
                }),
                captureCss,
            ],
            onwarn: handleOnWarn,
        },
        {
            input,
            output: {
                exports: 'named',
                dir: path.join(outputDir, 'cjs'),
                entryFileNames: `${packageName}.min.js`,
                chunkFileNames: `${packageName}-[name].min.js`,
                assetFileNames: `${packageName}.min.[ext]`,
                format: 'cjs',
            },
            external,
            plugins: [
                json(),
                esbuild({
                    sourceMap: false,
                    tsconfig: path.join(rootPackagePath, 'tsconfig.json'),
                }),
                postcss({
                    extract: `${packageName}.min.css`,
                    minimize: true,
                    modules: {
                        // By default, all CSS classes are prefixed with `m-`
                        generateScopedName: createGenerateScopedName('rpv'),
                    },
                }),
                captureCss,
                terser(),
            ],
            onwarn: handleOnWarn,
        },
    ];

    // Generate Typescript definitions
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir);
    // `lib/index.js` is a CJS entry shim picking the dev or minified bundle,
    // matching the layout of the published packages. The CSS is decoupled and
    // has to be imported explicitly from `lib/styles/index.css`.
    fs.writeFileSync(
        path.join(outputDir, 'index.js'),
        [
            `'use strict';`,
            ``,
            `if (process.env.NODE_ENV === 'production') {`,
            `    module.exports = require('./cjs/${packageName}.min.js');`,
            `} else {`,
            `    module.exports = require('./cjs/${packageName}.js');`,
            `}`,
            ``,
        ].join('\n'),
    );

    await generateTypes(rootPackagePath);

    // Compile sequentially — both outputs share `lib/cjs`.
    for (const rollupOption of rollupOptions) {
        const build = await rollup(rollupOption);
        await build.write(rollupOption.output as OutputOptions);
    }

    // Write the extracted CSS to `lib/styles`. The dev CSS is also published
    // as `index.css` (and the minified one as `index.min.css`), mirroring the
    // published packages. Some packages have no styles at all.
    const stylesDir = path.join(outputDir, 'styles');
    fs.mkdirSync(stylesDir, { recursive: true });
    const aggregateSource = path.join(rootPackagePath, 'src/styles/index.css');
    const aggregate = fs.existsSync(aggregateSource)
        ? inlineCssImports(aggregateSource, new Set())
        : '';
    const cssVariants: Array<[string, string[]]> = [
        [`${packageName}.css`, [`${packageName}.css`, 'index.css']],
        [`${packageName}.min.css`, [`${packageName}.min.css`, 'index.min.css']],
    ];
    let writtenStyles = 0;
    for (const [extractedName, styleNames] of cssVariants) {
        const css = capturedCss[extractedName];
        if (!css && !aggregate) {
            console.warn(`[buildJs] No extracted CSS asset named ${extractedName} for ${packageJson.name}`);
            continue;
        }
        for (const styleName of styleNames) {
            fs.writeFileSync(path.join(stylesDir, styleName), (css || '') + aggregate);
            writtenStyles += 1;
        }
    }
    if (writtenStyles === 0) {
        fs.rmdirSync(stylesDir);
    }
};

(async () => {
    const rootPackagePath = process.cwd();
    try {
        await buildPackage(rootPackagePath);
        console.log(`Built ${rootPackagePath}`);
    } catch (error) {
        console.error(`[buildJs] Failed for ${rootPackagePath}:`, error);
        process.exit(1);
    }
})();
