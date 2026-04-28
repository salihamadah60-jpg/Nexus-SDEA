import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
    // Prevent dual-React instances that cause "Cannot read properties of null (reading 'useState')"
    // This happens when sandbox node_modules shadow the root React version.
    dedupe: ['react', 'react-dom', 'motion/react'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    hmr: process.env.DISABLE_HMR !== 'true',
    // Phase 13.7: Prevent Nexus's own runtime artifacts from triggering full page
    // reloads that kill in-flight SSE chat connections. Without this, every
    // checkpoint write / sandbox file change forces an HMR reload of the IDE
    // itself — the user sees "NEURAL SYNTHESIS IN PROGRESS..." stuck forever
    // because the EventSource was severed mid-stream.
    watch: {
      ignored: [
        '**/.nexus/**',
        '**/sandbox/**',
        '**/attached_assets/**',
        '**/.local/**',
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
      ],
    },
    proxy: {
      '/api': {
        // Fix 7: server.ts runs on port 5000, not 3000
        target: 'http://localhost:5000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  // Fix 7 (ESM Workers): tree-sitter WASM files and other native modules must be
  // excluded from Vite's pre-bundler to prevent the "workers and ESM" error.
  optimizeDeps: {
    exclude: [
      'web-tree-sitter',
      'tree-sitter-wasms',
      'better-sqlite3',
    ],
  },
  // Fix 7: Ensure workers use ES module format (not the legacy IIFE format that
  // causes "Cannot use import statement inside a worker" errors in Vite 6+).
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      external: [
        'better-sqlite3',
        'web-tree-sitter',
        'puppeteer-core',
        '@sparticuz/chromium-min',
        'e2b',
      ],
    },
  },
});
