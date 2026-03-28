import { expect, test } from '@playwright/test'

test.describe('Forward Geocode', () => {
  test.beforeEach(async ({ page }) => {
    // Dismiss all Driver.js tours so overlays don't block interactions
    await page.addInitScript(() => {
      localStorage.setItem('geocode-tour-seen', '1')
      localStorage.setItem('geocode-reverse-hint-seen', '1')
    })

    // Load app at root, wait for DuckDB, then click Geocode pill
    // This ensures DuckDB is ready BEFORE GeocodePage mounts and runs loadCountries()
    await page.goto('/')
    const releaseSelect = page.locator('select').filter({ hasText: '2026' })
    await expect(releaseSelect).toBeVisible({ timeout: 60_000 })

    // Navigate to Geocode via pill click (not hash navigation)
    await page.locator('#tour-geocode-pill').click()
    await expect(page.locator('h2:has-text("Forward Geocode")')).toBeVisible()

    // Wait for country select to be populated (S3 manifest fetch can be slow in CI)
    await page.waitForFunction(() => document.querySelectorAll('#tour-country-select option').length > 5, {
      timeout: 60_000,
    })
  })

  test('NL: full geocode flow', async ({ page }) => {
    const countrySelect = page.locator('#tour-country-select')
    await countrySelect.selectOption('NL')

    // Wait for country prefetch (city input becomes enabled, fetches indexes from S3)
    const cityInput = page.locator('#tour-city-input')
    await expect(cityInput).toBeEnabled({ timeout: 60_000 })

    // Type city name and select from dropdown
    await cityInput.fill('Amsterdam')
    const cityOption = page.locator('.menu button').filter({ hasText: 'Amsterdam' })
    await cityOption.first().waitFor({ timeout: 10_000 })
    await cityOption.first().click()

    // Type address and wait for autocomplete suggestions
    const addressInput = page.locator('#tour-address-input')
    await addressInput.fill('keizersgracht')
    const suggestions = page.locator('.menu button span.font-bold')
    await suggestions.first().waitFor({ timeout: 10_000 })

    // Verify at least one suggestion contains "keizersgracht"
    const firstLabel = await suggestions.first().textContent()
    expect(firstLabel?.toLowerCase()).toContain('keizersgracht')

    // Click first suggestion
    await suggestions.first().click()

    // Click search
    await page.locator('#tour-search-btn').click()

    // Wait for results
    await page.waitForSelector('table tbody tr', { timeout: 60_000 })
    const rows = page.locator('table tbody tr')
    expect(await rows.count()).toBeGreaterThan(0)

    // Verify map canvas exists
    await expect(page.locator('canvas')).toBeVisible()
  })

  test('US: postcode search', async ({ page }) => {
    const countrySelect = page.locator('#tour-country-select')
    await countrySelect.selectOption('US')

    // Wait for prefetch (address input becomes enabled)
    const addressInput = page.locator('#tour-address-input')
    await expect(addressInput).toBeEnabled({ timeout: 60_000 })

    // Type a ZIP code
    await addressInput.fill('10001')
    const suggestionBadge = page.locator('.menu button .badge:has-text("postcode")')
    await suggestionBadge.first().waitFor({ timeout: 10_000 })

    expect(await suggestionBadge.count()).toBeGreaterThan(0)
  })
})
