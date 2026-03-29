import { describe, expect, it, vi } from 'vitest'

vi.mock('../../duckdb', () => ({
  tilePath: (cc: string, region: string, tile: string) =>
    `https://example.com/geocoder/country=${cc}/region=${encodeURIComponent(region)}/h3_parent=${tile}/data_0.parquet`,
  indexPath: (type: string, cc: string, region: string) =>
    `https://example.com/${type}/country=${cc}/region=${encodeURIComponent(region)}/data_0.parquet`,
  getRegionTable: (prefix: string, cc: string, region: string) => `"${prefix}_${cc}_${region.replace(/"/g, '""')}"`,
}))

import {
  buildAddressSQL,
  buildNumberIndexSQL,
  buildPostcodeNarrowSQL,
  buildPostcodeSQL,
  buildStreetNarrowSQL,
  buildStreetSQL,
} from '../../autocomplete'

describe('buildPostcodeSQL', () => {
  it('generates correct SQL with city boost', () => {
    const sql = buildPostcodeSQL('NL', 'Noord-Holland', '1016', ['t1', 't2'])
    expect(sql).toContain('"_postcodes_NL_Noord-Holland"')
    expect(sql).toContain("LIKE '1016%'")
    expect(sql).toContain('list_has_any')
    expect(sql).toContain('LIMIT 15')
  })

  it('generates SQL without boost when no city tiles', () => {
    const sql = buildPostcodeSQL('NL', 'Noord-Holland', '1016', [])
    expect(sql).not.toContain('list_has_any')
  })

  it('escapes single quotes', () => {
    const sql = buildPostcodeSQL('NL', 'Noord-Holland', "test'inject", [])
    expect(sql).toContain("test''inject")
  })
})

describe('buildStreetSQL', () => {
  it('generates correct SQL with city boost', () => {
    const sql = buildStreetSQL('NL', 'Noord-Holland', 'keizers', ['t1'])
    expect(sql).toContain('"_streets_NL_Noord-Holland"')
    expect(sql).toContain("LIKE 'keizers%'")
    expect(sql).toContain('list_has_any')
    expect(sql).toContain('primary_city')
  })
})

describe('buildPostcodeNarrowSQL', () => {
  it('uses exact match', () => {
    const sql = buildPostcodeNarrowSQL('US', 'California', '10001')
    expect(sql).toContain("= '10001'")
    expect(sql).toContain('LIMIT 1')
  })
})

describe('buildStreetNarrowSQL', () => {
  it('uses exact match when exact=true', () => {
    const sql = buildStreetNarrowSQL('NL', 'Noord-Holland', 'keizersgracht', true)
    expect(sql).toContain("= 'keizersgracht'")
  })

  it('uses LIKE when exact=false', () => {
    const sql = buildStreetNarrowSQL('NL', 'Noord-Holland', 'keizers', false)
    expect(sql).toContain("LIKE 'keizers%'")
  })
})

describe('buildAddressSQL', () => {
  it('uses tile URL with region and filters by street + number prefix', () => {
    const sql = buildAddressSQL('NL', 'Noord-Holland', 'keizersgracht', '18', '841fb47ffffffff')
    expect(sql).toContain(
      'example.com/geocoder/country=NL/region=Noord-Holland/h3_parent=841fb47ffffffff/data_0.parquet',
    )
    expect(sql).toContain("lower(street) = 'keizersgracht'")
    expect(sql).toContain("number LIKE '18%'")
  })
})

describe('buildNumberIndexSQL', () => {
  it('uses Hive number_index path with region', () => {
    const sql = buildNumberIndexSQL('NL', 'Noord-Holland', 'keizersgracht')
    expect(sql).toContain('number_index/country=NL/region=Noord-Holland/data_0.parquet')
    expect(sql).toContain("street_lower = 'keizersgracht'")
  })
})
