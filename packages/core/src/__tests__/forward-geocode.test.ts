import { describe, expect, it } from 'vitest'
import { batchTilesSourceExpr, buildForwardTileQuerySQL } from '../forward-geocode'

describe('batchTilesSourceExpr', () => {
  it('builds a read_parquet([...]) for valid tiles', () => {
    const src = batchTilesSourceExpr('NL', [
      { h3Res4: '841f8bfffffffff', buckets: ['_'] },
      { h3Res4: '841f8b7ffffffff', buckets: ['01', '02'] },
    ])
    expect(src.startsWith('read_parquet([')).toBe(true)
    expect(src.split(',').length).toBe(3)
    expect(src.includes('country=NL')).toBe(true)
  })
  it('rejects invalid country', () => {
    expect(() => batchTilesSourceExpr("NL'--", [{ h3Res4: 'abc', buckets: ['_'] }])).toThrow('Invalid country code')
  })
  it('rejects invalid h3 id', () => {
    expect(() => batchTilesSourceExpr('NL', [{ h3Res4: "abc'; DROP--", buckets: ['_'] }])).toThrow('Invalid h3 id')
  })
  it('rejects empty tile list', () => {
    expect(() => batchTilesSourceExpr('NL', [])).toThrow('no tiles')
  })
})

describe('buildForwardTileQuerySQL', () => {
  const validSrc = "read_parquet('https://s3.example.com/tile.parquet')"

  it('builds SQL for a valid src + where + limit', () => {
    const sql = buildForwardTileQuerySQL(validSrc, "street = 'Main'", 100)
    expect(sql).toContain('FROM read_parquet')
    expect(sql).toContain("WHERE street = 'Main'")
    expect(sql).toContain('LIMIT 100')
  })
  it('rejects unsafe src', () => {
    expect(() => buildForwardTileQuerySQL('tbl', 'true', 10)).toThrow('Invalid src')
  })
  it('rejects non-integer limit', () => {
    expect(() => buildForwardTileQuerySQL(validSrc, 'true', 0)).toThrow('Invalid limit')
    expect(() => buildForwardTileQuerySQL(validSrc, 'true', 1.5)).toThrow('Invalid limit')
    expect(() => buildForwardTileQuerySQL(validSrc, 'true', 999999)).toThrow('Invalid limit')
  })
})
