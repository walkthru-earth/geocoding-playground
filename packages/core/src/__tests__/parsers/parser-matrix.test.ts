import { describe, expect, it } from 'vitest'
import { getParser, NUMBER_FIRST } from '../../address-parser'

// ── Test fixture type ───────────────────────────────────────

interface ParserCase {
  cc: string
  input: string
  expected: {
    street?: string
    number?: string
    unit?: string
    postcode?: string
  }
}

// ── Custom parser test cases (10 countries) ─────────────────

const customParserCases: ParserCase[] = [
  // US: number-first, ZIP extraction, unit indicators, state stripping
  { cc: 'US', input: '25 Broadway', expected: { number: '25', street: 'Broadway' } },
  {
    cc: 'US',
    input: '1871 MENAHAN ST APT 2R NY 11385',
    expected: { number: '1871', street: 'MENAHAN ST', unit: 'APT 2R', postcode: '11385' },
  },
  { cc: 'US', input: '10001', expected: { postcode: '10001' } },
  { cc: 'US', input: 'broadway', expected: { street: 'broadway' } },

  // NL: street-first, 4-digit+letter postcode, ordinals preserved
  { cc: 'NL', input: 'Keizersgracht 185', expected: { street: 'Keizersgracht', number: '185' } },
  {
    cc: 'NL',
    input: 'Keizersgracht 185 1016AG',
    expected: { street: 'Keizersgracht', number: '185', postcode: '1016AG' },
  },
  { cc: 'NL', input: '2e Nassaustraat', expected: { street: '2e Nassaustraat' } },
  { cc: 'NL', input: '1016', expected: {} },

  // DE: street-first, 5-digit postcode
  { cc: 'DE', input: 'Unter den Linden 5', expected: { street: 'Unter den Linden', number: '5' } },
  { cc: 'DE', input: '10117', expected: { postcode: '10117' } },
  { cc: 'DE', input: 'Hauptstrasse', expected: { street: 'Hauptstrasse' } },

  // FR: number-first (12 Rue de Rivoli), 5-digit postcode, arrondissement stripping
  { cc: 'FR', input: '12 Rue de Rivoli', expected: { number: '12', street: 'Rue de Rivoli' } },
  { cc: 'FR', input: '75001', expected: { postcode: '75001' } },

  // BR: street-first in Overture data (Rua Augusta 1234), CEP postcode
  { cc: 'BR', input: 'Rua Augusta 1234', expected: { street: 'Rua Augusta', number: '1234' } },
  { cc: 'BR', input: '01305-000', expected: { postcode: '01305-000' } },

  // JP: street-first, 7-digit postcode
  { cc: 'JP', input: '本郷 1-2-3', expected: { street: '本郷', number: '1-2-3' } },
  { cc: 'JP', input: '100-0001', expected: { postcode: '100-0001' } },

  // AU: number-first, 4-digit postcode, slash unit notation
  { cc: 'AU', input: '45 George Street', expected: { number: '45', street: 'George Street' } },
  { cc: 'AU', input: '2000', expected: { postcode: '2000' } },

  // CA: number-first, alphanumeric postcode
  { cc: 'CA', input: '123 King Street', expected: { number: '123', street: 'King Street' } },
  { cc: 'CA', input: 'K1A 0A0', expected: { postcode: 'K1A 0A0' } },

  // ES: street-first, 5-digit postcode
  { cc: 'ES', input: 'Calle Gran Via 12', expected: { street: 'Calle Gran Via', number: '12' } },
  { cc: 'ES', input: '28013', expected: { postcode: '28013' } },

  // IT: street-first, 5-digit postcode
  { cc: 'IT', input: 'Via del Corso 12', expected: { street: 'Via del Corso', number: '12' } },
  { cc: 'IT', input: '00186', expected: { postcode: '00186' } },
]

describe('Custom parsers', () => {
  it.each(customParserCases)('$cc: "$input"', ({ cc, input, expected }) => {
    const parser = getParser(cc)
    const result = parser.parseAddress(input)

    if (expected.street !== undefined) {
      expect(result.street).toBe(expected.street)
    }
    if (expected.number !== undefined) {
      expect(result.number).toBe(expected.number)
    }
    if (expected.unit !== undefined) {
      expect(result.unit).toBe(expected.unit)
    }
    if (expected.postcode !== undefined) {
      expect(result.postcode).toBe(expected.postcode)
    }
  })
})

// ── GenericParser countries ─────────────────────────────────

const genericParserCountries = [
  // NUMBER_FIRST countries using GenericParser
  'NZ',
  'MX',
  'CL',
  'CO',
  'UY',
  'SG',
  'HK',
  'TW',
  'GB',
  'IE',
  // Street-first countries using GenericParser
  'AT',
  'BE',
  'CH',
  'CZ',
  'DK',
  'FI',
  'NO',
  'PL',
  'PT',
  'SE',
  'HR',
  'RS',
  'SK',
  'SI',
  'EE',
  'LV',
  'LT',
  'LU',
  'IS',
]

describe('GenericParser countries', () => {
  describe.each(genericParserCountries)('%s', (cc) => {
    it('returns a parser', () => {
      const parser = getParser(cc)
      expect(parser).toBeDefined()
    })

    it('parses a street-only input', () => {
      const parser = getParser(cc)
      const result = parser.parseAddress('Main Street')
      expect(result.raw).toBe('Main Street')
      expect(result.tokens).toEqual(['Main', 'Street'])
    })

    if (NUMBER_FIRST.has(cc)) {
      it('extracts leading number (NUMBER_FIRST)', () => {
        const parser = getParser(cc)
        const result = parser.parseAddress('25 Main Street')
        expect(result.number).toBe('25')
        expect(result.street).toBe('Main Street')
      })
    } else {
      it('extracts trailing number (street-first)', () => {
        const parser = getParser(cc)
        const result = parser.parseAddress('Main Street 25')
        expect(result.number).toBe('25')
        expect(result.street).toBe('Main Street')
      })
    }
  })
})

// ── buildWhereClause ────────────────────────────────────────

describe('buildWhereClause', () => {
  it.each(['US', 'NL', 'DE', 'FR', 'BR', 'JP', 'AU', 'CA', 'ES', 'IT', 'PL', 'AT'])('%s: generates valid SQL', (cc) => {
    const parser = getParser(cc)
    const parsed = parser.parseAddress('Main Street 25')
    const sql = parser.buildWhereClause(parsed)
    expect(sql).toBeTruthy()
    expect(sql).not.toBe('1=1')
  })
})
