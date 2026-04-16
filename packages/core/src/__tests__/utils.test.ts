import { describe, expect, it } from 'vitest'
import {
  addStep,
  esc,
  fmt,
  fmtFull,
  formatSize,
  toArr,
  updateLastStep,
  validateBucket,
  validateCC,
  validateFiniteNumber,
  validateH3,
  validateRelease,
  validateSourceExpr,
} from '../utils'

describe('fmt', () => {
  it.each([
    [1_500_000_000, '1.5B'],
    [1_000_000_000, '1.0B'],
    [3_500_000, '3.5M'],
    [1_000_000, '1.0M'],
    [10_200, '10.2K'],
    [1_000, '1.0K'],
    [999, '999'],
    [0, '0'],
  ])('formats %d as %s', (input, expected) => {
    expect(fmt(input)).toBe(expected)
  })
})

describe('fmtFull', () => {
  it('formats with locale separators', () => {
    const result = fmtFull(1234567)
    expect(result).toMatch(/1.*234.*567/)
  })
})

describe('formatSize', () => {
  it.each([
    [-1, 'N/A'],
    [0, '0B'],
    [512, '512B'],
    [1023, '1023B'],
    [1024, '1KB'],
    [51200, '50KB'],
    [1048576, '1.0MB'],
    [5242880, '5.0MB'],
  ])('formats %d bytes as %s', (input, expected) => {
    expect(formatSize(input)).toBe(expected)
  })
})

describe('esc', () => {
  it('escapes single quotes', () => {
    expect(esc("O'Brien")).toBe("O''Brien")
  })

  it('escapes multiple single quotes', () => {
    expect(esc("it's a test's")).toBe("it''s a test''s")
  })

  it('returns clean strings unchanged', () => {
    expect(esc('hello')).toBe('hello')
  })
})

describe('validateCC', () => {
  it('accepts valid 2-letter uppercase codes', () => {
    expect(() => validateCC('US')).not.toThrow()
    expect(() => validateCC('NL')).not.toThrow()
    expect(() => validateCC('FR')).not.toThrow()
  })

  it('rejects lowercase', () => {
    expect(() => validateCC('us')).toThrow('Invalid country code')
  })

  it('rejects too long or too short', () => {
    expect(() => validateCC('USA')).toThrow('Invalid country code')
    expect(() => validateCC('U')).toThrow('Invalid country code')
  })

  it('rejects non-alpha', () => {
    expect(() => validateCC('12')).toThrow('Invalid country code')
    expect(() => validateCC("A'")).toThrow('Invalid country code')
  })

  it('rejects empty string', () => {
    expect(() => validateCC('')).toThrow('Invalid country code')
  })
})

describe('validateH3', () => {
  it('accepts hex digits', () => {
    expect(() => validateH3('841f8bfffffffff')).not.toThrow()
    expect(() => validateH3('ABCDEF0123')).not.toThrow()
  })
  it('rejects injection attempts', () => {
    expect(() => validateH3("'; DROP TABLE x; --")).toThrow('Invalid h3 id')
    expect(() => validateH3('abc xyz')).toThrow('Invalid h3 id')
    expect(() => validateH3('')).toThrow('Invalid h3 id')
  })
})

describe('validateBucket', () => {
  it('accepts alphanumerics and underscore', () => {
    expect(() => validateBucket('_')).not.toThrow()
    expect(() => validateBucket('01')).not.toThrow()
    expect(() => validateBucket('bucket_1')).not.toThrow()
  })
  it('rejects injection attempts', () => {
    expect(() => validateBucket("'; DROP--")).toThrow('Invalid bucket')
    expect(() => validateBucket('a/b')).toThrow('Invalid bucket')
    expect(() => validateBucket('')).toThrow('Invalid bucket')
  })
})

describe('validateRelease', () => {
  it('accepts well-formed release tags', () => {
    expect(() => validateRelease('2026-03-18.0')).not.toThrow()
    expect(() => validateRelease('2026-04-15.0')).not.toThrow()
    expect(() => validateRelease('2030-12-31.12')).not.toThrow()
  })
  it('rejects malformed tags', () => {
    expect(() => validateRelease('2026-3-18.0')).toThrow('Invalid release')
    expect(() => validateRelease('2026-03-18')).toThrow('Invalid release')
    expect(() => validateRelease('2026-03-18.')).toThrow('Invalid release')
    expect(() => validateRelease('')).toThrow('Invalid release')
  })
  it('rejects injection attempts', () => {
    expect(() => validateRelease("2026-03-18.0'; DROP TABLE x; --")).toThrow('Invalid release')
    expect(() => validateRelease('../../etc/passwd')).toThrow('Invalid release')
  })
})

describe('validateFiniteNumber', () => {
  it('accepts finite numbers', () => {
    expect(() => validateFiniteNumber(0, 'x')).not.toThrow()
    expect(() => validateFiniteNumber(-12.5, 'x')).not.toThrow()
  })
  it('rejects NaN/Infinity/non-numbers', () => {
    expect(() => validateFiniteNumber(Number.NaN, 'lat')).toThrow('Invalid lat')
    expect(() => validateFiniteNumber(Number.POSITIVE_INFINITY, 'lat')).toThrow('Invalid lat')
    expect(() => validateFiniteNumber('1' as unknown as number, 'lat')).toThrow('Invalid lat')
  })
})

describe('validateSourceExpr', () => {
  it('accepts a cached tile identifier', () => {
    expect(() => validateSourceExpr('"_tile_NL_841f8b_01"')).not.toThrow()
    expect(() => validateSourceExpr('"_tile_US_8a2a1072b59ffff_mega_02"')).not.toThrow()
  })
  it('accepts a single read_parquet HTTPS url', () => {
    expect(() => validateSourceExpr("read_parquet('https://s3.example.com/tile.parquet')")).not.toThrow()
  })
  it('accepts a read_parquet list of HTTPS urls', () => {
    expect(() =>
      validateSourceExpr("read_parquet(['https://s3.example.com/a.parquet','https://s3.example.com/b.parquet'])"),
    ).not.toThrow()
  })
  it('rejects raw identifiers', () => {
    expect(() => validateSourceExpr('tbl')).toThrow('Invalid src')
    expect(() => validateSourceExpr('_tile_NL_ab_01')).toThrow('Invalid src')
  })
  it('rejects non-HTTPS urls', () => {
    expect(() => validateSourceExpr("read_parquet('http://evil.com/x.parquet')")).toThrow('Invalid src')
    expect(() => validateSourceExpr("read_parquet('s3://bucket/x.parquet')")).toThrow('Invalid src')
  })
  it('rejects injection attempts', () => {
    expect(() => validateSourceExpr('tbl; DROP TABLE users; --')).toThrow('Invalid src')
    expect(() => validateSourceExpr("read_parquet('https://x.parquet') UNION SELECT 1")).toThrow('Invalid src')
  })
})

describe('toArr', () => {
  it('passes arrays through', () => {
    expect(toArr(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('converts iterables to arrays', () => {
    const iterable = {
      *[Symbol.iterator]() {
        yield 'x'
        yield 'y'
      },
    }
    expect(toArr(iterable)).toEqual(['x', 'y'])
  })

  it('returns empty array for null', () => {
    expect(toArr(null)).toEqual([])
  })

  it('returns empty array for undefined', () => {
    expect(toArr(undefined)).toEqual([])
  })
})

describe('addStep', () => {
  it('appends a step entry', () => {
    const steps = addStep([], 'Loading')
    expect(steps).toEqual([{ text: 'Loading', status: undefined }])
  })

  it('preserves existing steps', () => {
    const steps = addStep([{ text: 'A' }], 'B', 'done')
    expect(steps).toHaveLength(2)
    expect(steps[1]).toEqual({ text: 'B', status: 'done' })
  })

  it('returns a new array (immutable)', () => {
    const original = [{ text: 'A' }]
    const result = addStep(original, 'B')
    expect(result).not.toBe(original)
  })
})

describe('updateLastStep', () => {
  it('replaces the last step', () => {
    const steps = updateLastStep([{ text: 'Loading' }, { text: 'Done' }], 'Updated', 'error')
    expect(steps).toHaveLength(2)
    expect(steps[1]).toEqual({ text: 'Updated', status: 'error' })
  })

  it('returns a new array (immutable)', () => {
    const original = [{ text: 'A' }]
    const result = updateLastStep(original, 'B')
    expect(result).not.toBe(original)
  })
})
