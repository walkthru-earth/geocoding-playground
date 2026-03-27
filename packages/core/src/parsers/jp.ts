import type { ParsedAddress } from '../address-parser'
import { esc } from '../address-parser'
import { GenericParser } from './generic'

/**
 * JP address parser.
 *
 * Japanese addresses: kanji/hiragana street names, chome-banchi-go numbering.
 * Overture has 0% postcode coverage for JP ,skip postcode in WHERE.
 *
 * "本郷 1-2-3" → street=本郷, number=1-2-3
 * "本郷" → street=本郷
 */
export class JPParser extends GenericParser {
  constructor() {
    super('JP')
  }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    const pcResult = this.extractPostcode(raw)
    const remaining = (pcResult ? pcResult.remainder : raw).split(/[\s,]+/).filter(Boolean)

    // Chome-banchi-go: "1-2-3" or "１−２−３" patterns
    let number: string | undefined
    const numIdx = remaining.findIndex((t) => /^\d+[-−]\d+(-\d+)?$/.test(t))
    if (numIdx !== -1) {
      number = remaining.splice(numIdx, 1)[0]
    }

    const street = remaining.length > 0 ? remaining.join(' ') : undefined

    return { street, number, postcode: pcResult?.postcode, tokens, raw }
  }

  buildWhereClause(parsed: ParsedAddress): string {
    // JP has no postcode data in Overture ,never use postcode in WHERE
    const conditions: string[] = []
    if (parsed.street) {
      conditions.push(`lower(street) LIKE '${esc(parsed.street.toLowerCase())}%'`)
    }
    if (parsed.number) {
      conditions.push(`number = '${esc(parsed.number)}'`)
    }
    if (conditions.length > 0) return conditions.join(' AND ')

    return (
      parsed.tokens
        .filter((t) => t.length > 0)
        .map((t) => `full_address ILIKE '%${esc(t)}%'`)
        .join(' AND ') || '1=1'
    )
  }
}
