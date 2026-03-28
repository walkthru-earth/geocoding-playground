import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  retries: 1,
  outputDir: '../../test-output/e2e/artifacts',
  reporter: [
    ['html', { outputFolder: '../../test-output/e2e/report' }],
    ['json', { outputFile: '../../test-output/e2e/results.json' }],
  ],
  use: {
    baseURL: 'http://localhost:4173/geocoding-playground/',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm preview',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
})
