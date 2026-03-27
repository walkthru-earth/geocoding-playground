import { GenericParser } from './generic'
import type { ParsedAddress } from '../address-parser'
import { esc } from '../address-parser'

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
  constructor() { super('IT') }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    const pcResult = this.extractPostcode(raw)
    let remaining = (pcResult ? pcResult.remainder : raw)
      .split(/[\s,]+/).filter(Boolean)

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
    // IT has no postcode data in Overture ,skip postcode in WHERE
    const conditions: string[] = []
    if (parsed.street) {
      conditions.push(`lower(street) LIKE '${esc(parsed.street.toLowerCase())}%'`)
    }
    if (parsed.number) {
      conditions.push(`number = '${esc(parsed.number)}'`)
    }
    if (conditions.length > 0) return conditions.join(' AND ')

    return parsed.tokens
      .filter(t => t.length > 0)
      .map(t => `full_address ILIKE '%${esc(t)}%'`)
      .join(' AND ') || '1=1'
  }
}
