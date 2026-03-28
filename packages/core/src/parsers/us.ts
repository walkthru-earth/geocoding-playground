import type { ParsedAddress } from '../address-parser'
import { GenericParser } from './generic'

const US_STATE_CODES = new Set([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'DC',
  'PR',
  'VI',
  'GU',
  'AS',
  'MP',
])

const UNIT_INDICATORS = new Set(['APT', 'UNIT', 'STE', 'SUITE', 'FL', 'FLOOR', 'RM', 'ROOM', 'BLDG', 'LOT'])

const STREET_SUFFIXES = new Set([
  'ST',
  'STREET',
  'AVE',
  'AVENUE',
  'BLVD',
  'BOULEVARD',
  'DR',
  'DRIVE',
  'RD',
  'ROAD',
  'LN',
  'LANE',
  'CT',
  'COURT',
  'PL',
  'PLACE',
  'WAY',
  'CIR',
  'CIRCLE',
  'TER',
  'TERRACE',
  'PKWY',
  'PARKWAY',
  'HWY',
  'HIGHWAY',
  'SQ',
  'SQUARE',
  'TRL',
  'TRAIL',
  'LOOP',
  'PATH',
  'PIKE',
  'ALY',
  'ALLEY',
])

/**
 * US address parser.
 *
 * US addresses: number-first, 5-digit ZIP, unit indicators (APT/UNIT/STE),
 * state codes as noise, neighborhoods/boroughs not in Overture city data.
 *
 * "1871 MENAHAN ST APT 2R RIDGEWOOD QUEENS NY 11385"
 *   → postcode=11385, number=1871, street=MENAHAN ST, unit=APT 2R
 */
export class USParser extends GenericParser {
  constructor() {
    super('US')
  }

  parseAddress(input: string): ParsedAddress {
    const raw = input.trim()
    const tokens = raw.split(/\s+/)
    if (!raw) return { tokens: [], raw }

    // Step 1: Extract ZIP code from anywhere
    const pcResult = this.extractPostcode(raw)
    const remaining = (pcResult ? pcResult.remainder : raw).split(/[\s,]+/).filter(Boolean)

    // Step 2: Extract house number (first token if numeric)
    let number: string | undefined
    if (remaining.length > 0 && /^\d+[a-z]?$/i.test(remaining[0])) {
      number = remaining.shift()!
    }

    // Step 3: Extract unit (APT 2R, UNIT 5, STE 100, #3)
    let unit: string | undefined
    const unitIdx = remaining.findIndex((t) => UNIT_INDICATORS.has(t.toUpperCase()) || t === '#')
    if (unitIdx !== -1) {
      // Unit indicator + everything after it until next known section
      const unitParts = [remaining[unitIdx]]
      if (unitIdx + 1 < remaining.length && /^[a-z0-9-]+$/i.test(remaining[unitIdx + 1])) {
        unitParts.push(remaining[unitIdx + 1])
        remaining.splice(unitIdx, 2)
      } else {
        remaining.splice(unitIdx, 1)
      }
      unit = unitParts.join(' ')
    }

    // Step 4: Strip state codes and common noise from right side
    // Work right-to-left: strip state codes, then potential city/neighborhood names
    while (remaining.length > 0 && US_STATE_CODES.has(remaining[remaining.length - 1].toUpperCase())) {
      remaining.pop()
    }

    // Step 5: Try to identify street vs city/neighborhood noise
    // Find the last street suffix ,everything up to and including it is the street name
    let streetEnd = -1
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (STREET_SUFFIXES.has(remaining[i].toUpperCase())) {
        streetEnd = i
        break
      }
    }

    let street: string | undefined
    if (streetEnd >= 0) {
      // Street name includes everything up to the suffix
      street = remaining.slice(0, streetEnd + 1).join(' ')
    } else if (remaining.length > 0) {
      // No suffix found ,use all remaining as street (best guess)
      street = remaining.join(' ')
    }

    return {
      street,
      number,
      unit,
      postcode: pcResult?.postcode,
      tokens,
      raw,
    }
  }
}
