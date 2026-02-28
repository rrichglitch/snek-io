import { defineConfig } from 'vite';

export default defineConfig({
  base: '/snek-io/',
  server: {
    port: 3000,
    host: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
