import { expect, test } from '@playwright/test'

test.describe('Forward Geocode', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('geocode-tour-seen', '2')
    })

    await page.goto('/')
    const releaseSelect = page.locator('select').filter({ hasText: '2026' })
    await expect(releaseSelect).toBeVisible({ timeout: 60_000 })

    // Default page is now geocode (unified)
    await expect(page.locator('h2:has-text("Geocoding Playground")')).toBeVisible()

    // Wait for country select to be populated
    await page.waitForFunction(() => document.querySelectorAll('#tour-country-select option').length > 5, {
      timeout: 60_000,
    })
  })

  test('NL: full geocode flow', async ({ page }) => {
    const countrySelect = page.locator('#tour-country-select')
    await countrySelect.selectOption('NL')

    const cityInput = page.locator('#tour-city-input')
    await expect(cityInput).toBeEnabled({ timeout: 60_000 })

    await cityInput.fill('Amsterdam')
    const cityOption = page.locator('.menu button').filter({ hasText: 'Amsterdam' })
    await cityOption.first().waitFor({ timeout: 30_000 })
    await cityOption.first().click()

    const addressInput = page.locator('#tour-address-input')
    await addressInput.fill('keizersgracht')
    const suggestions = page.locator('.menu button span.font-bold')
    await suggestions.first().waitFor({ timeout: 10_000 })

    const firstLabel = await suggestions.first().textContent()
    expect(firstLabel?.toLowerCase()).toContain('keizersgracht')

    await suggestions.first().click()

    await page.locator('#tour-search-btn').click()

    await page.waitForSelector('table tbody tr', { timeout: 60_000 })
    const rows = page.locator('table tbody tr')
    expect(await rows.count()).toBeGreaterThan(0)

    await expect(page.locator('canvas')).toBeVisible()
  })

  test('US: postcode search', async ({ page }) => {
    const countrySelect = page.locator('#tour-country-select')
    await countrySelect.selectOption('US')

    const addressInput = page.locator('#tour-address-input')
    await expect(addressInput).toBeEnabled({ timeout: 60_000 })

    await addressInput.fill('10001')
    const suggestionBadge = page.locator('.menu button .badge:has-text("postcode")')
    await suggestionBadge.first().waitFor({ timeout: 10_000 })

    expect(await suggestionBadge.count()).toBeGreaterThan(0)
  })
})
