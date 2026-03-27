import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  build: {
    target: 'es2025',
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    rolldownOptions: {
      external: ['@duckdb/duckdb-wasm'],
    },
    sourcemap: true,
  },
  plugins: [dts({ tsconfigPath: './tsconfig.json' })],
})
