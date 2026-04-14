import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/admin/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Raise the limit to 1 MB — the admin console intentionally bundles
    // sizeable vendor libs (xterm, tanstack router/query, React DOM).
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          // Keep React and its ecosystem in one chunk so the browser can
          // cache it independently of application code.
          vendor: ['react', 'react-dom'],
          router: ['@tanstack/react-router'],
          query: ['@tanstack/react-query'],
          terminal: ['xterm', '@xterm/addon-fit'],
        },
      },
    },
  },
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': 'http://127.0.0.1:9090',
      '/health': 'http://127.0.0.1:9090',
    },
  },
});
