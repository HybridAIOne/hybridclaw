import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/admin/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  plugins: [tailwindcss(), react()],
  server: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': 'http://127.0.0.1:9090',
      '/health': 'http://127.0.0.1:9090',
    },
  },
});
