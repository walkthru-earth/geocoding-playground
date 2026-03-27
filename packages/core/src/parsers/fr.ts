import type { ParsedAddress } from '../address-parser'
import { GenericParser } from './generic'

/**
 * FR address parser.
 *
 * French addresses: number before street type, 5-digit postcode.
 * "12 Rue de Rivoli, 75001 Paris 1er Arrondissement"
 *   → number=12, street=Rue de Rivoli, postcode=75001
 */
export class FRParser extends GenericParser {
  constructor() {
    super('FR')
  }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    const pcResult = this.extractPostcode(raw)
    let remaining = (pcResult ? pcResult.remainder : raw).split(/[\s,]+/).filter(Boolean)

    // House number: first token if numeric
    let number: string | undefined
    if (remaining.length > 1 && /^\d+[a-z]?$/i.test(remaining[0])) {
      number = remaining.shift()!
    }

    // Strip arrondissement info: "Paris 8e Arrondissement" or "8e" or "1er"
    remaining = remaining.filter((t) => !/^\d{1,2}e(r)?$/i.test(t) && t.toLowerCase() !== 'arrondissement')

    const street = remaining.length > 0 ? remaining.join(' ') : undefined

    return { street, number, postcode: pcResult?.postcode, tokens, raw }
  }
}
