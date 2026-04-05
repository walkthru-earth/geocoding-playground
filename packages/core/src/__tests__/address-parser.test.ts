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
