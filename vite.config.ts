import { defineConfig } from 'vite';

// Relative base: the production build (dist/) works from any sub-path or static host.
// Override with VITE_BASE=/some/path/ if absolute URLs are required.
export default defineConfig({
  base: process.env.VITE_BASE ?? './',
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
