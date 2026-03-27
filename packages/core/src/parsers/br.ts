import { GenericParser } from './generic'
import type { ParsedAddress } from '../address-parser'

/**
 * BR address parser.
 *
 * Brazilian addresses: street-first in Overture data despite NUMBER_FIRST convention.
 * CEP format: XXXXX-XXX. Street types: Rua, Avenida, Travessa, etc.
 *
 * "Rua Augusta 1234, 01305-000 São Paulo"
 *   → street=Rua Augusta, number=1234, postcode=01305-000
 */
export class BRParser extends GenericParser {
  constructor() { super('BR') }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    const pcResult = this.extractPostcode(raw)
    let remaining = (pcResult ? pcResult.remainder : raw)
      .split(/[\s,]+/).filter(Boolean)

    // In Overture data, BR addresses are stored street-first: "Rua Augusta 1234"
    // Override NUMBER_FIRST: look for number at end
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
}
