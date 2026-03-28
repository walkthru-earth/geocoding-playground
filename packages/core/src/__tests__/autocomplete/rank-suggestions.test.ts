import { describe, expect, it } from 'vitest'
import { rankSuggestions } from '../../autocomplete'
import type { SuggestRow } from '../../types'

const makeSuggest = (label: string, primaryCity?: string, tiles: string[] = []): SuggestRow => ({
  type: 'street',
  label,
  tiles,
  addr_count: 100,
  primary_city: primaryCity,
})

describe('rankSuggestions', () => {
  it('returns single item unchanged', () => {
    const items = [makeSuggest('broadway')]
    expect(rankSuggestions(items, 'broad', null, null)).toEqual(items)
  })

  it('boosts items matching city name', () => {
    const items = [makeSuggest('main street', 'Chicago', ['t1']), makeSuggest('main street', 'New York', ['t2'])]
    const result = rankSuggestions(items, 'main', 'New York', null)
    expect(result[0].primary_city).toBe('New York')
  })

  it('boosts items matching city tiles', () => {
    const cityTiles = new Set(['t2'])
    const items = [makeSuggest('main street', 'Chicago', ['t1']), makeSuggest('main street', 'Boston', ['t2'])]
    const result = rankSuggestions(items, 'main', 'SomeCity', cityTiles)
    expect(result[0].primary_city).toBe('Boston')
  })

  it('sorts by score when no city selected', () => {
    const items = [makeSuggest('broadway avenue'), makeSuggest('broadway')]
    const result = rankSuggestions(items, 'broadway', null, null)
    expect(result[0].label).toBe('broadway')
  })

  // ── City-scoped ranking: real-world scenarios from _study/AUTOCOMPLETE.md ──

  describe('city-scoped ranking (Issue #2 regression)', () => {
    it('IT/Roma: "via cave" shows Roma-area streets first despite lower addr_count', () => {
      // Real data: via cave di peperino (Marino, tile 841e805ffffffff) overlaps Roma tiles
      // Roma tiles: 841e801ffffffff, 841e805ffffffff, 841e80dffffffff, 841e863ffffffff
      const items = [
        makeSuggest('via cave', 'Bagnolo Piemonte', ['846a921ffffffff']),
        makeSuggest('via cave di peperino', 'Marino', ['841e805ffffffff']),
        makeSuggest('via delle cave', 'Vecchiano', ['841e805ffffffff', '8439971ffffffff']),
        makeSuggest('via cavento', 'Torino', ['8406127ffffffff']),
      ]
      const romaTiles = new Set(['841e801ffffffff', '841e805ffffffff', '841e80dffffffff', '841e863ffffffff'])
      const result = rankSuggestions(items, 'via cave', 'Roma', romaTiles)

      // Streets with tile overlap to Roma should come first (even if primary_city != Roma)
      const boosted = result.filter((s) => s.tiles.some((t: string) => romaTiles.has(t)))
      const notBoosted = result.filter((s) => !s.tiles.some((t: string) => romaTiles.has(t)))
      expect(result.indexOf(boosted[0])).toBeLessThan(result.indexOf(notBoosted[0]))
    })

    it('NL/Rotterdam: "cour" boosts Rotterdam streets', () => {
      const items = [
        makeSuggest('courtine', 'Amsterdam', ['t1']),
        makeSuggest('courbetstraat', 'Rotterdam', ['t2']),
        makeSuggest('couragestraat', 'Den Haag', ['t3']),
      ]
      const rotterdamTiles = new Set(['t2'])
      const result = rankSuggestions(items, 'cour', 'Rotterdam', rotterdamTiles)
      expect(result[0].primary_city).toBe('Rotterdam')
    })

    it('US/New York: "washington" boosts NY streets above other cities', () => {
      const items = [
        makeSuggest('washington street', 'Chicago', ['t10']),
        makeSuggest('washington avenue', 'New York', ['t1', 't2']),
        makeSuggest('washington boulevard', 'Los Angeles', ['t20']),
      ]
      const nyTiles = new Set(['t1', 't2', 't3'])
      const result = rankSuggestions(items, 'washington', 'New York', nyTiles)
      expect(result[0].primary_city).toBe('New York')
    })

    it('boosts by tile overlap even when primary_city name differs', () => {
      // Real: "via delle cave" has primary_city Vecchiano but tile 841e805ffffffff overlaps Roma
      const items = [
        makeSuggest('via delle cave', 'Vecchiano', ['841e805ffffffff', '8439971ffffffff']),
        makeSuggest('via cave', 'Milano', ['8406cafffffffff']),
      ]
      const romaTiles = new Set(['841e801ffffffff', '841e805ffffffff', '841e80dffffffff'])
      const result = rankSuggestions(items, 'via cave', 'Roma', romaTiles)
      // Vecchiano result has tile overlap with Roma, so it should be boosted
      expect(result[0].primary_city).toBe('Vecchiano')
    })
  })

  describe('common street ambiguity (high-fanout streets)', () => {
    it('US: "main street" returns city-local result first among many', () => {
      // main street exists in 1,730+ US tiles
      const items = [
        makeSuggest('main street', 'Springfield', ['t100']),
        makeSuggest('main street', 'Portland', ['t200']),
        makeSuggest('main street', 'New York', ['t1']),
        makeSuggest('main street', 'Chicago', ['t300']),
      ]
      const nyTiles = new Set(['t1', 't2'])
      const result = rankSuggestions(items, 'main street', 'New York', nyTiles)
      expect(result[0].primary_city).toBe('New York')
    })

    it('NL: "kerkstraat" returns city-local first (exists in 39 tiles)', () => {
      const items = [
        makeSuggest('kerkstraat', 'Utrecht', ['t10']),
        makeSuggest('kerkstraat', 'Amsterdam', ['t1']),
        makeSuggest('kerkstraat', 'Den Haag', ['t20']),
      ]
      const amsterdamTiles = new Set(['t1', 't2'])
      const result = rankSuggestions(items, 'kerkstraat', 'Amsterdam', amsterdamTiles)
      expect(result[0].primary_city).toBe('Amsterdam')
    })

    it('FR: "rue de l\'eglise" returns city-local first (369 tiles)', () => {
      const items = [
        makeSuggest("rue de l'eglise", 'Lyon', ['t10']),
        makeSuggest("rue de l'eglise", 'Paris', ['t1']),
        makeSuggest("rue de l'eglise", 'Marseille', ['t20']),
      ]
      const parisTiles = new Set(['t1', 't2'])
      const result = rankSuggestions(items, "rue de l'eglise", 'Paris', parisTiles)
      expect(result[0].primary_city).toBe('Paris')
    })
  })
})
