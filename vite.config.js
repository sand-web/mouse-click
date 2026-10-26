import { defineConfig } from 'vite';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  base: process.env.ELECTRON === 'true' ? './' : '.',
  build: {
    rollupOptions: {
      input: {
        highlight: resolve(__dirname, 'index.html'),
        settings: resolve(__dirname, 'settings.html'),
      },
    },
  },
});
