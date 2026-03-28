import { expect, test } from '@playwright/test'

test.describe('Navigation', () => {
  // Dismiss all Driver.js tours so overlays don't block interactions
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('geocode-tour-seen', '1')
      localStorage.setItem('geocode-reverse-hint-seen', '1')
    })
  })

  test('app loads and DuckDB initializes', async ({ page }) => {
    await page.goto('/')
    // Wait for release selector to appear (only renders when dbReady=true)
    const releaseSelect = page.locator('select').filter({ hasText: '2026' })
    await expect(releaseSelect).toBeVisible({ timeout: 60_000 })
  })

  test('page navigation works via pills', async ({ page }) => {
    await page.goto('/')
    const releaseSelect = page.locator('select').filter({ hasText: '2026' })
    await expect(releaseSelect).toBeVisible({ timeout: 60_000 })

    // Use specific IDs to avoid strict mode violations
    await page.locator('#tour-geocode-pill').click()
    expect(page.url()).toContain('#geocode')
    await expect(page.locator('h2:has-text("Forward Geocode")')).toBeVisible()

    await page.locator('button.nav-pill:has-text("Status")').click()
    expect(page.url()).toContain('#status')

    await page.locator('button.nav-pill:has-text("Reverse")').click()
    expect(page.url()).toContain('#reverse')
  })
})
