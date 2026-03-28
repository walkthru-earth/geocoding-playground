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
})
