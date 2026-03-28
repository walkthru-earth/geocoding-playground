import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    outputFile: {
      json: '../../test-output/unit/test-results.json',
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../test-output/unit/coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/duckdb.ts', 'src/index.ts', 'src/__tests__/**'],
    },
  },
})
