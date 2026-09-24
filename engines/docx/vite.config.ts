import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  resolve: {
    alias: [
      {
        find: /^superdoc\/style\.css$/,
        replacement: fileURLToPath(new URL('../../vendor/superdoc/packages/superdoc/dist/style.css', import.meta.url)),
      },
      {
        find: /^superdoc$/,
        replacement: fileURLToPath(new URL('../../vendor/superdoc/packages/superdoc/dist/superdoc.es.js', import.meta.url)),
      },
    ],
  },
});
