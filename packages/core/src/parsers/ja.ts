import type { ParsedAddress } from '../address-parser'
import { esc } from '../address-parser'
import { GenericParser } from './generic'

/**
 * Module augmentation: add `numberVariants` to `ParsedAddress`.
 *
 * JP addresses can include a kanji parcel prefix (`甲乙丙丁`) that the user may
 * or may not type while the stored value may or may not have it. Rather than
 * running two queries we emit an OR over the variants at WHERE build time.
 *
 * Declared here (not in `address-parser.ts`) so the JP parser owns its own
 * concern without forcing other parsers to know about it.
 */
declare module '../address-parser' {
  interface ParsedAddress {
    /** Alternative spellings of `number` to OR together at WHERE build time. */
    numberVariants?: string[]
  }
}

/**
 * JP address parser (file named after ISO 639 language code `ja`, registry key
 * stays `JP` / ISO 3166).
 *
 * Japanese address hierarchy (largest to smallest):
 *   Prefecture (都道府県) > City (市区町村) > Town/District (町/大字)
 *   > Chome (丁目) > Banchi (番地, block/lot) > Go (号, building)
 *
 * In Overture Maps (sourced via MLIT ISJ, OpenAddresses):
 *   - `street` = town/district + chome (e.g., "三橋四丁目" or "本郷")
 *   - `number` = "banchi-coordZone" where the suffix is the MLIT planar
 *     rectangular coordinate system zone (1-19), NOT a real address part.
 *     Example: "362-9" means banchi=362, zone=9 (Kanto).
 *   - `postcode` = always NULL (Overture has 0% JP postcode coverage)
 *   - `go` (号, building number) = not present in data (ISJ is block-level)
 *
 * Native Japanese addresses usually have NO whitespace. This parser tokenizes
 * on character class boundaries so input like `茨城県土浦市本郷1208` is handled
 * identically to `茨城県 土浦市 本郷 1208`.
 *
 * Input examples:
 *   "本郷"                  street=本郷
 *   "本郷 1208"             street=本郷, number=1208
 *   "土浦市本郷1208"        street=本郷, number=1208 (city prefix dropped)
 *   "茨城県土浦市本郷1208"  street=本郷, number=1208 (prefecture + city dropped)
 *   "本郷 1-2-3"            street=本郷, number=2 (chome=1, banchi=2, go=3)
 *   "並木1丁目 4233"        street=並木1丁目, numberVariants include kanji/arabic
 *   "乙24"                  number=24, numberVariants=['24','乙24']
 *   "100-0001"              postcode=100-0001
 */

const JP_TOKEN_RE = /([一-龯々ぁ-んァ-ヶーヵヶ]+)|([0-9０-９]+(?:[-−‐][0-9０-９]+)*)/g
const PREFECTURE_SUFFIX_RE = /[都道府県]$/
const CITY_SUFFIX_RE = /[市区町村]$/
/** First occurrence of a prefecture suffix char inside a kanji run. */
const PREFECTURE_SCAN_RE = /[都道府県]/
/** First occurrence of a city/ward/town/village suffix char inside a kanji run. */
const CITY_SCAN_RE = /[市区町村]/
const KANJI_PARCEL_PREFIX_RE = /^([甲乙丙丁])([0-9０-９]+)$/
const FULLWIDTH_DIGIT_RE = /[０-９]/g
const CHOME_SUFFIX_RE = /丁目$/
const TRAILING_CHOME_KANJI_RE = /([一二三四五六七八九十]+)(丁目)?$/
const TRAILING_CHOME_ARABIC_RE = /([0-9]+)(丁目)?$/
const SINGLE_KANJI_PARCEL_RE = /^[甲乙丙丁]$/
const HAS_CHOME_INPUT_RE = /[0-9一二三四五六七八九十]/

const KANJI_TO_ARABIC: Record<string, string> = {
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
  十: '10',
  十一: '11',
  十二: '12',
  十三: '13',
  十四: '14',
  十五: '15',
  十六: '16',
  十七: '17',
  十八: '18',
  十九: '19',
  二十: '20',
}

const ARABIC_TO_KANJI: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(KANJI_TO_ARABIC)) out[v] = k
  return out
})()

export class JPParser extends GenericParser {
  constructor() {
    super('JP')
  }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    const pcResult = this.extractPostcode(raw)
    const remainder = pcResult ? pcResult.remainder : raw

    const classed: Array<{ kind: 'kanji' | 'digits'; text: string }> = []
    for (const m of remainder.matchAll(JP_TOKEN_RE)) {
      if (m[1] !== undefined) classed.push({ kind: 'kanji', text: m[1] })
      else if (m[2] !== undefined) classed.push({ kind: 'digits', text: m[2] })
    }

    // Find the last digits token, that is the banchi candidate.
    let lastDigitsIdx = -1
    for (let i = classed.length - 1; i >= 0; i--) {
      if (classed[i].kind === 'digits') {
        lastDigitsIdx = i
        break
      }
    }

    let pref = false
    let city = false
    const streetParts: string[] = []
    const numberVariants: string[] = []
    let kanjiParcelDropped: string | undefined

    for (let i = 0; i < classed.length; i++) {
      if (i === lastDigitsIdx) continue // reserved as number
      const t = classed[i]
      if (t.kind === 'digits') {
        // An earlier digits token belongs to the street (e.g., chome digits).
        streetParts.push(toAsciiDigits(t.text))
        continue
      }
      // Kanji token. Japanese input often concatenates prefecture + city +
      // street into a single kanji run with no whitespace. Strip the FIRST
      // prefecture suffix (都道府県) and the FIRST city suffix (市区町村) from
      // within the run, then whatever remains is street.
      let text = t.text
      if (!pref) {
        const m = PREFECTURE_SCAN_RE.exec(text)
        if (m) {
          pref = true
          text = text.slice(m.index + 1)
          if (!text) continue
        } else if (PREFECTURE_SUFFIX_RE.test(text)) {
          // Whole token IS the prefecture (e.g., standalone "東京都").
          pref = true
          continue
        }
      }
      if (!city) {
        const m = CITY_SCAN_RE.exec(text)
        if (m) {
          city = true
          text = text.slice(m.index + 1)
          if (!text) continue
        } else if (CITY_SUFFIX_RE.test(text)) {
          city = true
          continue
        }
      }
      // If what remains is a bare kanji parcel label (甲乙丙丁) directly
      // followed by the banchi digits, drop it from the street and stash for
      // variant OR.
      if (SINGLE_KANJI_PARCEL_RE.test(text) && i === lastDigitsIdx - 1 && lastDigitsIdx !== -1) {
        kanjiParcelDropped = text
        continue
      }
      streetParts.push(text)
    }

    let number: string | undefined
    if (lastDigitsIdx !== -1) {
      const rawDigitsToken = classed[lastDigitsIdx].text
      const asciiDigits = toAsciiDigits(rawDigitsToken)
      number = extractBanchi(asciiDigits)
      const kp = KANJI_PARCEL_PREFIX_RE.exec(rawDigitsToken)
      if (kp) {
        const digits = toAsciiDigits(kp[2])
        number = digits
        numberVariants.push(digits, `${kp[1]}${digits}`)
      } else if (kanjiParcelDropped) {
        numberVariants.push(number, `${kanjiParcelDropped}${number}`)
      }
    }

    const street = streetParts.length > 0 ? streetParts.join('') : undefined

    const out: ParsedAddress = { tokens, raw }
    if (street) out.street = street
    if (number) out.number = number
    if (numberVariants.length > 0) out.numberVariants = numberVariants
    if (pcResult?.postcode) out.postcode = pcResult.postcode
    return out
  }

  buildWhereClause(parsed: ParsedAddress): string {
    const conditions: string[] = []

    if (parsed.street) {
      const variants = canonicalizeChome(parsed.street)
      if (variants.length === 1) {
        conditions.push(`street_lower LIKE '${esc(variants[0].toLowerCase())}%'`)
      } else {
        const ors = variants.map((v) => `street_lower LIKE '${esc(v.toLowerCase())}%'`)
        conditions.push(`(${ors.join(' OR ')})`)
      }
    }

    if (parsed.number || (parsed.numberVariants && parsed.numberVariants.length > 0)) {
      const nums =
        parsed.numberVariants && parsed.numberVariants.length > 0 ? parsed.numberVariants : [parsed.number as string]
      if (nums.length === 1) {
        conditions.push(`split_part(number, '-', 1) = '${esc(nums[0])}'`)
      } else {
        const ors = nums.map((n) => `split_part(number, '-', 1) = '${esc(n)}'`)
        conditions.push(`(${ors.join(' OR ')})`)
      }
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

function toAsciiDigits(s: string): string {
  return s.replace(FULLWIDTH_DIGIT_RE, (ch) => String(ch.charCodeAt(0) - 0xff10))
}

/**
 * Extract the banchi (block/lot number) from a JP dash-separated number token.
 *
 * Japanese dash-separated numbers follow the pattern: chome-banchi-go
 *   "100"   banchi=100 (plain lot number, no chome)
 *   "1-2"   chome=1, banchi=2
 *   "1-2-3" chome=1, banchi=2, go=3
 */
function extractBanchi(token: string): string {
  const parts = token.split(/[-−‐]/)
  if (parts.length === 1) return parts[0]
  return parts[1]
}

/**
 * Return the set of street spellings that should match a user-entered street.
 *
 * Patterns handled (last trailing chome only):
 *   `並木一丁目` to `['並木一丁目', '並木1丁目']`
 *   `並木1丁目`  to `['並木1丁目', '並木一丁目']`
 *   `並木1`     to `['並木1', '並木一', '並木一丁目', '並木1丁目']`
 *   `並木`       to `['並木']`
 */
export function canonicalizeChome(street: string): string[] {
  if (!HAS_CHOME_INPUT_RE.test(street) && !CHOME_SUFFIX_RE.test(street)) {
    return [street]
  }

  const kanjiMatch = TRAILING_CHOME_KANJI_RE.exec(street)
  if (kanjiMatch && kanjiMatch[1].length > 0) {
    const kanjiDigit = kanjiMatch[1]
    const hasChome = kanjiMatch[2] === '丁目'
    const arabic = KANJI_TO_ARABIC[kanjiDigit]
    if (arabic) {
      const prefix = street.slice(0, kanjiMatch.index)
      if (hasChome) {
        return dedupe([`${prefix}${kanjiDigit}丁目`, `${prefix}${arabic}丁目`])
      }
      return dedupe([
        `${prefix}${kanjiDigit}`,
        `${prefix}${arabic}`,
        `${prefix}${kanjiDigit}丁目`,
        `${prefix}${arabic}丁目`,
      ])
    }
  }

  const arabicMatch = TRAILING_CHOME_ARABIC_RE.exec(street)
  if (arabicMatch && arabicMatch[1].length > 0) {
    const arabicDigit = arabicMatch[1]
    const hasChome = arabicMatch[2] === '丁目'
    const kanjiDigit = ARABIC_TO_KANJI[arabicDigit]
    const prefix = street.slice(0, arabicMatch.index)
    if (hasChome) {
      if (kanjiDigit) {
        return dedupe([`${prefix}${arabicDigit}丁目`, `${prefix}${kanjiDigit}丁目`])
      }
      return [street]
    }
    if (kanjiDigit) {
      return dedupe([
        `${prefix}${arabicDigit}`,
        `${prefix}${kanjiDigit}`,
        `${prefix}${arabicDigit}丁目`,
        `${prefix}${kanjiDigit}丁目`,
      ])
    }
    return [street]
  }

  return [street]
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

/**
 * Strip the MLIT coordinate system zone suffix from a JP house number.
 *
 * Overture JP numbers are "banchi-coordZone" (e.g., "362-9").
 * The trailing suffix (1-19) is a survey grid zone, not an address part.
 * Returns just the banchi: "362-9" to "362".
 *
 * Safe to call on non-JP numbers (returns input unchanged if no dash).
 */
export function stripJPCoordZone(number: string): string {
  const dashIdx = number.lastIndexOf('-')
  if (dashIdx === -1) return number
  return number.slice(0, dashIdx)
}
