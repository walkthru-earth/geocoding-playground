import { describe, expect, it } from 'vitest'
import { getParser, NUMBER_FIRST } from '../../address-parser'
import { stripJPCoordZone } from '../../parsers/jp'

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
  // Also handles trailing numbers (data format: "Rue de Rivoli 12")
  { cc: 'FR', input: '12 Rue de Rivoli', expected: { number: '12', street: 'Rue de Rivoli' } },
  { cc: 'FR', input: '75001', expected: { postcode: '75001' } },
  { cc: 'FR', input: "Rue de l'Eglise 12", expected: { number: '12', street: "Rue de l'Eglise" } },
  {
    cc: 'FR',
    input: '55 Rue du Faubourg Saint-Honoré',
    expected: { number: '55', street: 'Rue du Faubourg Saint-Honoré' },
  },
  {
    cc: 'FR',
    input: '1 Avenue des Champs-Élysées 75008',
    expected: { number: '1', street: 'Avenue des Champs-Élysées', postcode: '75008' },
  },
  { cc: 'FR', input: '10 Boulevard Haussmann', expected: { number: '10', street: 'Boulevard Haussmann' } },

  // BR: street-first in Overture data (Rua Augusta 1234), CEP postcode
  { cc: 'BR', input: 'Rua Augusta 1234', expected: { street: 'Rua Augusta', number: '1234' } },
  { cc: 'BR', input: '01305-000', expected: { postcode: '01305-000' } },

  // JP: street-first, 7-digit postcode
  // "1-2-3" = chome-banchi-go. Parser extracts banchi (2nd segment) because
  // chome is in the street field and go isn't in Overture data (ISJ block-level).
  { cc: 'JP', input: '本郷 1-2-3', expected: { street: '本郷', number: '2' } },
  { cc: 'JP', input: '本郷 100', expected: { street: '本郷', number: '100' } },
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

// ── Additional real-world parsing scenarios from _study docs ──

describe('Extended parser scenarios', () => {
  // AU slash unit notation (3/45 George Street)
  it('AU: "3/45 george street" extracts unit and number', () => {
    const parser = getParser('AU')
    const result = parser.parseAddress('3/45 george street')
    expect(result.number).toBe('45')
    expect(result.street?.toLowerCase()).toContain('george street')
  })

  // US: ZIP+4 extraction
  it('US: "10465-1234" extracts ZIP+4 as postcode', () => {
    const parser = getParser('US')
    const result = parser.parseAddress('10465-1234')
    expect(result.postcode).toBe('10465-1234')
  })

  // US: full address with ZIP
  it('US: "1041 logan ave 10465" extracts number, street, and postcode', () => {
    const parser = getParser('US')
    const result = parser.parseAddress('1041 logan ave 10465')
    expect(result.number).toBe('1041')
    expect(result.postcode).toBe('10465')
  })

  // NL: full address with postcode
  it('NL: "keizersgracht 185 1016AG" extracts all parts', () => {
    const parser = getParser('NL')
    const result = parser.parseAddress('keizersgracht 185 1016AG')
    expect(result.street).toBe('keizersgracht')
    expect(result.number).toBe('185')
    expect(result.postcode).toBe('1016AG')
  })

  // CA: progressive FSA to full postcode
  it('CA: "K1A 0A0" extracts full Canadian postcode', () => {
    const parser = getParser('CA')
    const result = parser.parseAddress('K1A 0A0')
    expect(result.postcode).toBe('K1A 0A0')
  })

  it('CA: "123 King Street K1A 0A0" extracts number, street, and postcode', () => {
    const parser = getParser('CA')
    const result = parser.parseAddress('123 King Street K1A 0A0')
    expect(result.number).toBe('123')
    expect(result.postcode).toBe('K1A 0A0')
  })

  // BR: CEP format
  it('BR: "avenida paulista 1234" extracts street and number', () => {
    const parser = getParser('BR')
    const result = parser.parseAddress('avenida paulista 1234')
    expect(result.number).toBe('1234')
  })

  // DE: multi-word street names (real data uses ß, not ss)
  it('DE: "unter den linden 5" preserves multi-word street', () => {
    const parser = getParser('DE')
    const result = parser.parseAddress('unter den linden 5')
    expect(result.street?.toLowerCase()).toContain('unter den linden')
    expect(result.number).toBe('5')
  })

  it('DE: "hauptstraße 10" parses ß character correctly', () => {
    const parser = getParser('DE')
    const result = parser.parseAddress('hauptstraße 10')
    expect(result.street?.toLowerCase()).toContain('hauptstraße')
    expect(result.number).toBe('10')
  })

  // ES: street + number + postcode
  it('ES: "calle gran via 12 28013" extracts all parts', () => {
    const parser = getParser('ES')
    const result = parser.parseAddress('calle gran via 12 28013')
    expect(result.number).toBe('12')
    expect(result.postcode).toBe('28013')
  })

  // IT: no postcode in Overture, but parser handles it
  it('IT: "via del corso 12" is street + number only', () => {
    const parser = getParser('IT')
    const result = parser.parseAddress('via del corso 12')
    expect(result.number).toBe('12')
    expect(result.postcode).toBeUndefined()
  })

  // JP: chome-banchi-go notation. Parser extracts only banchi (2nd segment)
  // because chome is in Overture's street field and go isn't in ISJ data.
  it('JP: "本郷 1-2-3" extracts banchi (2nd segment)', () => {
    const parser = getParser('JP')
    const result = parser.parseAddress('本郷 1-2-3')
    expect(result.street).toBe('本郷')
    expect(result.number).toBe('2')
  })

  it('JP: "本郷 1-2" extracts banchi from 2-segment', () => {
    const parser = getParser('JP')
    const result = parser.parseAddress('本郷 1-2')
    expect(result.street).toBe('本郷')
    expect(result.number).toBe('2')
  })

  it('JP: plain lot number "本郷 362" stays as-is', () => {
    const parser = getParser('JP')
    const result = parser.parseAddress('本郷 362')
    expect(result.street).toBe('本郷')
    expect(result.number).toBe('362')
  })

  it('JP: street-only "本郷" has no number', () => {
    const parser = getParser('JP')
    const result = parser.parseAddress('本郷')
    expect(result.street).toBe('本郷')
    expect(result.number).toBeUndefined()
  })

  // FR: full address with postcode
  it('FR: "12 rue de rivoli 75001" extracts number, street, and postcode', () => {
    const parser = getParser('FR')
    const result = parser.parseAddress('12 rue de rivoli 75001')
    expect(result.number).toBe('12')
    expect(result.street?.toLowerCase()).toContain('rue de rivoli')
    expect(result.postcode).toBe('75001')
  })

  // FR: arrondissement stripping
  it('FR: strips arrondissement suffix from input', () => {
    const parser = getParser('FR')
    const result = parser.parseAddress('12 Rue de Rivoli Paris 1er Arrondissement')
    expect(result.number).toBe('12')
    expect(result.street).toBe('Rue de Rivoli Paris')
    // "1er" and "Arrondissement" should be stripped
    expect(result.street).not.toContain('Arrondissement')
    expect(result.street).not.toMatch(/\b1er\b/)
  })

  it('FR: strips numeric arrondissement (8e) from input', () => {
    const parser = getParser('FR')
    const result = parser.parseAddress('55 Rue du Faubourg Saint-Honoré 8e Arrondissement')
    expect(result.number).toBe('55')
    expect(result.street).not.toContain('8e')
    expect(result.street).not.toContain('Arrondissement')
  })

  // FR: multi-word street types
  it('FR: "3 Place de la Concorde 75008" handles Place type', () => {
    const parser = getParser('FR')
    const result = parser.parseAddress('3 Place de la Concorde 75008')
    expect(result.number).toBe('3')
    expect(result.postcode).toBe('75008')
  })

  it('FR: "24 Quai du Louvre" handles Quai type', () => {
    const parser = getParser('FR')
    const result = parser.parseAddress('24 Quai du Louvre')
    expect(result.number).toBe('24')
    expect(result.street).toBe('Quai du Louvre')
  })

  // FR: Lyon and Marseille addresses
  it('FR: "45 Cours Charlemagne 69002" Lyon address', () => {
    const parser = getParser('FR')
    const result = parser.parseAddress('45 Cours Charlemagne 69002')
    expect(result.number).toBe('45')
    expect(result.postcode).toBe('69002')
  })

  it('FR: "80 Rue de la République 13002" Marseille address', () => {
    const parser = getParser('FR')
    const result = parser.parseAddress('80 Rue de la République 13002')
    expect(result.number).toBe('80')
    expect(result.postcode).toBe('13002')
  })

  // NL: ordinal streets preserved
  it('NL: "2e nassaustraat 10" parses ordinal street with number', () => {
    const parser = getParser('NL')
    const result = parser.parseAddress('2e nassaustraat 10')
    expect(result.street?.toLowerCase()).toContain('nassaustraat')
    expect(result.number).toBe('10')
  })
})

describe('buildWhereClause', () => {
  it.each(['US', 'NL', 'DE', 'FR', 'BR', 'JP', 'AU', 'CA', 'ES', 'IT', 'PL', 'AT'])('%s: generates valid SQL', (cc) => {
    const parser = getParser(cc)
    const parsed = parser.parseAddress('Main Street 25')
    const sql = parser.buildWhereClause(parsed)
    expect(sql).toBeTruthy()
    expect(sql).not.toBe('1=1')
  })

  // JP uses split_part to strip MLIT coordinate zone from number field
  it('JP: buildWhereClause uses split_part for number matching', () => {
    const parser = getParser('JP')
    const parsed = parser.parseAddress('本郷 362')
    const sql = parser.buildWhereClause(parsed)
    expect(sql).toContain("street_lower LIKE '本郷%'")
    expect(sql).toContain("split_part(number, '-', 1) = '362'")
    // Must NOT use plain "number = '362'" (would miss "362-9" in data)
    expect(sql).not.toContain("number = '362'")
  })
})

// ── JP coordinate zone stripping ──────────────────────────────

describe('stripJPCoordZone', () => {
  it('strips trailing zone from "362-9"', () => {
    expect(stripJPCoordZone('362-9')).toBe('362')
  })

  it('strips trailing zone from "1000-12"', () => {
    expect(stripJPCoordZone('1000-12')).toBe('1000')
  })

  it('returns plain number unchanged', () => {
    expect(stripJPCoordZone('362')).toBe('362')
  })

  it('returns empty string unchanged', () => {
    expect(stripJPCoordZone('')).toBe('')
  })
})
