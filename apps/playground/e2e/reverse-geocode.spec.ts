import { expect, test } from '@playwright/test'

test.describe('Reverse Geocode', () => {
  // Dismiss all Driver.js tours so overlays don't block interactions
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('geocode-tour-seen', '1')
      localStorage.setItem('geocode-reverse-hint-seen', '1')
    })
  })

  test('search by coordinates returns results', async ({ page }) => {
    await page.goto('/#reverse')
    // Wait for DuckDB to initialize
    await page.waitForSelector('text=DuckDB', { timeout: 60_000 })

    // Fill lat/lon inputs (use label-based selectors from the snapshot)
    await page.getByLabel('Latitude').fill('52.3676')
    await page.getByLabel('Longitude').fill('4.9041')

    // Click search button
    await page.locator('button:has-text("Find Addresses")').click()

    // Wait for results
    await page.waitForSelector('table tbody tr', { timeout: 60_000 })
    const rows = page.locator('table tbody tr')
    expect(await rows.count()).toBeGreaterThan(0)

    // Verify map canvas exists
    await expect(page.locator('canvas')).toBeVisible()
  })
})
