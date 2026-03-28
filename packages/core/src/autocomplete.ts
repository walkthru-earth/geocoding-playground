/**
 * Smart Autocomplete Engine
 *
 * Framework-agnostic autocomplete that uses the address parser to classify
 * tokens progressively as the user types. Works in any order:
 * postcode first, number first, street first, or mixed.
 *
 * All heavy logic (token classification, suggestion merging, tile resolution,
 * ranking) lives here. The UI layer only needs to call `suggest()` and
 * `resolveTiles()`.
 */

import type { ParsedAddress } from './address-parser'
import { getParser, NUMBER_FIRST } from './address-parser'
import { dataPath, tilePath } from './duckdb'
import { jaccardSimilarity, type SearchCache } from './search'
import type { CityRow, SuggestRow } from './types'
import { esc, toArr, validateCC } from './utils'

// ── Types ────────────────────────────────────────────────────

/** What the parser detected from the current input */
export interface InputClassification {
  /** Raw input */
  raw: string
  /** Country code */
  cc: string
  /** Full parsed result */
  parsed: ParsedAddress
  /** The part of input to use for street autocomplete (number stripped) */
  streetQuery: string
  /** Whether the input (or part of it) looks like a postcode */
  hasPostcode: boolean
  /** Whether a house number was detected */
  hasNumber: boolean
  /** Which mode the autocomplete should operate in */
  mode: 'street' | 'postcode' | 'mixed' | 'ready'
}

/** Query functions the autocomplete engine delegates to (injected by caller) */
export interface AutocompleteQueryFns {
  queryPostcodes(cc: string, query: string, cityTiles: string[]): Promise<SuggestRow[]>
  queryStreets(cc: string, query: string, cityTiles: string[]): Promise<SuggestRow[]>
  /**
   * Query number_index for address-level suggestions (street + number prefix).
   * Uses HTTP range requests with row-group pushdown on the number_index file,
   * fetching only ~150 KB per query instead of full tiles (0.5-15 MB).
   * Falls back to cached tile data if the number_index query fails.
   */
  queryAddresses(cc: string, street: string, numberPrefix: string, tiles: string[]): Promise<SuggestRow[]>
}

/** Options for tile resolution */
export interface TileResolutionResult {
  tiles: string[]
  source: string
}

/** Minimum street length to transition from street mode to ready mode.
 * CJK characters (kanji/kana) carry much more information per character
 * than Latin letters, so we count them double. "本郷" (2 chars) scores 4,
 * meeting the threshold, while "rue" (3 chars) scores 3 and stays in street mode. */
const MIN_STREET_LEN_FOR_READY = 4

// U+3000–U+9FFF covers CJK Unified Ideographs, Hiragana, Katakana, and CJK symbols
const CJK_RE = /[\u3000-\u9fff]/g

function streetSpecificity(street: string): number {
  const cjkCount = (street.match(CJK_RE) || []).length
  return street.length + cjkCount // CJK chars counted double
}

// ── Input Classification ─────────────────────────────────────

/**
 * Classify the current input using the country parser.
 * Determines what the user is typing and what autocomplete mode to use.
 */
export function classifyInput(input: string, cc: string): InputClassification {
  validateCC(cc)
  const raw = input.trim()
  if (!raw) {
    return {
      raw,
      cc,
      parsed: { tokens: [], raw },
      streetQuery: '',
      hasPostcode: false,
      hasNumber: false,
      mode: 'ready',
    }
  }

  const parser = getParser(cc)
  const parsed = parser.parseAddress(raw)

  const hasPostcode = !!parsed.postcode
  const hasNumber = !!parsed.number

  // Prefer parsed.street when parser found both street and number
  // (handles FR-style number-first without needing NUMBER_FIRST)
  const streetQuery = parsed.street && parsed.number ? parsed.street : extractStreetQuery(raw, cc)

  // Determine mode
  const mode = determineMode(raw, cc, parsed, streetQuery)

  return { raw, cc, parsed, streetQuery, hasPostcode, hasNumber, mode }
}

/**
 * Determine autocomplete mode based on what the user has typed so far.
 *
 * - 'postcode': input matches postcode pattern, show postcode suggestions
 * - 'street': input is text, show street suggestions
 * - 'mixed': ambiguous (e.g., short number that could be postcode or house number)
 * - 'ready': enough info to search directly (street + number both present)
 */
function determineMode(
  raw: string,
  cc: string,
  parsed: ParsedAddress,
  streetQuery: string,
): InputClassification['mode'] {
  const tokens = raw.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return 'ready'

  // Street + number present, but only "ready" if street is specific enough.
  // Short prefixes like "rue" (3 chars) stay in street mode for instant suggestions.
  // CJK characters count double since 2 kanji = a fully specific JP street name.
  if (parsed.street && parsed.number && streetSpecificity(parsed.street) >= MIN_STREET_LEN_FOR_READY) return 'ready'

  // If parser found a full postcode, prioritize postcode mode
  if (parsed.postcode) return 'postcode'

  // Check if the entire input looks like a partial postcode
  if (looksLikePartialPostcode(raw, cc)) {
    // But if there's also text, it's mixed
    if (streetQuery.length >= 2 && streetQuery !== raw) return 'mixed'
    return 'postcode'
  }

  // Check if input starts with just a number (ambiguous in number-first countries)
  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) {
    // Single number: could be postcode prefix OR house number
    // In number-first countries (US, CA, AU), a lone number is likely a house number
    // but we should still check postcodes
    if (NUMBER_FIRST.has(cc)) return 'mixed'
    // In street-first countries, a lone number is more likely a postcode
    return looksLikePartialPostcode(tokens[0], cc) ? 'postcode' : 'mixed'
  }

  // Default: street mode
  return 'street'
}

/**
 * Check if input looks like a partial postcode (prefix of a valid postcode).
 * More lenient than the full POSTCODE_RE. Used for early postcode detection.
 */
function looksLikePartialPostcode(input: string, cc: string): boolean {
  const s = input.trim()
  if (!s) return false

  const re = PARTIAL_POSTCODE_RE[cc]
  if (!re) return /^\d+$/.test(s)
  return re.test(s)
}

/** Partial postcode patterns per country (hoisted to avoid per-call allocation) */
const PARTIAL_POSTCODE_RE: Record<string, RegExp> = {
  US: /^\d{1,5}$/,
  DE: /^\d{1,5}$/,
  FR: /^\d{1,5}$/,
  ES: /^\d{1,5}$/,
  IT: /^\d{1,5}$/,
  NL: /^\d{1,4}[a-z]{0,2}$/i,
  CA: /^[a-z]\d[a-z]?(\s?\d[a-z]\d)?$/i,
  BR: /^\d{1,5}(-?\d{0,3})?$/,
  AU: /^\d{1,4}$/,
  JP: /^\d{1,3}(-?\d{0,4})?$/,
  CH: /^\d{1,4}$/,
  AT: /^\d{1,4}$/,
  BE: /^\d{1,4}$/,
  DK: /^\d{1,4}$/,
  NO: /^\d{1,4}$/,
  FI: /^\d{1,5}$/,
  PT: /^\d{1,4}(-?\d{0,3})?$/,
  PL: /^\d{1,2}(-?\d{0,3})?$/,
}

// ── Street Query Extraction ──────────────────────────────────

/**
 * Strip leading/trailing house number from query to get the street
 * part for autocomplete.
 *
 * Leading number is always stripped: users in any country may type
 * "12 rue de rivoli" or "5 hauptstraße". Trailing number is stripped
 * for street-first countries ("keizersgracht 185").
 */
export function extractStreetQuery(input: string, cc: string): string {
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  if (tokens.length <= 1) return input.trim()

  // Always strip leading number (user may type house number first in any country)
  if (/^\d+[a-z]?$/i.test(tokens[0])) {
    return tokens.slice(1).join(' ')
  }

  // Strip trailing number for street-first countries
  if (!NUMBER_FIRST.has(cc)) {
    const last = tokens[tokens.length - 1]
    if (/^\d+[a-z]?$/i.test(last)) {
      return tokens.slice(0, -1).join(' ')
    }
  }
  return input.trim()
}

// ── Suggestion Scoring & Ranking ─────────────────────────────

/**
 * Score how well a suggestion label matches the query.
 * Rewards exact match, then word-boundary containment, then prefix closeness.
 */
export function suggestionScore(label: string, query: string): number {
  const l = label.toLowerCase()
  const q = query.toLowerCase()
  if (l === q) return 100 // exact match
  // Query appears as a whole word (bounded by space or start/end)
  const wordRe = new RegExp(`(?:^|\\s)${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`)
  if (wordRe.test(l)) return 80 // "via cave di peperino" matches "via cave"
  if (l.startsWith(q)) return 60 + 1 / l.length // prefix match, shorter = better
  if (l.includes(q)) return 40 // substring match
  return jaccardSimilarity(q, l) * 30 // fallback to bigram similarity
}

/**
 * Rank suggestions: boost matches for selected city, then by relevance.
 * Uses both primary_city name AND tile overlap so streets like "via delle cave"
 * that exist in Roma but have primary_city "Vecchiano" still get boosted.
 */
export function rankSuggestions(
  items: SuggestRow[],
  query: string,
  cityName: string | null,
  cityTiles: Set<string> | null,
): SuggestRow[] {
  if (items.length <= 1) return items
  const lowerCity = cityName?.toLowerCase() ?? ''

  // Partition: city matches first (by name or tile overlap), then the rest
  const inCity: SuggestRow[] = []
  const other: SuggestRow[] = []
  for (const s of items) {
    const nameMatch = lowerCity && s.primary_city && s.primary_city.toLowerCase() === lowerCity
    const tileMatch = cityTiles && s.tiles && toArr(s.tiles).some((t: string) => cityTiles.has(t))
    if (nameMatch || tileMatch) {
      inCity.push(s)
    } else {
      other.push(s)
    }
  }

  // Sort each group by relevance score
  const byScore = (a: SuggestRow, b: SuggestRow) => suggestionScore(b.label, query) - suggestionScore(a.label, query)
  inCity.sort(byScore)
  other.sort(byScore)
  return lowerCity ? [...inCity, ...other] : [...inCity, ...other].sort(byScore)
}

// ── Smart Suggest ────────────────────────────────────────────

/**
 * Main autocomplete function. Classifies input, queries the appropriate
 * indexes, and returns ranked suggestions. Framework-agnostic.
 *
 * The caller provides query functions that execute SQL (via DuckDB-WASM
 * or any other backend).
 */
export async function suggest(
  input: string,
  cc: string,
  cityName: string | null,
  cityTiles: Set<string> | null,
  queryFns: AutocompleteQueryFns,
  cache: SearchCache<SuggestRow[]>,
): Promise<{ classification: InputClassification; suggestions: SuggestRow[] }> {
  const classification = classifyInput(input, cc)
  const { mode, streetQuery, parsed } = classification

  if (input.trim().length < 2) {
    return { classification, suggestions: [] }
  }

  // When mode is 'ready' (street + number both detected):
  // 1. Try address-level suggestions from CACHED tiles only (instant, no network)
  // 2. Fall back to street suggestion if no tiles are cached yet
  if (mode === 'ready') {
    if (!parsed.street || !parsed.number) return { classification, suggestions: [] }

    const cacheKey = `${cc}:ready:${input.trim().toLowerCase()}`
    const cached = cache.get(cacheKey)
    if (cached) {
      return { classification, suggestions: cached }
    }

    // Find which tiles contain this street (from lightweight street_index, already in memory)
    const cityTilesArr = cityTiles ? ([...cityTiles] as string[]) : []
    const streets = await queryFns.queryStreets(cc, parsed.street, cityTilesArr)
    if (streets.length === 0) return { classification, suggestions: [] }

    // Get tile list from best matching street, intersected with city
    let tiles = toArr(streets[0].tiles)
    if (cityTiles) {
      const intersected = tiles.filter((t: string) => cityTiles.has(t))
      if (intersected.length > 0) tiles = intersected
    }

    // Try address suggestions from cached tiles only (no network fetch)
    const addresses = await queryFns.queryAddresses(cc, parsed.street, parsed.number, tiles)

    if (addresses.length > 0) {
      cache.set(cacheKey, addresses)
      return { classification, suggestions: addresses }
    }

    // No cached tiles available: show street as "ready to search" fallback
    const fallback: SuggestRow[] = [
      {
        type: 'address',
        label: `${streets[0].label} ${parsed.number}`,
        tiles: streets[0].tiles,
        addr_count: streets[0].addr_count,
        primary_city: streets[0].primary_city,
      },
    ]
    cache.set(cacheKey, fallback)
    return { classification, suggestions: fallback }
  }

  const cacheKey = `${cc}:${input.trim().toLowerCase()}`
  const cached = cache.get(cacheKey)
  if (cached) {
    return {
      classification,
      suggestions: rankSuggestions(cached, streetQuery || input, cityName, cityTiles),
    }
  }

  const cityTilesArr = cityTiles ? ([...cityTiles] as string[]) : []
  const result: SuggestRow[] = []

  // Query based on mode
  if (mode === 'postcode' || mode === 'mixed') {
    const pcQuery = parsed.postcode || input.trim()
    const postcodes = await queryFns.queryPostcodes(cc, pcQuery, cityTilesArr)
    result.push(...postcodes)
  }

  if (mode === 'street' || mode === 'mixed') {
    const sq = streetQuery.length >= 2 ? streetQuery : input.trim()
    if (sq.length >= 2) {
      const streets = await queryFns.queryStreets(cc, sq, cityTilesArr)
      result.push(...streets)
    }
  }

  cache.set(cacheKey, result)
  const ranked = rankSuggestions(result, streetQuery || input, cityName, cityTiles)
  return { classification, suggestions: ranked }
}

// ── Tile Resolution ──────────────────────────────────────────

/**
 * Resolve which tiles to search based on the current state:
 * selected suggestion, selected city, or parsed input.
 * Returns the tile list and a human-readable source description.
 */
export function resolveTiles(
  selectedSuggestion: SuggestRow | null,
  selectedCity: CityRow | null,
  cityTiles: Set<string> | null,
): TileResolutionResult {
  if (selectedSuggestion) {
    const tiles = toArr(selectedSuggestion.tiles)
    if (selectedCity && cityTiles) {
      const intersected = tiles.filter((t: string) => cityTiles.has(t))
      if (intersected.length > 0) return { tiles: intersected, source: `${selectedSuggestion.type} \u2229 city` }
    }
    return { tiles, source: `${selectedSuggestion.type} "${selectedSuggestion.label}"` }
  }
  if (cityTiles && selectedCity) return { tiles: [...cityTiles] as string[], source: `city "${selectedCity.city}"` }
  return { tiles: [], source: 'none' }
}

// ── SQL Query Builders ───────────────────────────────────────

/**
 * Build the SQL for postcode autocomplete with city tile boost.
 * Returns the full SQL string for queryObjects.
 */
export function buildPostcodeSQL(cc: string, query: string, cityTiles: string[]): string {
  validateCC(cc)
  const boost =
    cityTiles.length > 0 ? `list_has_any(tiles, ['${cityTiles.map((t) => esc(t)).join("','")}']::VARCHAR[]) DESC, ` : ''
  return `SELECT postcode, tiles, addr_count FROM _postcodes_${cc}
    WHERE lower(postcode) LIKE '${esc(query.toLowerCase())}%'
    ORDER BY ${boost}addr_count DESC LIMIT 15`
}

/**
 * Build the SQL for street autocomplete with city tile boost.
 * Returns the full SQL string for queryObjects.
 */
export function buildStreetSQL(cc: string, query: string, cityTiles: string[]): string {
  validateCC(cc)
  const boost =
    cityTiles.length > 0 ? `list_has_any(tiles, ['${cityTiles.map((t) => esc(t)).join("','")}']::VARCHAR[]) DESC, ` : ''
  return `SELECT street_lower, tiles, addr_count, primary_city FROM _streets_${cc}
    WHERE street_lower LIKE '${esc(query.toLowerCase())}%'
    ORDER BY ${boost}addr_count DESC LIMIT 15`
}

/**
 * Build SQL for narrowing tiles by postcode (exact or prefix match).
 */
export function buildPostcodeNarrowSQL(cc: string, postcode: string): string {
  validateCC(cc)
  return `SELECT postcode, tiles, addr_count FROM _postcodes_${cc}
    WHERE lower(postcode) = '${esc(postcode.toLowerCase())}'
    LIMIT 1`
}

/**
 * Build SQL for narrowing tiles by street (exact then prefix fallback).
 */
export function buildStreetNarrowSQL(cc: string, street: string, exact: boolean): string {
  validateCC(cc)
  const op = exact ? '=' : 'LIKE'
  const val = exact ? `'${esc(street.toLowerCase())}'` : `'${esc(street.toLowerCase())}%'`
  return `SELECT street_lower, tiles, addr_count FROM _streets_${cc}
    WHERE street_lower ${op} ${val}
    ${exact ? '' : 'ORDER BY addr_count DESC'} LIMIT 1`
}

/**
 * Build SQL for address-level autocomplete: query tile data for
 * distinct house numbers matching a street + number prefix.
 * Groups by number to deduplicate units (185A, 185B -> one "185" row).
 */
const TILE_RE = /^[0-9a-f]+$/i

export function buildAddressSQL(cc: string, street: string, numberPrefix: string, tile: string): string {
  validateCC(cc)
  if (!TILE_RE.test(tile)) throw new Error(`Invalid tile id: ${tile}`)
  return `SELECT DISTINCT number, street, city, postcode
    FROM read_parquet('${tilePath(cc, tile)}')
    WHERE lower(street) = '${esc(street.toLowerCase())}'
      AND number LIKE '${esc(numberPrefix)}%'
    ORDER BY number
    LIMIT 15`
}

/**
 * Build SQL for querying the number_index via HTTP range requests.
 * The number_index stores (street_lower, numbers[]) sorted by street_lower
 * with ROW_GROUP_SIZE 2000, enabling DuckDB-WASM to use row-group pushdown
 * and fetch only ~150 KB per query instead of full tiles (0.5-15 MB).
 *
 * The numbers column is a sorted VARCHAR[] of all distinct house numbers
 * for that street across the entire country.
 */
export function buildNumberIndexSQL(cc: string, street: string): string {
  validateCC(cc)
  return `SELECT street_lower, numbers
    FROM read_parquet('${dataPath(`number_index/${cc}.parquet`)}')
    WHERE street_lower = '${esc(street.toLowerCase())}'
    LIMIT 1`
}
