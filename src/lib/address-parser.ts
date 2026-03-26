/**
 * Modular country-based address parser.
 *
 * Each country has specific conventions for address formatting:
 * - Number placement (before or after street)
 * - Postcode format and position
 * - Unit/apartment notation
 * - Noise tokens (state codes, neighborhood names)
 *
 * The parser extracts structured fields from free-text input,
 * enabling precise SQL queries (prefix LIKE + exact match)
 * instead of slow ILIKE on full_address.
 */

// ── Types ────────────────────────────────────────────────────

export interface ParsedAddress {
  street?: string
  number?: string
  unit?: string
  postcode?: string
  city?: string
  tokens: string[]
  raw: string
}

export interface CountryParser {
  /** Main entry: parse free-text input into structured fields */
  parseAddress(input: string): ParsedAddress

  /** Scan for postcode anywhere in string, return it + remaining text */
  extractPostcode(input: string): { postcode: string; remainder: string } | null

  /** Build SQL WHERE clause from parsed address */
  buildWhereClause(parsed: ParsedAddress): string
}

// ── Shared utilities ─────────────────────────────────────────

export { esc } from './utils'
import { esc } from './utils'

/** Postcode regex patterns per country */
export const POSTCODE_RE: Record<string, RegExp> = {
  US: /^\d{5}(-\d{4})?$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  ES: /^\d{5}$/,
  IT: /^\d{5}$/,
  MX: /^\d{5}$/,
  NL: /^\d{4}[a-z]{0,2}$/i,
  CA: /^[a-z]\d[a-z]\s?\d[a-z]\d$/i,
  BR: /^\d{5}-?\d{3}$/,
  AU: /^\d{4}$/,
  AT: /^\d{4}$/,
  BE: /^\d{4}$/,
  PL: /^\d{2}-?\d{3}$/,
  JP: /^\d{3}-?\d{4}$/,
  CH: /^\d{4}$/,
  DK: /^\d{4}$/,
  FI: /^\d{5}$/,
  NO: /^\d{4}$/,
  PT: /^\d{4}(-\d{3})?$/,
  SE: /^\d{3}\s?\d{2}$/,
}

/** Countries where house number comes before street name */
export const NUMBER_FIRST = new Set([
  'US', 'CA', 'AU', 'NZ', 'BR', 'MX', 'CL', 'CO', 'UY', 'SG', 'HK', 'TW', 'GB', 'IE',
])

/** Default WHERE clause builder — reusable by all parsers */
export function buildDefaultWhere(parsed: ParsedAddress): string {
  const conditions: string[] = []

  if (parsed.postcode) {
    conditions.push(`lower(postcode) = '${esc(parsed.postcode.toLowerCase())}'`)
  }
  if (parsed.street) {
    conditions.push(`lower(street) LIKE '${esc(parsed.street.toLowerCase())}%'`)
  }
  if (parsed.number) {
    conditions.push(`number = '${esc(parsed.number)}'`)
  }

  if (conditions.length > 0) return conditions.join(' AND ')

  // Fallback: ILIKE on full_address for each token
  return parsed.tokens
    .filter(t => t.length > 1)
    .map(t => `full_address ILIKE '%${esc(t)}%'`)
    .join(' AND ') || '1=1'
}

// ── Factory ──────────────────────────────────────────────────

import { PARSER_REGISTRY } from './parsers/index'
import { GenericParser } from './parsers/generic'

const parserCache = new Map<string, CountryParser>()

export function getParser(cc: string): CountryParser {
  if (parserCache.has(cc)) return parserCache.get(cc)!
  const parser = PARSER_REGISTRY[cc] ?? new GenericParser(cc)
  parserCache.set(cc, parser)
  return parser
}
