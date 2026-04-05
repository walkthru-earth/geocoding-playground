import { expect, test } from '@playwright/test'

test.describe('Reverse Geocode', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('geocode-tour-seen', '2')
    })
  })

  test('location preset triggers reverse search', async ({ page }) => {
    await page.goto('/#geocode')
    // Wait for DuckDB to fully initialize (release select proves tile_index is loaded)
    const releaseSelect = page.locator('select').filter({ hasText: '2026' })
    await expect(releaseSelect).toBeVisible({ timeout: 60_000 })

    // Wait for map canvas to be ready (preset clicks need mapView to add markers)
    await expect(page.locator('canvas')).toBeVisible({ timeout: 30_000 })

    // Click a location preset (Colosseum)
    await page.locator('button:has-text("Colosseum")').click()

    // Wait for results
    await page.waitForSelector('table tbody tr', { timeout: 60_000 })
    const rows = page.locator('table tbody tr')
    expect(await rows.count()).toBeGreaterThan(0)

    // Verify map canvas exists
    await expect(page.locator('canvas')).toBeVisible()

    // Verify country was auto-filled from reverse results
    const countrySelect = page.locator('#tour-country-select')
    await expect(countrySelect).toHaveValue('IT', { timeout: 10_000 })
  })
})
