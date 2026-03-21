import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

function versionPlugin(): Plugin {
  return {
    name: 'version-json',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({
          version: `${Date.now()}`,
          buildTime: new Date().toISOString(),
        }),
      })
    },
  }
}

export default defineConfig({
  base: '/model-context-protocol-mcp-with-vercel-functions/',
  server: {
    proxy: {
      '/api/identify': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: (path) => '/v1/messages',
        headers: {
          'anthropic-version': '2023-06-01',
        },
      },
      '/api/scan-deals': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    react(),
    versionPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Staging Inventory Manager',
        short_name: 'StageInv',
        description: 'Manage staging inventory across properties and storage units',
        theme_color: '#1e40af',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        navigateFallbackDenylist: [/version\.json/],
        runtimeCaching: [
          {
            urlPattern: /version\.json/,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/.*supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 },
            },
          },
        ],
      },
    }),
  ],
})
