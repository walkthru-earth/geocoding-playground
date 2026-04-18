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
  /**
   * Optional country code. When set, `buildDefaultWhere` uses libpostal
   * dictionaries to expand the street's trailing type token (and the leading
   * directional for NUMBER_FIRST countries) into OR'd `LIKE` prefixes.
   */
  cc?: string
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

import { expandDirectional, expandStreetVariants } from './dictionaries/index'
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
  'US',
  'CA',
  'AU',
  'NZ',
  'BR',
  'MX',
  'CL',
  'CO',
  'UY',
  'SG',
  'HK',
  'TW',
  'GB',
  'IE',
])

/**
 * Build a street prefix clause, expanding libpostal synonyms when possible.
 *
 * When `cc` is provided and the street ends in (or for NUMBER_FIRST countries
 * starts with) a known street-type or directional token, emit an OR of
 * `street_lower LIKE '<prefix>%'` entries covering every synonym. Falls back
 * to the original single-prefix behavior when no expansion applies.
 *
 * Every prefix is individually escaped with `esc()`.
 */
function buildStreetPrefixClause(street: string, cc?: string): string {
  const base = street.toLowerCase()
  const single = `street_lower LIKE '${esc(base)}%'`
  if (!cc) return single

  const tokens = base.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return single

  // Try trailing street-type expansion (covers both street-first and number-first
  // countries, because the type word sits at the end in either convention).
  const tail = tokens[tokens.length - 1]
  const tailVariants = expandStreetVariants(cc, tail)
  if (tailVariants.length > 1) {
    const head = tokens.slice(0, -1).join(' ')
    const prefixes = tailVariants.map((v) => (head ? `${head} ${v}` : v))
    return orPrefixes(prefixes)
  }

  // For NUMBER_FIRST countries, try leading directional expansion
  // ("n main st" -> "north main st"). For street-first countries the
  // directional usually isn't the first token, so skip.
  if (NUMBER_FIRST.has(cc) && tokens.length > 1) {
    const head = tokens[0]
    const dirVariants = expandDirectional(cc, head)
    if (dirVariants.length > 1) {
      const tailStr = tokens.slice(1).join(' ')
      const prefixes = dirVariants.map((v) => `${v} ${tailStr}`)
      return orPrefixes(prefixes)
    }
  }

  return single
}

function orPrefixes(prefixes: string[]): string {
  // Deduplicate while preserving order, individually escape each prefix.
  const seen = new Set<string>()
  const parts: string[] = []
  for (const p of prefixes) {
    if (seen.has(p)) continue
    seen.add(p)
    parts.push(`street_lower LIKE '${esc(p)}%'`)
  }
  if (parts.length === 1) return parts[0]
  return `(${parts.join(' OR ')})`
}

/** Default WHERE clause builder ,reusable by all parsers */
export function buildDefaultWhere(parsed: ParsedAddress): string {
  const conditions: string[] = []

  if (parsed.postcode) {
    conditions.push(`lower(postcode) = '${esc(parsed.postcode.toLowerCase())}'`)
  }
  if (parsed.street) {
    // street_lower is a physical column (v4.1+) enabling Parquet row-group pushdown.
    // lower(street) defeats pushdown because DuckDB can't apply functions to min/max stats.
    conditions.push(buildStreetPrefixClause(parsed.street, parsed.cc))
  }
  if (parsed.number) {
    conditions.push(`number = '${esc(parsed.number)}'`)
  }

  if (conditions.length > 0) return conditions.join(' AND ')

  // Fallback: ILIKE on full_address for each token
  return (
    parsed.tokens
      .filter((t) => t.length > 1)
      .map((t) => `full_address ILIKE '%${esc(t)}%'`)
      .join(' AND ') || '1=1'
  )
}

// ── Factory ──────────────────────────────────────────────────

import { GenericParser } from './parsers/generic'
import { PARSER_REGISTRY } from './parsers/index'

const parserCache = new Map<string, CountryParser>()

export function getParser(cc: string): CountryParser {
  if (parserCache.has(cc)) return parserCache.get(cc)!
  const parser = PARSER_REGISTRY[cc] ?? new GenericParser(cc)
  parserCache.set(cc, parser)
  return parser
}
