import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  server: {
    port: 4060,
    proxy: {
      '/api': {
        // VITE_API_URL can be set in .env.local for Docker-in-Docker scenarios.
        // Defaults to localhost:5070 for local development.
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
