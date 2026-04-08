import { describe, expect, it } from 'vitest'
import { buildReverseQuerySQL, buildTileLookupSQL, radiusToBbox } from '../reverse-geocode'

const bbox = { minLat: 52, maxLat: 53, minLon: 4, maxLon: 5 }

describe('buildReverseQuerySQL', () => {
  it('builds SQL for valid inputs', () => {
    const sql = buildReverseQuerySQL('tbl', 'NL', 52.3, 4.9, bbox, 50)
    expect(sql).toContain("'NL' AS country")
    expect(sql).toContain('LIMIT 50')
  })
  it('rejects invalid country', () => {
    expect(() => buildReverseQuerySQL('tbl', "NL'; DROP--", 52, 4, bbox, 50)).toThrow('Invalid country code')
  })
  it('rejects non-finite lat/lon', () => {
    expect(() => buildReverseQuerySQL('tbl', 'NL', Number.NaN, 4, bbox, 50)).toThrow('Invalid lat')
    expect(() => buildReverseQuerySQL('tbl', 'NL', 52, Number.POSITIVE_INFINITY, bbox, 50)).toThrow('Invalid lon')
  })
  it('rejects invalid bbox', () => {
    const bad = { ...bbox, minLat: Number.NaN }
    expect(() => buildReverseQuerySQL('tbl', 'NL', 52, 4, bad, 50)).toThrow('Invalid bbox.minLat')
  })
  it('rejects invalid limit', () => {
    expect(() => buildReverseQuerySQL('tbl', 'NL', 52, 4, bbox, 0)).toThrow('Invalid limit')
    expect(() => buildReverseQuerySQL('tbl', 'NL', 52, 4, bbox, 1.5)).toThrow('Invalid limit')
    expect(() => buildReverseQuerySQL('tbl', 'NL', 52, 4, bbox, 99999)).toThrow('Invalid limit')
  })
})

describe('buildTileLookupSQL', () => {
  it('builds SQL for gridK=0', () => {
    const sql = buildTileLookupSQL(52.3, 4.9, 0)
    expect(sql).toContain('h3_latlng_to_cell(52.3, 4.9')
  })
  it('builds SQL for gridK>0', () => {
    const sql = buildTileLookupSQL(52.3, 4.9, 2)
    expect(sql).toContain('h3_grid_disk')
  })
  it('rejects non-finite coords', () => {
    expect(() => buildTileLookupSQL(Number.NaN, 4, 0)).toThrow('Invalid lat')
  })
  it('rejects invalid gridK', () => {
    expect(() => buildTileLookupSQL(52, 4, -1)).toThrow('Invalid gridK')
    expect(() => buildTileLookupSQL(52, 4, 1.5)).toThrow('Invalid gridK')
    expect(() => buildTileLookupSQL(52, 4, 999)).toThrow('Invalid gridK')
  })
})

describe('radiusToBbox', () => {
  it('produces a bbox enclosing the point', () => {
    const b = radiusToBbox(52.3, 4.9, 5000)
    expect(b.minLat).toBeLessThan(52.3)
    expect(b.maxLat).toBeGreaterThan(52.3)
    expect(b.minLon).toBeLessThan(4.9)
    expect(b.maxLon).toBeGreaterThan(4.9)
  })
})
