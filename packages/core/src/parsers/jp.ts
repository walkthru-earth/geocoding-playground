import type { ParsedAddress } from '../address-parser'
import { esc } from '../address-parser'
import { GenericParser } from './generic'

/**
 * JP address parser.
 *
 * Japanese address hierarchy (largest → smallest):
 *   Prefecture (都道府県) > City (市区町村) > Town/District (町/大字)
 *   > Chome (丁目) > Banchi (番地, block/lot) > Go (号, building)
 *
 * In Overture Maps (sourced via MLIT ISJ → OpenAddresses):
 *   - `street` = town/district + chome (e.g., "三橋四丁目" or "本郷")
 *   - `number` = "banchi-coordZone" where the suffix is the MLIT planar
 *     rectangular coordinate system zone (1-19), NOT a real address part.
 *     Example: "362-9" means banchi=362, zone=9 (Kanto).
 *   - `postcode` = always NULL (Overture has 0% JP postcode coverage)
 *   - `go` (号, building number) = not present in data (ISJ is block-level)
 *
 * The dash-separated user input "1-2-3" means chome=1, banchi=2, go=3.
 * But since chome is baked into the street field and go isn't in the data,
 * we only need the banchi for matching. The coord zone suffix must be
 * ignored when comparing against stored numbers.
 *
 * Input examples:
 *   "本郷"       → street=本郷 (street-only search)
 *   "本郷 100"   → street=本郷, number=100 (banchi search)
 *   "本郷 1-2-3" → street=本郷, number=2 (chome=1, banchi=2, go=3)
 *   "本郷 1-2"   → street=本郷, number=2 (chome=1, banchi=2)
 *   "100-0001"   → postcode=100-0001 (even though Overture has no JP postcodes)
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

    // Look for a numeric token: plain "100" or dash-separated "1-2-3"
    let number: string | undefined
    const numIdx = remaining.findIndex((t) => /^\d+(?:[-−]\d+)*$/.test(t))
    if (numIdx !== -1) {
      number = extractBanchi(remaining.splice(numIdx, 1)[0])
    }

    const street = remaining.length > 0 ? remaining.join(' ') : undefined

    return { street, number, postcode: pcResult?.postcode, tokens, raw }
  }

  buildWhereClause(parsed: ParsedAddress): string {
    // JP has no postcode data in Overture, never use postcode in WHERE.
    // The number field in the data contains "banchi-coordZone" (e.g., "362-9").
    // We match the banchi portion using split_part to strip the zone suffix.
    const conditions: string[] = []
    if (parsed.street) {
      // street_lower is a physical column (v4.1+) enabling Parquet row-group pushdown.
      conditions.push(`street_lower LIKE '${esc(parsed.street.toLowerCase())}%'`)
    }
    if (parsed.number) {
      // Match banchi: split_part(number, '-', 1) extracts the real lot number
      // from Overture's "banchi-coordZone" format (e.g., "362-9" → "362")
      conditions.push(`split_part(number, '-', 1) = '${esc(parsed.number)}'`)
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

/**
 * Extract the banchi (block/lot number) from a JP dash-separated number token.
 *
 * Japanese dash-separated numbers follow the pattern: chome-banchi-go
 *   "100"   → banchi=100 (plain lot number, no chome)
 *   "1-2"   → chome=1, banchi=2
 *   "1-2-3" → chome=1, banchi=2, go=3
 *
 * Since Overture stores chome in the street field and go is not in the data,
 * we extract only the banchi for matching.
 *
 * For plain numbers (no dash), the value IS the banchi.
 * For 2-segment (N-N), the second segment is the banchi.
 * For 3-segment (N-N-N), the second segment is the banchi.
 */
function extractBanchi(token: string): string {
  const parts = token.split(/[-−]/)
  if (parts.length === 1) return parts[0] // plain number: "100" → banchi=100
  return parts[1] // "1-2" or "1-2-3" → banchi is parts[1]
}

/**
 * Strip the MLIT coordinate system zone suffix from a JP house number.
 *
 * Overture JP numbers are "banchi-coordZone" (e.g., "362-9").
 * The trailing suffix (1-19) is a survey grid zone, not an address part.
 * This function returns just the banchi: "362-9" → "362".
 *
 * Used by autocomplete to display clean numbers to users.
 * Safe to call on non-JP numbers (returns input unchanged if no dash).
 */
export function stripJPCoordZone(number: string): string {
  const dashIdx = number.lastIndexOf('-')
  if (dashIdx === -1) return number
  return number.slice(0, dashIdx)
}
