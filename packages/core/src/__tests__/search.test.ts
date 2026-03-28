import { describe, expect, it } from 'vitest'
import {
  jaccardSimilarity,
  normalizeForSearch,
  rankBySimilarity,
  searchCities,
  searchPostcodes,
  searchStreets,
} from '../search'
import type { CityRecord, PostcodeRecord, StreetRecord } from '../types'

// ── normalizeForSearch ──────────────────────────────────────

describe('normalizeForSearch', () => {
  describe('German ß↔ss', () => {
    it('normalizes ß to ss', () => {
      expect(normalizeForSearch('hauptstraße')).toBe('hauptstrasse')
    })

    it('normalizes ss to ss (passthrough)', () => {
      expect(normalizeForSearch('hauptstrasse')).toBe('hauptstrasse')
    })

    it('both forms produce the same normalized output', () => {
      expect(normalizeForSearch('hauptstraße')).toBe(normalizeForSearch('hauptstrasse'))
      expect(normalizeForSearch('kleiststraße')).toBe(normalizeForSearch('kleiststrasse'))
    })

    it('handles capital ẞ (rare)', () => {
      expect(normalizeForSearch('HAUPTSTRAẞE')).toBe('hauptstrasse')
    })
  })

  describe('German umlauts', () => {
    it('strips ä → a, ö → o, ü → u', () => {
      expect(normalizeForSearch('München')).toBe('munchen')
      expect(normalizeForSearch('Köln')).toBe('koln')
      expect(normalizeForSearch('Düsseldorf')).toBe('dusseldorf')
    })
  })

  describe('French accents', () => {
    it('strips é, è, ê, ë → e', () => {
      expect(normalizeForSearch('éléphant')).toBe('elephant')
      expect(normalizeForSearch('crème')).toBe('creme')
    })

    it('strips ç → c', () => {
      expect(normalizeForSearch('français')).toBe('francais')
    })

    it('handles œ → oe', () => {
      expect(normalizeForSearch('cœur')).toBe('coeur')
    })
  })

  describe('Nordic characters', () => {
    it('handles ø → o', () => {
      expect(normalizeForSearch('København')).toBe('kobenhavn')
    })

    it('handles æ → ae', () => {
      expect(normalizeForSearch('Lærdal')).toBe('laerdal')
    })

    it('strips å → a', () => {
      expect(normalizeForSearch('Ålborg')).toBe('alborg')
    })
  })

  describe('Polish characters', () => {
    it('handles ł → l', () => {
      expect(normalizeForSearch('Łódź')).toBe('lodz')
    })

    it('strips ź, ż, ć, ś, ń', () => {
      expect(normalizeForSearch('Gdańsk')).toBe('gdansk')
    })
  })

  describe('Croatian/Balkan characters', () => {
    it('handles đ → d', () => {
      expect(normalizeForSearch('Đurđevac')).toBe('durdevac')
    })
  })

  describe('Spanish/Portuguese', () => {
    it('strips ñ → n', () => {
      expect(normalizeForSearch('España')).toBe('espana')
    })

    it('strips ã, õ → a, o', () => {
      expect(normalizeForSearch('São Paulo')).toBe('sao paulo')
    })
  })

  describe('passthrough', () => {
    it('passes ASCII text unchanged', () => {
      expect(normalizeForSearch('broadway')).toBe('broadway')
    })

    it('lowercases', () => {
      expect(normalizeForSearch('BROADWAY')).toBe('broadway')
    })

    it('handles empty string', () => {
      expect(normalizeForSearch('')).toBe('')
    })
  })
})

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
    { street_lower: 'nieuwe keizersgracht', tiles: ['t4'], addr_count: 518 },
    { street_lower: 'dorpsstraat', tiles: ['t5'], addr_count: 30000 },
  ]

  it('finds prefix matches', () => {
    const result = searchStreets(streets, 'keizers')
    expect(result.map((s) => s.street_lower)).toContain('keizersgracht')
  })

  it('falls back to contains when few prefix matches', () => {
    const result = searchStreets(streets, 'keizers')
    expect(result.map((s) => s.street_lower)).toContain('nieuwe keizersgracht')
  })

  it('respects limit', () => {
    const result = searchStreets(streets, 'k', 2)
    expect(result.length).toBeLessThanOrEqual(2)
  })
})

describe('searchPostcodes', () => {
  const postcodes: PostcodeRecord[] = [
    { postcode: '1016AG', tiles: ['t1'], addr_count: 14 },
    { postcode: '1016AH', tiles: ['t1'], addr_count: 31 },
    { postcode: '2722AJ', tiles: ['t2'], addr_count: 30 },
  ]

  it('finds prefix matches (case-insensitive)', () => {
    const result = searchPostcodes(postcodes, '1016')
    expect(result).toHaveLength(2)
    // Sorted by addr_count DESC: AH (31) before AG (14)
    expect(result[0].postcode).toBe('1016AH')
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

// ── Multi-country search scenarios from _study/DATA_PROFILE.md ──

describe('searchStreets: multi-country', () => {
  it('DE: finds hauptstraße variants', () => {
    const deStreets: StreetRecord[] = [
      { street_lower: 'hauptstraße', tiles: ['t1'], addr_count: 287036 },
      { street_lower: 'hauptstraße (frohnhausen)', tiles: ['t2'], addr_count: 164 },
      { street_lower: 'hauptstr.', tiles: ['t3'], addr_count: 6765 },
    ]
    const result = searchStreets(deStreets, 'hauptstraße')
    expect(result[0].street_lower).toBe('hauptstraße')
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it('DE: typing "hauptstrasse" (ss) matches "hauptstraße" (ß) in data', () => {
    const deStreets: StreetRecord[] = [
      { street_lower: 'hauptstraße', tiles: ['t1'], addr_count: 287036 },
      { street_lower: 'kleiststraße', tiles: ['t2'], addr_count: 5673 },
    ]
    // User types ss, data has ß - should still match
    const result = searchStreets(deStreets, 'hauptstrasse')
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0].street_lower).toBe('hauptstraße')
  })

  it('DE: typing "kleiststrasse 116" style query matches "kleiststraße"', () => {
    const deStreets: StreetRecord[] = [{ street_lower: 'kleiststraße', tiles: ['t1'], addr_count: 5673 }]
    const result = searchStreets(deStreets, 'kleiststrasse')
    expect(result.length).toBe(1)
    expect(result[0].street_lower).toBe('kleiststraße')
  })

  it('FR: finds "rue de l\'eglise" (most common FR street, 369 tiles, 59K addr)', () => {
    const frStreets: StreetRecord[] = [
      { street_lower: "rue de l'eglise", tiles: ['t1'], addr_count: 59099 },
      { street_lower: 'rue de la mairie', tiles: ['t2'], addr_count: 48390 },
      { street_lower: 'place de la mairie', tiles: ['t3'], addr_count: 22462 },
    ]
    const result = searchStreets(frStreets, "rue de l'e")
    expect(result.map((s) => s.street_lower)).toContain("rue de l'eglise")
  })

  it('US: finds "main street" among ambiguous streets (332K addr, 1730 tiles)', () => {
    const usStreets: StreetRecord[] = [
      { street_lower: 'main street', tiles: ['t1'], addr_count: 332714 },
      { street_lower: 'main avenue', tiles: ['t2'], addr_count: 5000 },
      { street_lower: 'maine street', tiles: ['t3'], addr_count: 200 },
    ]
    const result = searchStreets(usStreets, 'main')
    expect(result[0].street_lower).toBe('main street')
  })

  it('NL: finds kerkstraat (exists in 39 tiles, 25K addr)', () => {
    const nlStreets: StreetRecord[] = [
      { street_lower: 'kerkstraat', tiles: ['t1'], addr_count: 25054 },
      { street_lower: 'kerkweg', tiles: ['t2'], addr_count: 5924 },
      { street_lower: 'kerkplein', tiles: ['t3'], addr_count: 3000 },
    ]
    const result = searchStreets(nlStreets, 'kerks')
    expect(result[0].street_lower).toBe('kerkstraat')
  })
})

describe('searchPostcodes: multi-country formats', () => {
  it('NL: progressive postcode narrowing "27" -> "272" -> "2722" -> "2722AJ"', () => {
    const nlPostcodes: PostcodeRecord[] = [
      { postcode: '2722AJ', tiles: ['t1'], addr_count: 30 },
      { postcode: '2722BK', tiles: ['t2'], addr_count: 25 },
      { postcode: '2701AB', tiles: ['t3'], addr_count: 40 },
      { postcode: '2800CD', tiles: ['t4'], addr_count: 50 },
    ]
    // "27" matches 3 postcodes
    expect(searchPostcodes(nlPostcodes, '27').length).toBe(3)
    // "272" matches 2 postcodes
    expect(searchPostcodes(nlPostcodes, '272').length).toBe(2)
    // "2722" matches 2 postcodes
    expect(searchPostcodes(nlPostcodes, '2722').length).toBe(2)
    // "2722AJ" matches exactly 1
    expect(searchPostcodes(nlPostcodes, '2722AJ').length).toBe(1)
  })

  it('US: ZIP prefix search narrows progressively', () => {
    const usPostcodes: PostcodeRecord[] = [
      { postcode: '10001', tiles: ['t1'], addr_count: 1723 },
      { postcode: '10002', tiles: ['t2'], addr_count: 2616 },
      { postcode: '10465', tiles: ['t3'], addr_count: 10630 },
      { postcode: '20001', tiles: ['t4'], addr_count: 35861 },
    ]
    expect(searchPostcodes(usPostcodes, '100').length).toBe(2)
    expect(searchPostcodes(usPostcodes, '1046').length).toBe(1)
  })

  it('BR: CEP prefix search', () => {
    const brPostcodes: PostcodeRecord[] = [
      { postcode: '68270-000', tiles: ['t1'], addr_count: 97 },
      { postcode: '68271-001', tiles: ['t2'], addr_count: 50 },
      { postcode: '01305-000', tiles: ['t3'], addr_count: 120 },
    ]
    expect(searchPostcodes(brPostcodes, '6827').length).toBe(2)
    expect(searchPostcodes(brPostcodes, '68270').length).toBe(1)
  })
})

describe('searchCities: edge cases from data profile', () => {
  it('handles case-insensitive search (US mixed case, AU uppercase)', () => {
    const cities: CityRecord[] = [
      { city: 'SYDNEY', tiles: ['t1'], addr_count: 500000 },
      { city: 'Sydney', tiles: ['t2'], addr_count: 1000 },
      { city: 'MELBOURNE', tiles: ['t3'], addr_count: 400000 },
    ]
    const result = searchCities(cities, 'sydney')
    expect(result.length).toBeGreaterThanOrEqual(1)
  })

  it('finds cities with special characters', () => {
    const cities: CityRecord[] = [
      { city: 'São Paulo', tiles: ['t1'], addr_count: 5000000 },
      { city: 'São José', tiles: ['t2'], addr_count: 300000 },
    ]
    const result = searchCities(cities, 'São')
    expect(result.length).toBe(2)
  })

  it('finds "São Paulo" when typing "sao" (no accent)', () => {
    const cities: CityRecord[] = [
      { city: 'São Paulo', tiles: ['t1'], addr_count: 5000000 },
      { city: 'Santos', tiles: ['t2'], addr_count: 200000 },
    ]
    const result = searchCities(cities, 'sao')
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0].city).toBe('São Paulo')
  })

  it('finds "München" when typing "munchen" (no umlaut)', () => {
    const cities: CityRecord[] = [
      { city: 'München', tiles: ['t1'], addr_count: 500000 },
      { city: 'Münster', tiles: ['t2'], addr_count: 200000 },
    ]
    const result = searchCities(cities, 'munchen')
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0].city).toBe('München')
  })

  it('finds "Łódź" when typing "lodz" (no Polish chars)', () => {
    const cities: CityRecord[] = [{ city: 'Łódź', tiles: ['t1'], addr_count: 300000 }]
    const result = searchCities(cities, 'lodz')
    expect(result.length).toBe(1)
    expect(result[0].city).toBe('Łódź')
  })

  it('finds "Gdańsk" when typing "gdansk" (no accent)', () => {
    const cities: CityRecord[] = [{ city: 'Gdańsk', tiles: ['t1'], addr_count: 250000 }]
    const result = searchCities(cities, 'gdansk')
    expect(result.length).toBe(1)
  })

  it('finds merged "Paris" after arrondissement normalization', () => {
    // After DuckDB load-time normalization, arrondissements are merged into a single entry
    const cities: CityRecord[] = [
      { city: 'Paris', tiles: ['841fb47ffffffff'], addr_count: 152331 },
      { city: 'Villeparisis', tiles: ['t2'], addr_count: 6181 },
      { city: 'Cormeilles-en-Parisis', tiles: ['t3'], addr_count: 7051 },
    ]
    const result = searchCities(cities, 'paris')
    expect(result[0].city).toBe('Paris')
    expect(result[0].addr_count).toBe(152331)
  })

  it('finds merged "Lyon" and "Marseille" after normalization', () => {
    const cities: CityRecord[] = [
      { city: 'Lyon', tiles: ['t1'], addr_count: 32920 },
      { city: 'Marseille', tiles: ['t2'], addr_count: 93943 },
      { city: 'Sainte-Foy-lès-Lyon', tiles: ['t3'], addr_count: 3132 },
    ]
    const lyon = searchCities(cities, 'lyon')
    expect(lyon[0].city).toBe('Lyon')
    const marseille = searchCities(cities, 'marseille')
    expect(marseille[0].city).toBe('Marseille')
    expect(marseille[0].addr_count).toBe(93943)
  })
})
