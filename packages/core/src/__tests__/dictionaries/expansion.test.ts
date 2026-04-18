import { describe, expect, it } from 'vitest'
import { expandDirectional, expandStreetVariants, getCountryLanguages } from '../../dictionaries/index'

/**
 * Round-trip expansion checks: typing the canonical form should produce the
 * variants, and typing any variant should produce the canonical.
 *
 * Cases are picked to hit both directions per language and to cover the
 * Germanic ß↔ss normalization that `normalizeForSearch` also handles at the
 * query layer.
 */

describe('expandStreetVariants: round-trips', () => {
  /**
   * Full word expands to abbr, and abbr expands back to full when the abbr is
   * not listed in the language's ambiguous set. Single-character abbreviations
   * like "v", "n", "s" are commonly ambiguous (direction, country code,
   * middle initial) and are intentionally suppressed.
   */
  function bothWays(cc: string, full: string, abbr: string) {
    const fromFull = expandStreetVariants(cc, full)
    const fromAbbr = expandStreetVariants(cc, abbr)
    expect(fromFull, `${cc}: ${full} should contain ${abbr}`).toContain(abbr)
    expect(fromAbbr, `${cc}: ${abbr} should contain ${full}`).toContain(full)
    expect(fromFull[0]).toBe(full.toLowerCase())
    expect(fromAbbr[0]).toBe(abbr.toLowerCase())
  }

  function canonicalToAbbr(cc: string, full: string, abbr: string) {
    const fromFull = expandStreetVariants(cc, full)
    expect(fromFull, `${cc}: ${full} should contain ${abbr}`).toContain(abbr)
    expect(fromFull[0]).toBe(full.toLowerCase())
  }

  it('US: avenue <-> ave', () => bothWays('US', 'avenue', 'ave'))
  it('US: street -> st (abbr-to-canonical also present)', () => canonicalToAbbr('US', 'street', 'st'))
  it('US: boulevard <-> blvd', () => bothWays('US', 'boulevard', 'blvd'))
  it('CA: avenue <-> ave (English Canadian)', () => bothWays('CA', 'avenue', 'ave'))
  it('DE: strasse <-> str', () => bothWays('DE', 'strasse', 'str'))
  it('FR: boulevard <-> bd', () => bothWays('FR', 'boulevard', 'bd'))
  it('ES: avenida <-> av', () => bothWays('ES', 'avenida', 'av'))
  it('IT: viale <-> vle', () => bothWays('IT', 'viale', 'vle'))
  it('NL: straat <-> str', () => bothWays('NL', 'straat', 'str'))
  it('PT: rua -> r (r is ambiguous, canonical-direction only)', () => canonicalToAbbr('PT', 'rua', 'r'))
})

describe('expandStreetVariants: normalization', () => {
  it('DE: typing "straße" (ß) expands via normalized "strasse"', () => {
    const result = expandStreetVariants('DE', 'straße')
    // ß decomposes to ss on write, so the input normalizes to "strasse"
    expect(result).toContain('strasse')
    expect(result).toContain('str')
  })

  it('returns [input] only when not in dictionary', () => {
    const result = expandStreetVariants('US', 'nonexistenttoken12345')
    expect(result).toEqual(['nonexistenttoken12345'])
  })

  it('preserves the normalized input at index 0', () => {
    expect(expandStreetVariants('US', 'AVENUE')[0]).toBe('avenue')
    expect(expandStreetVariants('DE', 'STRAẞE')[0]).toBe('strasse')
  })

  it('returns empty array for empty token', () => {
    expect(expandStreetVariants('US', '')).toEqual([])
    expect(expandStreetVariants('US', '   ')).toEqual([])
  })
})

describe('expandStreetVariants: ambiguous guard', () => {
  it('tokens in ambiguous.json return only the input', () => {
    // "a" is in English ambiguous_expansions (overloaded across contexts),
    // so expansion is suppressed.
    const result = expandStreetVariants('US', 'a')
    expect(result).toEqual(['a'])
  })
})

describe('expandDirectional', () => {
  it('US: north -> n (canonical-to-abbr)', () => {
    const fromFull = expandDirectional('US', 'north')
    expect(fromFull).toContain('n')
  })

  it('US: south -> s (canonical-to-abbr)', () => {
    const fromFull = expandDirectional('US', 'south')
    expect(fromFull).toContain('s')
  })

  it('US: abbr-to-canonical is suppressed by ambiguous set', () => {
    // "n", "s", "e", "w" are in English ambiguous_expansions because they
    // mean too many things in a non-directional context. So expanding them
    // back to the full word is deliberately not done.
    expect(expandDirectional('US', 'n')).toEqual(['n'])
    expect(expandDirectional('US', 's')).toEqual(['s'])
  })

  it('US: northeast -> ne (abbr suppressed, "ne" matches Nebraska too)', () => {
    const fromFull = expandDirectional('US', 'northeast')
    expect(fromFull).toContain('ne')
    // "ne" alone is ambiguous, expanding it back would flood results.
    expect(expandDirectional('US', 'ne')).toEqual(['ne'])
  })
})

describe('expandStreetVariants: multi-language countries', () => {
  it('CA pulls from both en and fr', () => {
    // Avenue exists in both languages; the union should include both sides.
    const result = expandStreetVariants('CA', 'avenue')
    expect(result).toContain('ave')
  })

  it('CH hits de dictionary', () => {
    const result = expandStreetVariants('CH', 'strasse')
    expect(result).toContain('str')
  })

  it('BE hits nl dictionary', () => {
    const result = expandStreetVariants('BE', 'straat')
    expect(result).toContain('str')
  })
})

describe('getCountryLanguages', () => {
  it('US maps to en', () => {
    expect(getCountryLanguages('US')).toEqual(['en'])
  })

  it('CA maps to en + fr', () => {
    expect(getCountryLanguages('CA')).toEqual(['en', 'fr'])
  })

  it('JP maps to ja', () => {
    expect(getCountryLanguages('JP')).toEqual(['ja'])
  })

  it('unknown CC defaults to en', () => {
    expect(getCountryLanguages('ZZ')).toEqual(['en'])
  })

  it('throws on invalid CC', () => {
    expect(() => getCountryLanguages('usa')).toThrow()
    expect(() => getCountryLanguages('')).toThrow()
  })
})
