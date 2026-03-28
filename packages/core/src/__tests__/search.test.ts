import { describe, expect, it } from 'vitest'
import { jaccardSimilarity, rankBySimilarity, searchCities, searchPostcodes, searchStreets } from '../search'
import type { CityRecord, PostcodeRecord, StreetRecord } from '../types'

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(jaccardSimilarity('hello', 'hello')).toBe(1)
  })

  it('returns 0 for completely different strings', () => {
    expect(jaccardSimilarity('ab', 'cd')).toBe(0)
  })

  it('returns 0 for single-char strings (no bigrams)', () => {
    expect(jaccardSimilarity('a', 'a')).toBe(0)
  })

  it('is case-insensitive', () => {
    expect(jaccardSimilarity('Hello', 'hello')).toBe(1)
  })

  it('returns a value between 0 and 1 for partial overlap', () => {
    const score = jaccardSimilarity('keizersgracht', 'keizersgra')
    expect(score).toBeGreaterThan(0.5)
    expect(score).toBeLessThan(1)
  })
})

describe('rankBySimilarity', () => {
  it('returns items unchanged if length <= 1', () => {
    expect(rankBySimilarity(['a'], 'q', (x) => x)).toEqual(['a'])
  })

  it('returns items unchanged if query < 2 chars', () => {
    expect(rankBySimilarity(['ab', 'cd'], 'x', (x) => x)).toEqual(['ab', 'cd'])
  })

  it('ranks by Jaccard similarity', () => {
    const items = ['broadway', 'broad street', 'oak street']
    const result = rankBySimilarity(items, 'broadway', (x) => x)
    expect(result[0]).toBe('broadway')
  })
})

describe('searchStreets', () => {
  const streets: StreetRecord[] = [
    { street_lower: 'keizersgracht', tiles: ['t1'], addr_count: 2453 },
    { street_lower: 'kerkstraat', tiles: ['t2'], addr_count: 25054 },
    { street_lower: 'kalverstraat', tiles: ['t3'], addr_count: 500 },
    { street_lower: 'nieuwekeizersgracht', tiles: ['t4'], addr_count: 200 },
    { street_lower: 'dorpsstraat', tiles: ['t5'], addr_count: 30000 },
  ]

  it('finds prefix matches', () => {
    const result = searchStreets(streets, 'keizers')
    expect(result.map((s) => s.street_lower)).toContain('keizersgracht')
  })

  it('falls back to contains when few prefix matches', () => {
    const result = searchStreets(streets, 'keizers')
    expect(result.map((s) => s.street_lower)).toContain('nieuwekeizersgracht')
  })

  it('respects limit', () => {
    const result = searchStreets(streets, 'k', 2)
    expect(result.length).toBeLessThanOrEqual(2)
  })
})

describe('searchPostcodes', () => {
  const postcodes: PostcodeRecord[] = [
    { postcode: '1016AG', tiles: ['t1'], addr_count: 21 },
    { postcode: '1016AH', tiles: ['t1'], addr_count: 15 },
    { postcode: '2722AJ', tiles: ['t2'], addr_count: 30 },
  ]

  it('finds prefix matches (case-insensitive)', () => {
    const result = searchPostcodes(postcodes, '1016')
    expect(result).toHaveLength(2)
    expect(result[0].postcode).toBe('1016AG')
  })

  it('returns empty for no matches', () => {
    expect(searchPostcodes(postcodes, '9999')).toHaveLength(0)
  })
})

describe('searchCities', () => {
  const cities: CityRecord[] = [
    { city: 'Amsterdam', tiles: ['t1'], addr_count: 500000 },
    { city: 'Amstelveen', tiles: ['t2'], addr_count: 50000 },
    { city: 'Rotterdam', tiles: ['t3'], addr_count: 400000 },
    { city: 'New Amsterdam', tiles: ['t4'], addr_count: 1000 },
  ]

  it('finds prefix matches sorted by addr_count', () => {
    const result = searchCities(cities, 'amst')
    expect(result[0].city).toBe('Amsterdam')
    expect(result[1].city).toBe('Amstelveen')
  })

  it('falls back to contains when few prefix matches', () => {
    const result = searchCities(cities, 'amsterdam')
    const names = result.map((c) => c.city)
    expect(names).toContain('Amsterdam')
    expect(names).toContain('New Amsterdam')
  })
})
