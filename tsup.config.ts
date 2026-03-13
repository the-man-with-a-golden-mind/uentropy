import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    minify: false,
    splitting: false,
    treeshake: true,
    target: 'es2020',
  },
  {
    entry: { entropy: 'src/index.ts' },
    format: ['iife'],
    globalName: 'UEntropy',
    outExtension: () => ({ js: '.min.js' }),
    sourcemap: true,
    minify: true,
    splitting: false,
    treeshake: true,
    target: 'es2020',
  },
]);
