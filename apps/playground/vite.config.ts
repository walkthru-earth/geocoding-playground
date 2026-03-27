import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/geocoding-playground/',
  plugins: [tailwindcss(), svelte()],
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  build: {
    target: 'es2025',
    chunkSizeWarningLimit: 800,
    // maplibre-gl is externalized due to a Vite 8.0.1+ Rolldown minification bug
    // that breaks maplibre in production builds (maplibre/maplibre-gl-js#7339).
    // Loaded via importmap in index.html instead.
    rolldownOptions: {
      external: ['maplibre-gl'],
    },
  },
})
