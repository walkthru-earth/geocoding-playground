import type { ParsedAddress } from '../address-parser'
import { buildDefaultWhere } from '../address-parser'
import { GenericParser } from './generic'

/**
 * IT address parser.
 *
 * Italian addresses: street-first, 5-digit postcode (but 0% in Overture data).
 * Street types: Via, Viale, Corso, Piazza, etc.
 *
 * "Via del Corso 12, 00186 Roma"
 *   → street=Via del Corso, number=12, postcode=00186
 */
export class ITParser extends GenericParser {
  constructor() {
    super('IT')
  }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    const pcResult = this.extractPostcode(raw)
    const remaining = (pcResult ? pcResult.remainder : raw).split(/[\s,]+/).filter(Boolean)

    // Street-first, number at end
    let number: string | undefined
    if (remaining.length > 1) {
      const last = remaining[remaining.length - 1]
      if (/^\d+[a-z]?$/i.test(last)) {
        number = remaining.pop()!
      }
    }

    const street = remaining.length > 0 ? remaining.join(' ') : undefined

    return { street, number, postcode: pcResult?.postcode, tokens, raw }
  }

  buildWhereClause(parsed: ParsedAddress): string {
    // IT has no postcode data in Overture, skip postcode in WHERE.
    // Delegate the rest to buildDefaultWhere so libpostal street-type
    // expansion still fires (e.g. `via` ↔ `v.`).
    return buildDefaultWhere({ ...parsed, cc: parsed.cc ?? this.cc, postcode: undefined })
  }
}
