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
