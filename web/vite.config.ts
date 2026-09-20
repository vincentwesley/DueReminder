import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const shared = fileURLToPath(new URL('../shared', import.meta.url));
const api = process.env.API_URL ?? 'http://localhost:4000';

export default defineConfig({
  root: here,
  resolve: { alias: { '@shared': shared } },
  server: {
    port: 5173,
    proxy: { '/api': { target: api, changeOrigin: false } },
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: { manualChunks: { react: ['react', 'react-dom'] } },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Reminders',
        short_name: 'Reminders',
        description: 'Reminders with natural-language quick add and Google Calendar sync.',
        theme_color: '#4f46e5',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
});
