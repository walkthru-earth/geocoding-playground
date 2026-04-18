import { describe, expect, it, vi } from 'vitest'

vi.mock('../../duckdb', () => ({
  tilePath: (cc: string, h3Res4: string, bucket: string) =>
    `https://example.com/geocoder/country=${cc}/h3_res4=${h3Res4}/bucket=${bucket}/data_0.parquet`,
  indexPath: (type: string, cc: string) => `https://example.com/${type}/country=${cc}/data_0.parquet`,
  getCountryTable: (prefix: string, cc: string) => `"${prefix}_${cc}"`,
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
    const sql = buildPostcodeSQL('NL', '1016', ['t1', 't2'])
    expect(sql).toContain('"_postcodes_NL"')
    expect(sql).toContain("LIKE '1016%'")
    expect(sql).toContain('list_has_any')
    expect(sql).toContain('LIMIT 15')
  })

  it('generates SQL without boost when no city tiles', () => {
    const sql = buildPostcodeSQL('NL', '1016', [])
    expect(sql).not.toContain('list_has_any')
  })

  it('escapes single quotes', () => {
    const sql = buildPostcodeSQL('NL', "test'inject", [])
    expect(sql).toContain("test''inject")
  })
})

describe('buildStreetSQL', () => {
  it('generates correct SQL with city boost', () => {
    const sql = buildStreetSQL('NL', 'keizers', ['t1'])
    expect(sql).toContain('"_streets_NL"')
    expect(sql).toContain("LIKE 'keizers%'")
    expect(sql).toContain('list_has_any')
    expect(sql).toContain('primary_city')
  })
})

describe('buildPostcodeNarrowSQL', () => {
  it('uses exact match', () => {
    const sql = buildPostcodeNarrowSQL('US', '10001')
    expect(sql).toContain("= '10001'")
    expect(sql).toContain('LIMIT 1')
  })
})

describe('buildStreetNarrowSQL', () => {
  it('uses exact match when exact=true', () => {
    const sql = buildStreetNarrowSQL('NL', 'keizersgracht', true)
    expect(sql).toContain("= 'keizersgracht'")
  })

  it('uses LIKE when exact=false', () => {
    const sql = buildStreetNarrowSQL('NL', 'keizers', false)
    expect(sql).toContain("LIKE 'keizers%'")
  })

  it('CA prefix LIKE expands avenue to both ave and avenue so the narrow step finds stored "clearview ave"', () => {
    const sql = buildStreetNarrowSQL('CA', 'clearview avenue', false)
    expect(sql).toContain("'clearview avenue%'")
    expect(sql).toContain("'clearview ave%'")
    expect(sql).toContain(' OR ')
  })
})

describe('buildAddressSQL', () => {
  it('uses tile URL with h3_res4 + bucket and filters by street + number prefix', () => {
    const sql = buildAddressSQL('NL', '841fb47ffffffff', '_', 'keizersgracht', '18')
    expect(sql).toContain('example.com/geocoder/country=NL/h3_res4=841fb47ffffffff/bucket=_/data_0.parquet')
    expect(sql).toContain("street_lower = 'keizersgracht'")
    expect(sql).toContain("number LIKE '18%'")
  })
})

describe('buildNumberIndexSQL', () => {
  it('uses per-country number_index path', () => {
    const sql = buildNumberIndexSQL('NL', 'keizersgracht')
    expect(sql).toContain('number_index/country=NL/data_0.parquet')
    expect(sql).toContain("street_lower = 'keizersgracht'")
  })
})
