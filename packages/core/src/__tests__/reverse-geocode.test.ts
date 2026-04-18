import { describe, expect, it } from 'vitest'
import { buildReverseQuerySQL, buildTileLookupSQL, radiusToBbox } from '../reverse-geocode'

const bbox = { minLat: 52, maxLat: 53, minLon: 4, maxLon: 5 }

describe('buildReverseQuerySQL', () => {
  it('builds SQL for a cached tile identifier', () => {
    const sql = buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', 52.3, 4.9, bbox, 50)
    expect(sql).toContain("'NL' AS country")
    expect(sql).toContain('LIMIT 50')
  })
  it('builds SQL for a read_parquet source', () => {
    const src = "read_parquet('https://example.com/tile.parquet')"
    expect(() => buildReverseQuerySQL(src, 'NL', 52, 4, bbox, 50)).not.toThrow()
  })
  it('rejects raw table names not in the whitelist', () => {
    expect(() => buildReverseQuerySQL('tbl', 'NL', 52, 4, bbox, 50)).toThrow('Invalid src')
  })
  it('rejects src with injected SQL', () => {
    expect(() => buildReverseQuerySQL('tbl; DROP TABLE x', 'NL', 52, 4, bbox, 50)).toThrow('Invalid src')
  })
  it('rejects invalid country', () => {
    expect(() => buildReverseQuerySQL('"_tile_NL_841f8b_01"', "NL'; DROP--", 52, 4, bbox, 50)).toThrow(
      'Invalid country code',
    )
  })
  it('rejects non-finite lat/lon', () => {
    expect(() => buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', Number.NaN, 4, bbox, 50)).toThrow('Invalid lat')
    expect(() => buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', 52, Number.POSITIVE_INFINITY, bbox, 50)).toThrow(
      'Invalid lon',
    )
  })
  it('rejects invalid bbox', () => {
    const bad = { ...bbox, minLat: Number.NaN }
    expect(() => buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', 52, 4, bad, 50)).toThrow('Invalid bbox.minLat')
  })
  it('rejects invalid limit', () => {
    expect(() => buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', 52, 4, bbox, 0)).toThrow('Invalid limit')
    expect(() => buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', 52, 4, bbox, 1.5)).toThrow('Invalid limit')
    expect(() => buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', 52, 4, bbox, 99999)).toThrow('Invalid limit')
  })
  it('adds a distance cap when maxDistM is provided', () => {
    const sql = buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', 52, 4, bbox, 25, 250)
    expect(sql).toContain('distance_m <= 250')
  })
  it('omits the distance cap when maxDistM is undefined', () => {
    const sql = buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', 52, 4, bbox, 25)
    expect(sql).not.toContain('distance_m <=')
  })
  it('selects unit column so apartment buildings show per-unit rows', () => {
    const sql = buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', 52.3, 4.9, bbox, 5)
    expect(sql).toMatch(/full_address,\s*street,\s*number,\s*unit/)
  })
  it('rejects non-finite or non-positive maxDistM', () => {
    expect(() => buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', 52, 4, bbox, 25, 0)).toThrow('Invalid maxDistM')
    expect(() => buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', 52, 4, bbox, 25, Number.NaN)).toThrow(
      'Invalid maxDistM',
    )
    expect(() => buildReverseQuerySQL('"_tile_NL_841f8b_01"', 'NL', 52, 4, bbox, 25, -10)).toThrow('Invalid maxDistM')
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
  it('respects the caller radius and does not force a 1km floor', () => {
    const b = radiusToBbox(52.3, 4.9, 250)
    // 250m at 111 km/deg = ~0.00225 deg of lat. No 1km floor means the box is tight.
    expect(b.maxLat - b.minLat).toBeLessThan(0.006)
  })
})
