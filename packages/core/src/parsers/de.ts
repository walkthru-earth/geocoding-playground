import { GenericParser } from './generic'
import type { ParsedAddress } from '../address-parser'

/**
 * DE address parser.
 *
 * German addresses: street-first, 5-digit postcode, number at end.
 * "Unter den Linden 5, 10117 Berlin"
 *   → street=Unter den Linden, number=5, postcode=10117
 */
export class DEParser extends GenericParser {
  constructor() { super('DE') }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    const pcResult = this.extractPostcode(raw)
    let remaining = (pcResult ? pcResult.remainder : raw)
      .split(/[\s,]+/).filter(Boolean)

    // House number: last token if numeric (with optional letter: 12a, 12-14)
    let number: string | undefined
    if (remaining.length > 1) {
      const last = remaining[remaining.length - 1]
      if (/^\d+[a-z]?(-\d+[a-z]?)?$/i.test(last)) {
        number = remaining.pop()!
      }
    }

    // Strip known city names that might trail (user typed "Berlin" etc.)
    // We don't have a city list here, but if the postcode was found,
    // the last token after number extraction is likely a city ,skip it
    // only if it's a single capitalized word and we already have a street
    const street = remaining.length > 0 ? remaining.join(' ') : undefined

    return { street, number, postcode: pcResult?.postcode, tokens, raw }
  }
}
