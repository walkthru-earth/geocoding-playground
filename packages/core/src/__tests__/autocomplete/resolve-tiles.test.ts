import { describe, expect, it } from 'vitest'
import { resolveTiles } from '../../autocomplete'
import type { CityRow, SuggestRow } from '../../types'

const suggestion: SuggestRow = {
  type: 'street',
  label: 'keizersgracht',
  tiles: ['t1', 't2', 't3'],
  addr_count: 2453,
}

const city: CityRow = {
  city: 'Amsterdam',
  region: null,
  tiles: ['t2', 't4'],
  addr_count: 500000,
}

describe('resolveTiles', () => {
  it('intersects suggestion tiles with city tiles', () => {
    const result = resolveTiles(suggestion, city, new Set(['t2', 't4']))
    expect(result.tiles).toEqual(['t2'])
    expect(result.source).toContain('city')
  })

  it('returns all suggestion tiles when no city', () => {
    const result = resolveTiles(suggestion, null, null)
    expect(result.tiles).toEqual(['t1', 't2', 't3'])
  })

  it('returns city tiles when no suggestion', () => {
    const result = resolveTiles(null, city, new Set(['t2', 't4']))
    expect(result.tiles).toEqual(['t2', 't4'])
    expect(result.source).toContain('Amsterdam')
  })

  it('returns empty when nothing selected', () => {
    const result = resolveTiles(null, null, null)
    expect(result.tiles).toEqual([])
    expect(result.source).toBe('none')
  })

  it('falls back to all suggestion tiles when intersection is empty', () => {
    const noOverlap: SuggestRow = { ...suggestion, tiles: ['t5', 't6'] }
    const result = resolveTiles(noOverlap, city, new Set(['t2', 't4']))
    expect(result.tiles).toEqual(['t5', 't6'])
  })
})
