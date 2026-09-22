import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      'bridge-ui': new URL('../bridge-ui/src/index.ts', import.meta.url).pathname,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/events': 'http://localhost:3333',
      '/api': 'http://localhost:3333',
    },
  },
});
