import { GenericParser } from './generic'
import type { ParsedAddress } from '../address-parser'

const AU_STATE_CODES = new Set(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'])

/**
 * AU address parser.
 *
 * Australian addresses: number-first, 4-digit postcode.
 * Unit notation: "3/45 George Street" → unit=3, number=45.
 *
 * "3/45 George Street SYDNEY NSW 2000"
 *   → unit=3, number=45, street=George Street, postcode=2000
 */
export class AUParser extends GenericParser {
  constructor() { super('AU') }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    const pcResult = this.extractPostcode(raw)
    let remaining = (pcResult ? pcResult.remainder : raw)
      .split(/[\s,]+/).filter(Boolean)

    // Strip state codes
    remaining = remaining.filter(t => !AU_STATE_CODES.has(t.toUpperCase()))

    // Unit/number: "3/45" format in first token
    let number: string | undefined
    let unit: string | undefined
    if (remaining.length > 0 && remaining[0].includes('/')) {
      const parts = remaining[0].split('/')
      if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+[a-z]?$/i.test(parts[1])) {
        unit = parts[0]
        number = parts[1]
        remaining.shift()
      }
    }

    // If no unit/number from slash notation, try plain number-first
    if (!number && remaining.length > 1 && /^\d+[a-z]?$/i.test(remaining[0])) {
      number = remaining.shift()!
    }

    const street = remaining.length > 0 ? remaining.join(' ') : undefined

    return { street, number, unit, postcode: pcResult?.postcode, tokens, raw }
  }
}
