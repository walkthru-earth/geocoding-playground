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
})
