import type { CountryParser, ParsedAddress } from '../address-parser'
import { POSTCODE_RE, NUMBER_FIRST, buildDefaultWhere } from '../address-parser'

/**
 * Generic parser — works for any country using shared constants.
 * Serves as the fallback and base for country-specific parsers.
 */
export class GenericParser implements CountryParser {
  constructor(protected cc: string) {}

  protected get postcodeRe(): RegExp | undefined {
    return POSTCODE_RE[this.cc]
  }

  protected get isNumberFirst(): boolean {
    return NUMBER_FIRST.has(this.cc)
  }

  extractPostcode(input: string): { postcode: string; remainder: string } | null {
    const re = this.postcodeRe
    if (!re) return null

    const tokens = input.trim().split(/\s+/)
    for (let i = 0; i < tokens.length; i++) {
      if (re.test(tokens[i])) {
        const postcode = tokens[i]
        const remainder = [...tokens.slice(0, i), ...tokens.slice(i + 1)].join(' ')
        return { postcode, remainder }
      }
      // Try joining with next token (e.g., NL "1016 AG", CA "K1A 0A0")
      if (i < tokens.length - 1) {
        const joined = tokens[i] + ' ' + tokens[i + 1]
        if (re.test(joined)) {
          const remainder = [...tokens.slice(0, i), ...tokens.slice(i + 2)].join(' ')
          return { postcode: joined, remainder }
        }
      }
    }
    return null
  }

  protected extractStreetNumber(input: string): { street?: string; number?: string; unit?: string } {
    const tokens = input.trim().split(/\s+/)
    if (tokens.length === 0) return {}

    if (this.isNumberFirst) {
      // Number-first: "185 Broadway" → number=185, street=Broadway
      const first = tokens[0]
      if (/^\d+[a-z]?$/i.test(first) && tokens.length > 1) {
        return { number: first, street: tokens.slice(1).join(' ') }
      }
    } else {
      // Street-first: "Keizersgracht 185" → street=Keizersgracht, number=185
      const last = tokens[tokens.length - 1]
      if (/^\d+[a-z]?$/i.test(last) && tokens.length > 1) {
        return { street: tokens.slice(0, -1).join(' '), number: last }
      }
    }

    // No number detected — treat as street name
    return { street: input.trim() }
  }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    // Step 1: Extract postcode from anywhere in input
    const pcResult = this.extractPostcode(raw)
    const remainder = pcResult ? pcResult.remainder : raw

    // Step 2: Extract street and number from remainder
    const sn = this.extractStreetNumber(remainder)

    return {
      street: sn.street,
      number: sn.number,
      unit: sn.unit,
      postcode: pcResult?.postcode,
      tokens,
      raw,
    }
  }

  buildWhereClause(parsed: ParsedAddress): string {
    return buildDefaultWhere(parsed)
  }
}
