import { GenericParser } from './generic'
import type { ParsedAddress } from '../address-parser'

/**
 * ES address parser.
 *
 * Spanish addresses: street-first, 5-digit postcode.
 * Floor/door notation: "3o 2a" → unit.
 *
 * "Calle Gran Via 12, 3o 2a, 28013 Madrid"
 *   → street=Calle Gran Via, number=12, unit=3o 2a, postcode=28013
 */
export class ESParser extends GenericParser {
  constructor() { super('ES') }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    const pcResult = this.extractPostcode(raw)
    let remaining = (pcResult ? pcResult.remainder : raw)
      .split(/[\s,]+/).filter(Boolean)

    // Extract floor/door indicators: "3o", "2a", "1ero", "bajo"
    let unit: string | undefined
    const unitParts: string[] = []
    remaining = remaining.filter(t => {
      if (/^\d{1,2}[oa]$/i.test(t) || /^\d{1,2}(ero|era)$/i.test(t) || t.toLowerCase() === 'bajo') {
        unitParts.push(t)
        return false
      }
      return true
    })
    if (unitParts.length > 0) unit = unitParts.join(' ')

    // House number: last numeric token
    let number: string | undefined
    if (remaining.length > 1) {
      const last = remaining[remaining.length - 1]
      if (/^\d+[a-z]?$/i.test(last)) {
        number = remaining.pop()!
      }
    }

    const street = remaining.length > 0 ? remaining.join(' ') : undefined

    return { street, number, unit, postcode: pcResult?.postcode, tokens, raw }
  }
}
