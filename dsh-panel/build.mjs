import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const id = pkg.name;

// Host half: ESM node bundle (a plain Cordis plugin: name/inject/Config/apply).
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/index.js',
  external: ['@cordis/types', '@deepseek-ai/schemastery', 'react', 'react-dom'],
});

// Browser half: CJS wrapped in DSH's __ModuleLoader__.load envelope. The seed
// module table provides react/jsx-runtime etc. via the factory's require().
await esbuild.build({
  entryPoints: ['src/client/plugin.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  outfile: 'dist/client.js',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(
      id,
    )}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: `return module.exports;\n} });` },
});

console.log('[dsh-bridge-panel] build done');
