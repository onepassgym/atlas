import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  server: {
    port: 4060,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:5070',
        changeOrigin: true,
      },
      '/docs': {
        target: process.env.VITE_API_URL || 'http://localhost:5070',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
