import { defineConfig } from 'vite';

export default defineConfig({
  base: '/ops/',
  server: {
    host: '0.0.0.0',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
