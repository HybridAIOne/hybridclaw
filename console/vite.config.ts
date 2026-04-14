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
        manualChunks(id) {
          if (id.includes('react-dom') || id.includes('/react/')) return 'vendor';
          if (id.includes('@tanstack/react-router')) return 'router';
          if (id.includes('@tanstack/react-query')) return 'query';
          if (id.includes('xterm') || id.includes('@xterm/')) return 'terminal';
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
