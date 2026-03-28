import { describe, expect, it } from 'vitest'
import { classifyInput } from '../../autocomplete'

describe('classifyInput', () => {
  it('returns ready for empty input', () => {
    expect(classifyInput('', 'NL').mode).toBe('ready')
    expect(classifyInput('  ', 'NL').mode).toBe('ready')
  })

  describe('street mode', () => {
    it('detects street name text', () => {
      expect(classifyInput('keizersgracht', 'NL').mode).toBe('street')
      expect(classifyInput('broadway', 'US').mode).toBe('street')
      expect(classifyInput('rue de rivoli', 'FR').mode).toBe('street')
    })
  })

  describe('postcode mode', () => {
    it('detects full postcodes', () => {
      expect(classifyInput('1016AG', 'NL').mode).toBe('postcode')
      expect(classifyInput('10001', 'US').mode).toBe('postcode')
      expect(classifyInput('75001', 'FR').mode).toBe('postcode')
    })

    it('detects partial postcodes in street-first countries', () => {
      expect(classifyInput('1016', 'NL').mode).toBe('postcode')
      expect(classifyInput('101', 'DE').mode).toBe('postcode')
    })
  })

  describe('mixed mode', () => {
    it('single number in NUMBER_FIRST country with partial postcode is postcode', () => {
      // US partial postcode regex matches 1-5 digits, so "104" is detected as partial postcode
      expect(classifyInput('104', 'US').mode).toBe('postcode')
    })

    it('ambiguous when number + text in NUMBER_FIRST country', () => {
      // "104 b" has a number and text, parser detects street+number -> ready
      const c = classifyInput('104 broadway', 'US')
      expect(c.mode).toBe('ready')
    })
  })

  describe('ready mode', () => {
    it('street + number in street-first country', () => {
      expect(classifyInput('keizersgracht 185', 'NL').mode).toBe('ready')
    })

    it('number + street in NUMBER_FIRST country', () => {
      expect(classifyInput('25 broadway', 'US').mode).toBe('ready')
    })
  })

  // ── Real-world user scenarios from _study/AUTOCOMPLETE.md ──

  describe('multi-country street detection', () => {
    it('DE: hauptstraße is street mode', () => {
      expect(classifyInput('hauptstraße', 'DE').mode).toBe('street')
    })

    it('JP: kanji street name is street mode', () => {
      expect(classifyInput('本郷', 'JP').mode).toBe('street')
    })

    it('IT: via aldo moro is street mode', () => {
      expect(classifyInput('via aldo moro', 'IT').mode).toBe('street')
    })

    it('ES: calle gran via is street mode', () => {
      expect(classifyInput('calle gran via', 'ES').mode).toBe('street')
    })

    it('FR: rue de rivoli is street mode', () => {
      expect(classifyInput('rue de rivoli', 'FR').mode).toBe('street')
    })

    it('BR: avenida paulista is street mode', () => {
      expect(classifyInput('avenida paulista', 'BR').mode).toBe('street')
    })
  })

  describe('multi-country postcode detection', () => {
    it('US: 10465 (5-digit ZIP)', () => {
      expect(classifyInput('10465', 'US').mode).toBe('postcode')
    })

    it('US: 10465-1234 (ZIP+4)', () => {
      const c = classifyInput('10465-1234', 'US')
      expect(c.parsed.postcode).toBe('10465-1234')
    })

    it('FR: 75012 (Paris arrondissement)', () => {
      expect(classifyInput('75012', 'FR').mode).toBe('postcode')
    })

    it('DE: 20095 (Hamburg postcode)', () => {
      expect(classifyInput('20095', 'DE').mode).toBe('postcode')
    })

    it('CA: K1A 0A0 (alphanumeric postcode)', () => {
      const c = classifyInput('K1A 0A0', 'CA')
      expect(c.parsed.postcode).toBe('K1A 0A0')
    })

    it('BR: 68270-000 (CEP)', () => {
      const c = classifyInput('68270-000', 'BR')
      expect(c.parsed.postcode).toBe('68270-000')
    })

    it('AU: 2000 (4-digit postcode)', () => {
      expect(classifyInput('2000', 'AU').mode).toBe('postcode')
    })

    it('JP: 100-0001 (7-digit postcode)', () => {
      const c = classifyInput('100-0001', 'JP')
      expect(c.parsed.postcode).toBe('100-0001')
    })

    it('PL: 00-000 (Polish postcode)', () => {
      const c = classifyInput('00-000', 'PL')
      expect(c.parsed.postcode).toBe('00-000')
    })
  })

  describe('ready mode: street + number (complete address)', () => {
    it('NL: keizersgracht 185 (street-first)', () => {
      const c = classifyInput('keizersgracht 185', 'NL')
      expect(c.mode).toBe('ready')
      expect(c.parsed.street?.toLowerCase()).toBe('keizersgracht')
      expect(c.parsed.number).toBe('185')
    })

    it('US: 1041 logan ave (NUMBER_FIRST)', () => {
      const c = classifyInput('1041 logan ave', 'US')
      expect(c.mode).toBe('ready')
      expect(c.parsed.number).toBe('1041')
    })

    it('DE: kleiststraße 116 (street-first)', () => {
      const c = classifyInput('kleiststraße 116', 'DE')
      expect(c.mode).toBe('ready')
      expect(c.parsed.number).toBe('116')
    })

    it('FR: 7 rue tourneux (number-first format)', () => {
      const c = classifyInput('7 rue tourneux', 'FR')
      expect(c.mode).toBe('ready')
      expect(c.parsed.number).toBe('7')
    })

    it('AU: 196 condamine street (NUMBER_FIRST)', () => {
      const c = classifyInput('196 condamine street', 'AU')
      expect(c.mode).toBe('ready')
      expect(c.parsed.number).toBe('196')
    })

    it('IT: via aldo moro 64 (no postcode country)', () => {
      const c = classifyInput('via aldo moro 64', 'IT')
      expect(c.mode).toBe('ready')
      expect(c.parsed.number).toBe('64')
    })

    it('BR: rua augusta 1234 (street-first in Overture data)', () => {
      const c = classifyInput('rua augusta 1234', 'BR')
      expect(c.mode).toBe('ready')
    })

    it('ES: calle vinyar 55 (street + number)', () => {
      const c = classifyInput('calle vinyar 55', 'ES')
      expect(c.mode).toBe('ready')
      expect(c.parsed.number).toBe('55')
    })
  })

  describe('progressive input transitions', () => {
    it('US: "104" is postcode, "1041 logan" is ready', () => {
      expect(classifyInput('104', 'US').mode).toBe('postcode')
      expect(classifyInput('1041', 'US').mode).toBe('postcode')
      expect(classifyInput('1041 logan', 'US').mode).toBe('ready')
    })

    it('NL: "10" is postcode, "1016" is postcode, "1016AG" is postcode', () => {
      expect(classifyInput('10', 'NL').mode).toBe('postcode')
      expect(classifyInput('1016', 'NL').mode).toBe('postcode')
      expect(classifyInput('1016AG', 'NL').mode).toBe('postcode')
    })

    it('NL: "keizersgracht" is street, "keizersgracht 1" is ready', () => {
      expect(classifyInput('keizersgracht', 'NL').mode).toBe('street')
      expect(classifyInput('keizersgracht 1', 'NL').mode).toBe('ready')
    })

    it('CA: partial FSA "M3N" is postcode detection', () => {
      const c = classifyInput('M3N', 'CA')
      // M3N is a partial Canadian FSA, should trigger postcode detection
      expect(c.mode).toBe('postcode')
    })
  })

  describe('street query extraction for NUMBER_FIRST vs street-first', () => {
    it('US: strips leading number', () => {
      expect(classifyInput('1041 logan ave', 'US').streetQuery).toBe('logan ave')
    })

    it('NL: strips trailing number', () => {
      expect(classifyInput('keizersgracht 185', 'NL').streetQuery).toBe('keizersgracht')
    })

    it('DE: strips trailing number', () => {
      expect(classifyInput('kleiststraße 116', 'DE').streetQuery).toBe('kleiststraße')
    })

    it('AU: strips leading number', () => {
      expect(classifyInput('196 condamine street', 'AU').streetQuery).toBe('condamine street')
    })

    it('FR: preserves multi-word street', () => {
      const c = classifyInput('rue de rivoli', 'FR')
      expect(c.streetQuery).toBe('rue de rivoli')
    })
  })

  describe('edge cases', () => {
    it('NL: single digit "3" returns no useful suggestions (< 2 chars meaningful)', () => {
      const c = classifyInput('3', 'NL')
      // Single digit in street-first country detected as partial postcode
      expect(c.mode).toBe('postcode')
    })

    it('whitespace only returns ready mode', () => {
      expect(classifyInput('   ', 'US').mode).toBe('ready')
      expect(classifyInput('\t', 'NL').mode).toBe('ready')
    })

    it('DE: 5-digit number is postcode, not house number', () => {
      // In DE, a 5-digit number alone should be postcode, not street
      expect(classifyInput('20095', 'DE').mode).toBe('postcode')
    })
  })

  describe('classification fields', () => {
    it('populates parsed address fields', () => {
      const c = classifyInput('keizersgracht 185', 'NL')
      expect(c.parsed.street?.toLowerCase()).toBe('keizersgracht')
      expect(c.parsed.number).toBe('185')
      expect(c.cc).toBe('NL')
      expect(c.raw).toBe('keizersgracht 185')
    })

    it('extracts street query (number stripped)', () => {
      expect(classifyInput('25 broadway', 'US').streetQuery).toBe('broadway')
      expect(classifyInput('keizersgracht 185', 'NL').streetQuery).toBe('keizersgracht')
    })
  })
})
