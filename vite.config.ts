import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: '/geocoding-playground/',
  plugins: [tailwindcss(), svelte()],
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  build: {
    rolldownOptions: {
      external: ['maplibre-gl'],
      output: {
        globals: { 'maplibre-gl': 'maplibregl' },
      },
    },
  },
})
