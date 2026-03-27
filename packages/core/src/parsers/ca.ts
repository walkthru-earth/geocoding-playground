import type { ParsedAddress } from '../address-parser'
import { GenericParser } from './generic'

const CA_PROVINCE_CODES = new Set(['ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'NT', 'YT', 'NU'])

/**
 * CA address parser.
 *
 * Canadian addresses: number-first, 6-char postal code (A1A 1A1).
 *
 * "123 King Street Toronto ON M5V 1A1"
 *   → number=123, street=King Street, postcode=M5V 1A1
 */
export class CAParser extends GenericParser {
  constructor() {
    super('CA')
  }

  extractPostcode(input: string): { postcode: string; remainder: string } | null {
    // Canadian postal codes: A1A 1A1 or A1A1A1
    const match = input.match(/\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)\b/i)
    if (match) {
      const postcode = `${match[1]} ${match[2]}`
      const remainder = input.slice(0, match.index) + input.slice(match.index! + match[0].length)
      return { postcode, remainder: remainder.replace(/\s+/g, ' ').trim() }
    }
    // FSA only (first 3 chars)
    const fsa = input.match(/\b([A-Z]\d[A-Z])\b/i)
    if (fsa) {
      const postcode = fsa[1]
      const remainder = input.slice(0, fsa.index) + input.slice(fsa.index! + fsa[0].length)
      return { postcode, remainder: remainder.replace(/\s+/g, ' ').trim() }
    }
    return null
  }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    const pcResult = this.extractPostcode(raw)
    let remaining = (pcResult ? pcResult.remainder : raw).split(/[\s,]+/).filter(Boolean)

    // Strip province codes
    remaining = remaining.filter((t) => !CA_PROVINCE_CODES.has(t.toUpperCase()))

    // Number-first
    let number: string | undefined
    if (remaining.length > 1 && /^\d+[a-z]?$/i.test(remaining[0])) {
      number = remaining.shift()!
    }

    const street = remaining.length > 0 ? remaining.join(' ') : undefined

    return { street, number, postcode: pcResult?.postcode, tokens, raw }
  }
}
