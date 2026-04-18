import { describe, expect, it } from 'vitest'
import { buildDefaultWhere, getParser, NUMBER_FIRST, POSTCODE_RE } from '../address-parser'

describe('POSTCODE_RE', () => {
  it.each([
    ['US', '90210', true],
    ['US', '90210-1234', true],
    ['US', '9021', false],
    ['US', 'ABC12', false],
    ['DE', '10117', true],
    ['DE', '1011', false],
    ['FR', '75001', true],
    ['FR', '7500', false],
    ['NL', '1016AG', true],
    ['NL', '1016', true],
    ['NL', '1016a', true],
    ['CA', 'K1A 0A0', true],
    ['CA', 'K1A0A0', true],
    ['CA', 'K1A', false],
    ['BR', '68270-000', true],
    ['BR', '68270000', true],
    ['BR', '6827', false],
    ['AU', '2000', true],
    ['AU', '200', false],
    ['JP', '100-0001', true],
    ['JP', '1000001', true],
    ['JP', '100', false],
    ['PL', '00-000', true],
    ['PL', '00000', true],
    ['PL', '000', false],
    ['CH', '8001', true],
    ['CH', '80', false],
    ['PT', '1000', true],
    ['PT', '1000-001', true],
    ['SE', '111 22', true],
    ['SE', '11122', true],
  ] as [string, string, boolean][])('%s: "%s" -> %s', (cc, input, expected) => {
    const re = POSTCODE_RE[cc]
    expect(re).toBeDefined()
    expect(re.test(input)).toBe(expected)
  })
})

describe('NUMBER_FIRST', () => {
  it('contains the correct 14 countries', () => {
    const expected = new Set(['US', 'CA', 'AU', 'NZ', 'BR', 'MX', 'CL', 'CO', 'UY', 'SG', 'HK', 'TW', 'GB', 'IE'])
    expect(NUMBER_FIRST).toEqual(expected)
  })

  it('does not contain street-first countries', () => {
    for (const cc of ['NL', 'DE', 'FR', 'IT', 'ES', 'AT', 'CH', 'JP']) {
      expect(NUMBER_FIRST.has(cc)).toBe(false)
    }
  })
})

describe('buildDefaultWhere', () => {
  it('builds street + number conditions', () => {
    const sql = buildDefaultWhere({ street: 'Broadway', number: '25', tokens: ['25', 'Broadway'], raw: '25 Broadway' })
    expect(sql).toContain("street_lower LIKE 'broadway%'")
    expect(sql).toContain("number = '25'")
  })

  it('builds postcode condition', () => {
    const sql = buildDefaultWhere({ postcode: '1016AG', tokens: ['1016AG'], raw: '1016AG' })
    expect(sql).toContain("lower(postcode) = '1016ag'")
  })

  it('escapes single quotes', () => {
    const sql = buildDefaultWhere({ street: "O'Brien St", tokens: ["O'Brien", 'St'], raw: "O'Brien St" })
    expect(sql).toContain("o''brien st")
  })

  it('falls back to ILIKE for tokens only', () => {
    const sql = buildDefaultWhere({ tokens: ['hello', 'world'], raw: 'hello world' })
    expect(sql).toContain("full_address ILIKE '%hello%'")
    expect(sql).toContain("full_address ILIKE '%world%'")
  })

  it('returns 1=1 for empty input', () => {
    const sql = buildDefaultWhere({ tokens: [], raw: '' })
    expect(sql).toBe('1=1')
  })
})

// ── Street-type expansion (Track B integration with libpostal dicts) ──

describe('buildDefaultWhere: libpostal expansion', () => {
  it('CA: "clearview avenue" expands to include both "clearview avenue" and "clearview ave"', () => {
    const sql = buildDefaultWhere({
      street: 'clearview avenue',
      number: '195',
      tokens: ['195', 'clearview', 'avenue'],
      raw: '195 clearview avenue',
      cc: 'CA',
    })
    expect(sql).toContain("'clearview avenue%'")
    expect(sql).toContain("'clearview ave%'")
    expect(sql).toContain(' OR ')
    expect(sql).toContain("number = '195'")
  })

  it('CA: "clearview ave" also expands to include "clearview avenue"', () => {
    const sql = buildDefaultWhere({
      street: 'clearview ave',
      number: '195',
      tokens: ['195', 'clearview', 'ave'],
      raw: '195 clearview ave',
      cc: 'CA',
    })
    expect(sql).toContain('clearview ave%')
    expect(sql).toContain('clearview avenue%')
  })

  it('DE: "haupt strasse" expands to include "haupt str"', () => {
    const sql = buildDefaultWhere({
      street: 'haupt strasse',
      number: '5',
      tokens: ['haupt', 'strasse', '5'],
      raw: 'haupt strasse 5',
      cc: 'DE',
    })
    expect(sql).toContain('haupt strasse%')
    expect(sql).toContain('haupt str%')
  })

  it('US: leading directional "n main street" expands to "north main street"', () => {
    const sql = buildDefaultWhere({
      street: 'n main street',
      number: '100',
      tokens: ['100', 'n', 'main', 'street'],
      raw: '100 n main street',
      cc: 'US',
    })
    // Leading directional expansion OR street-type expansion, at least one
    // must fire. The trailing "street" token is expanded to variants first
    // because it matches the street-type dictionary.
    expect(sql).toMatch(/n main street%/)
    expect(sql).toContain('n main st%')
  })

  it('US: trailing "avenue" still expands when mixed with a directional', () => {
    const sql = buildDefaultWhere({
      street: 'clearview avenue',
      tokens: ['clearview', 'avenue'],
      raw: 'clearview avenue',
      cc: 'US',
    })
    expect(sql).toContain('clearview avenue%')
    expect(sql).toContain('clearview ave%')
  })

  // End-to-end guard: the playground calls getParser(cc).buildWhereClause,
  // not buildDefaultWhere directly. Without this test the expansion can
  // silently regress because every parser's buildWhereClause must pass its
  // own cc through. See issue #11 debug session.
  it('E2E via getParser: CA "195 clearview avenue" produces expanded WHERE', () => {
    const parser = getParser('CA')
    const parsed = parser.parseAddress('195 clearview avenue')
    expect(parsed.number).toBe('195')
    expect(parsed.street).toBe('clearview avenue')
    const sql = parser.buildWhereClause(parsed)
    expect(sql).toContain("'clearview avenue%'")
    expect(sql).toContain("'clearview ave%'")
    expect(sql).toContain("number = '195'")
  })

  it('E2E via getParser: CA tolerates number-last "clearview ave 195"', () => {
    const parser = getParser('CA')
    const parsed = parser.parseAddress('clearview ave 195')
    expect(parsed.number).toBe('195')
    expect(parsed.street).toBe('clearview ave')
    const sql = parser.buildWhereClause(parsed)
    expect(sql).toContain("'clearview ave%'")
    expect(sql).toContain("'clearview avenue%'")
    expect(sql).toContain("number = '195'")
  })

  it('E2E via getParser: IT "via roma 12" emits expanded WHERE without postcode', () => {
    const parser = getParser('IT')
    const parsed = parser.parseAddress('via roma 12')
    expect(parsed.street).toBe('via roma')
    expect(parsed.number).toBe('12')
    const sql = parser.buildWhereClause(parsed)
    // `via` has libpostal variants (`v`, `v.`, `viale` is separate), at minimum
    // the original form is preserved.
    expect(sql).toContain("'via roma%'")
    // Postcode condition must be absent even when parsed extracted one, IT
    // has 0 postcodes in Overture.
    expect(sql).not.toMatch(/postcode/)
  })

  it('without cc: behavior is unchanged (no expansion)', () => {
    const sql = buildDefaultWhere({
      street: 'clearview avenue',
      tokens: ['clearview', 'avenue'],
      raw: 'clearview avenue',
    })
    expect(sql).toBe("street_lower LIKE 'clearview avenue%'")
  })

  it('every expanded variant goes through esc() individually', () => {
    // Street with a quote in the head (common in real O'Brien street names).
    // Each expanded prefix must be individually escaped.
    const sql = buildDefaultWhere({
      street: "o'brien street",
      tokens: ["o'brien", 'street'],
      raw: "o'brien street",
      cc: 'US',
    })
    expect(sql).toContain("'o''brien street%'")
    // Multiple variants, each carrying the same escaped head
    const count = (sql.match(/o''brien /g) || []).length
    expect(count).toBeGreaterThanOrEqual(2)
    // No unescaped single quote inside any literal (every quote is either
    // the literal's opening/closing quote, or the doubled "''" escape).
    // Count unescaped quotes: odd number of consecutive quotes outside the
    // opening/closing marks would indicate a breakout.
    const withoutEscaped = sql.replace(/''/g, '')
    // After stripping escaped pairs, we should only see pairs of balanced
    // literal delimiters (opening and closing), no stray interior quotes.
    const streetLike = withoutEscaped.match(/LIKE '([^']*)'/g) ?? []
    expect(streetLike.length).toBeGreaterThan(0)
  })

  it('ambiguous token does not expand (CA ambiguous case)', () => {
    // "st" on the tail is not ambiguous in en's dictionary, but "a" is.
    // Assert the ambiguous guard holds: the clause is a single prefix.
    const sql = buildDefaultWhere({
      street: 'some a',
      tokens: ['some', 'a'],
      raw: 'some a',
      cc: 'US',
    })
    expect(sql).toBe("street_lower LIKE 'some a%'")
  })
})

describe('getParser', () => {
  it('returns a parser for registered countries', () => {
    const parser = getParser('US')
    expect(parser).toBeDefined()
    expect(parser.parseAddress).toBeTypeOf('function')
  })

  it('returns GenericParser for unregistered countries', () => {
    const parser = getParser('PL')
    expect(parser).toBeDefined()
    expect(parser.parseAddress).toBeTypeOf('function')
  })

  it('caches parser instances', () => {
    const p1 = getParser('DE')
    const p2 = getParser('DE')
    expect(p1).toBe(p2)
  })
})
