import { GenericParser } from './generic'
import type { ParsedAddress } from '../address-parser'

/**
 * NL address parser.
 *
 * Dutch addresses: street-first, 4-digit+letters postcode, "bis"/"hs" as unit.
 * "2e Nassaustraat" — ordinal prefix is part of street name, not a number.
 *
 * "Keizersgracht 185 bis 1016AG Amsterdam"
 *   → street=Keizersgracht, number=185, unit=bis, postcode=1016AG
 */
export class NLParser extends GenericParser {
  constructor() { super('NL') }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    // Step 1: Extract postcode (1016AG or 1016 AG)
    const pcResult = this.extractPostcode(raw)
    let remaining = (pcResult ? pcResult.remainder : raw).split(/[\s,]+/).filter(Boolean)

    // Step 2: Remove city name if it's the last word and not numeric
    // (cities are handled by the city selector, not needed in tile query)

    // Step 3: Find house number — last numeric token (not ordinals like "2e")
    let number: string | undefined
    let unit: string | undefined
    const NL_UNITS = new Set(['bis', 'hs', 'huis', 'boven', 'beneden', 'i', 'ii', 'iii', 'iv'])

    for (let i = remaining.length - 1; i >= 0; i--) {
      const t = remaining[i]
      // Check for unit suffixes first
      if (NL_UNITS.has(t.toLowerCase())) {
        unit = t
        remaining.splice(i, 1)
        continue
      }
      // House number: digits optionally followed by a letter (185, 185a)
      // But NOT ordinals like "2e" or "1ste" which are part of street names
      if (/^\d+[a-z]?$/i.test(t) && !/^\d+e$/i.test(t) && !/^\d+ste$/i.test(t)) {
        number = t
        remaining.splice(i, 1)
        break
      }
    }

    const street = remaining.length > 0 ? remaining.join(' ') : undefined

    return { street, number, unit, postcode: pcResult?.postcode, tokens, raw }
  }
}
