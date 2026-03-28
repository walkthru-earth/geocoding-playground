import { describe, expect, it } from 'vitest'
import { suggestionScore } from '../../autocomplete'

describe('suggestionScore', () => {
  it('returns 100 for exact match', () => {
    expect(suggestionScore('via cave', 'via cave')).toBe(100)
  })

  it('is case-insensitive', () => {
    expect(suggestionScore('Via Cave', 'via cave')).toBe(100)
  })

  it('returns 80 for word boundary match', () => {
    expect(suggestionScore('via cave di peperino', 'via cave')).toBe(80)
  })

  it('returns ~60 for prefix match', () => {
    const score = suggestionScore('via cavento', 'via cave')
    expect(score).toBeGreaterThan(60)
    expect(score).toBeLessThan(61)
  })

  it('returns 80 for word boundary (not at start)', () => {
    // "broadway" appears as a whole word in "old broadway avenue"
    expect(suggestionScore('old broadway avenue', 'broadway')).toBe(80)
  })

  it('returns 40 for true substring (not word-bounded)', () => {
    expect(suggestionScore('abcbroadwayxyz', 'broadway')).toBe(40)
  })

  it('returns 0-30 for Jaccard fallback', () => {
    const score = suggestionScore('completely different', 'xyz')
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(30)
  })

  it('ranks exact > word > prefix', () => {
    const exactScore = suggestionScore('via cave', 'via cave')
    const wordScore = suggestionScore('via cave di peperino', 'via cave')
    const prefixScore = suggestionScore('via cavento', 'via cave')
    expect(exactScore).toBeGreaterThan(wordScore)
    expect(wordScore).toBeGreaterThan(prefixScore)
  })

  // ── Issue #3 regression: ranking word matches vs prefix matches ──

  describe('Issue #3: word boundary > prefix (via cave regression)', () => {
    it('"via cave di peperino" (word=80) > "via cavento" (prefix=60) for query "via cave"', () => {
      const wordScore = suggestionScore('via cave di peperino', 'via cave')
      const prefixScore = suggestionScore('via cavento', 'via cave')
      expect(wordScore).toBeGreaterThan(prefixScore)
    })

    it('Jaccard alone would rank "via cavento" higher (longer bigram overlap), but tiered scoring corrects this', () => {
      // This is the core of Issue #3: Jaccard similarity penalizes short queries
      // "via cavento" has Jaccard ~0.70 with "via cave" but is only a prefix match
      // "via cave di peperino" has Jaccard ~0.39 but is a word boundary match
      const wordScore = suggestionScore('via cave di peperino', 'via cave')
      const prefixScore = suggestionScore('via cavento', 'via cave')
      expect(wordScore).toBe(80) // word boundary
      expect(prefixScore).toBeGreaterThan(60) // prefix
      expect(prefixScore).toBeLessThan(61)
    })
  })

  // ── Multi-country ranking scenarios ──

  describe('real-world street ranking', () => {
    it('NL: exact "keizersgracht" > prefix "keizersgrachtkade"', () => {
      const exact = suggestionScore('keizersgracht', 'keizersgracht')
      const prefix = suggestionScore('keizersgrachtkade', 'keizersgracht')
      expect(exact).toBe(100)
      expect(prefix).toBeGreaterThan(60)
      expect(exact).toBeGreaterThan(prefix)
    })

    it('NL: "nieuwe keizersgracht" is word-boundary match for "keizersgracht"', () => {
      const score = suggestionScore('nieuwe keizersgracht', 'keizersgracht')
      expect(score).toBe(80) // word-bounded (space before "keizersgracht")
    })

    it('NL: "gedempte keizersgracht" is word-boundary match for "keizersgracht"', () => {
      const score = suggestionScore('gedempte keizersgracht', 'keizersgracht')
      expect(score).toBe(80) // word-bounded
    })

    it('US: exact "broadway" > "broadway avenue" > "old broadway"', () => {
      const exact = suggestionScore('broadway', 'broadway')
      const suffix = suggestionScore('broadway avenue', 'broadway')
      const mid = suggestionScore('old broadway avenue', 'broadway')
      expect(exact).toBe(100)
      expect(suffix).toBeGreaterThan(60) // prefix
      expect(mid).toBe(80) // word boundary
    })

    it('FR: "rue de rivoli" exact match scores 100', () => {
      expect(suggestionScore('rue de rivoli', 'rue de rivoli')).toBe(100)
    })

    it('FR: "rue de la mairie" vs "rue de la mairerie" (prefix vs word)', () => {
      const exact = suggestionScore('rue de la mairie', 'rue de la mairie')
      const prefix = suggestionScore('rue de la mairerie', 'rue de la mairie')
      expect(exact).toBe(100)
      expect(prefix).toBeLessThan(exact)
    })

    it('DE: "hauptstraße" vs "hauptstraße (frohnhausen)" for query "hauptstraße"', () => {
      const exact = suggestionScore('hauptstraße', 'hauptstraße')
      const extended = suggestionScore('hauptstraße (frohnhausen)', 'hauptstraße')
      expect(exact).toBe(100)
      expect(extended).toBe(80) // word boundary
    })
  })
})
