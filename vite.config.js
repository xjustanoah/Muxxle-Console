import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:4783' },
      '/terminal': { target: 'ws://127.0.0.1:4783', ws: true }
    }
  }
});
