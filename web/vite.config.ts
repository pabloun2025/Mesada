import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'DiploP — tareas y mesada en familia',
        short_name: 'DiploP',
        description: 'Tareas de casa, puntos, recompensas y mesada para toda la familia.',
        lang: 'es-ES',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#1A58A3',
        theme_color: '#1A58A3',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
        // La API nunca se cachea: los saldos siempre vienen del servidor.
        runtimeCaching: [{ urlPattern: /\/api\//, handler: 'NetworkOnly' }],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  preview: { port: 4173, proxy: { '/api': 'http://127.0.0.1:3000' } },
});
