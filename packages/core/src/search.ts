/** LRU cache with TTL expiration for autocomplete results. */
export class SearchCache<T> {
  private cache = new Map<string, { value: T; timestamp: number }>()
  private maxSize: number
  private ttlMs: number

  constructor(maxSize = 100, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
  }

  private normalizeKey(key: string): string {
    return key.toLowerCase().trim()
  }

  get(key: string): T | undefined {
    const k = this.normalizeKey(key)
    const entry = this.cache.get(k)
    if (!entry) return undefined

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(k)
      return undefined
    }

    // LRU: delete and re-insert to move to end
    this.cache.delete(k)
    this.cache.set(k, entry)
    return entry.value
  }

  set(key: string, value: T): void {
    const k = this.normalizeKey(key)
    this.cache.delete(k)

    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value
      if (oldest) this.cache.delete(oldest)
    }

    this.cache.set(k, { value, timestamp: Date.now() })
  }

  clear(): void {
    this.cache.clear()
  }
}

/** Compute bigrams (2-character substrings) of a string. */
function bigrams(str: string): Set<string> {
  const s = str.toUpperCase()
  const result = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) {
    result.add(s.slice(i, i + 2))
  }
  return result
}

/** Jaccard similarity between two strings based on bigrams (0.0–1.0). */
export function jaccardSimilarity(a: string, b: string): number {
  const bgA = bigrams(a)
  const bgB = bigrams(b)
  if (bgA.size === 0 && bgB.size === 0) return 1

  let intersection = 0
  for (const bg of bgA) {
    if (bgB.has(bg)) intersection++
  }

  const union = bgA.size + bgB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** Re-rank items by Jaccard bigram similarity to query. */
export function rankBySimilarity<T>(items: T[], query: string, getText: (item: T) => string): T[] {
  if (items.length <= 1 || query.length < 2) return items
  return items
    .map((item) => ({ item, score: jaccardSimilarity(query, getText(item)) }))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item)
}

// ── Text normalization for cross-script search ──────────────
// Handles ß↔ss (German), ø↔o (Nordic), æ↔ae, œ↔oe, đ↔d, ł↔l
// plus all accented Latin characters via NFKD decomposition.

const LIGATURE_MAP: [RegExp, string][] = [
  [/ß/g, 'ss'],
  [/\u1E9E/g, 'ss'], // Capital ß (rare)
  [/ø/gi, 'o'],
  [/æ/gi, 'ae'],
  [/œ/gi, 'oe'],
  [/đ/gi, 'd'],
  [/ł/gi, 'l'],
]

/**
 * Normalize text for search comparison.
 * Strips accents (é→e, ü→u, ñ→n) via NFKD decomposition, then handles
 * ligatures that Unicode normalization does not decompose (ß→ss, ø→o, etc.).
 * Zero dependencies, covers all 39 countries in the dataset.
 */
export function normalizeForSearch(input: string): string {
  // NFKD decomposes accented characters into base + combining marks, then strip the marks
  let s = input.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  // Handle ligatures/special chars that NFKD doesn't decompose
  for (const [re, replacement] of LIGATURE_MAP) {
    s = s.replace(re, replacement)
  }
  return s.toLowerCase()
}

// ── JS array autocomplete (sub-millisecond) ─────────────────
// Replaces DuckDB SQL LIKE queries for instant keystroke response.

import { expandStreetVariants } from './dictionaries/index'
import type { CityRecord, PostcodeRecord, StreetRecord } from './types'

/**
 * Pre-compute normalized names for an array of records.
 * Call once at prefetch time, then pass to searchStreets/searchCities
 * on every keystroke to avoid per-record normalizeForSearch() calls.
 * For DE (387K streets), this saves ~387K NFKD operations per keystroke.
 */
export function preNormalize<T>(items: T[], getText: (item: T) => string): string[] {
  return items.map((item) => normalizeForSearch(getText(item)))
}

/**
 * Filter + rank streets by prefix. <1ms for 200K+ entries.
 *
 * When `cc` is provided, the query's trailing token is expanded via libpostal
 * dictionaries so that typing "clearview avenue" also matches "clearview ave".
 * Variants are matched in parallel, results are deduplicated by `street_lower`,
 * then the existing addr_count sort + Jaccard rerank tail is applied.
 *
 * Pass preNormed (from preNormalize) to skip per-record normalization.
 */
export function searchStreets(
  streets: StreetRecord[],
  query: string,
  limit = 15,
  preNormed?: string[],
  cc?: string,
): StreetRecord[] {
  const q = normalizeForSearch(query)
  const norm = preNormed ? (i: number) => preNormed[i] : (i: number) => normalizeForSearch(streets[i].street_lower)

  // Derive the set of query prefixes to scan for. Without a CC we just use the
  // normalized query. With one, we expand the trailing token (street type).
  const queries = expandQueryVariants(cc, q)

  const matches: StreetRecord[] = []
  const seen = new Set<string>()
  for (const variant of queries) {
    for (let i = 0; i < streets.length; i++) {
      if (seen.has(streets[i].street_lower)) continue
      if (norm(i).startsWith(variant)) {
        matches.push(streets[i])
        seen.add(streets[i].street_lower)
      }
    }
  }
  // If few prefix matches, try contains using the original query
  if (matches.length < 3) {
    for (let i = 0; i < streets.length; i++) {
      if (seen.has(streets[i].street_lower)) continue
      if (norm(i).includes(q)) {
        matches.push(streets[i])
        seen.add(streets[i].street_lower)
      }
    }
  }
  // Sort by addr_count descending, then rank by similarity
  matches.sort((a, b) => b.addr_count - a.addr_count)
  return rankBySimilarity(matches.slice(0, limit * 2), query, (s) => s.street_lower).slice(0, limit)
}

function expandQueryVariants(cc: string | undefined, normalizedQuery: string): string[] {
  if (!cc) return [normalizedQuery]
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return [normalizedQuery]
  const tail = tokens[tokens.length - 1]
  const variants = expandStreetVariants(cc, tail)
  if (variants.length <= 1) return [normalizedQuery]
  const head = tokens.slice(0, -1).join(' ')
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of variants) {
    const prefix = head ? `${head} ${v}` : v
    if (seen.has(prefix)) continue
    seen.add(prefix)
    out.push(prefix)
  }
  // Keep the original normalized query first so exact-prefix matches rank ahead
  // of alternate-spelling matches in the prefix scan.
  if (!seen.has(normalizedQuery)) out.unshift(normalizedQuery)
  return out
}

/** Filter + rank postcodes by prefix. <1ms even for 466K NL postcodes. */
export function searchPostcodes(postcodes: PostcodeRecord[], query: string, limit = 15): PostcodeRecord[] {
  const q = query.toUpperCase()
  const matches = postcodes.filter((p) => p.postcode.toUpperCase().startsWith(q))
  matches.sort((a, b) => b.addr_count - a.addr_count)
  return matches.slice(0, limit)
}

/**
 * Filter + rank cities by prefix with fallback to contains.
 * Pass preNormed (from preNormalize) to skip per-record normalization.
 */
export function searchCities(cities: CityRecord[], query: string, limit = 20, preNormed?: string[]): CityRecord[] {
  const q = normalizeForSearch(query)
  const norm = preNormed ? (i: number) => preNormed[i] : (i: number) => normalizeForSearch(cities[i].city)

  const matches: CityRecord[] = []
  for (let i = 0; i < cities.length; i++) {
    if (norm(i).startsWith(q)) matches.push(cities[i])
  }
  if (matches.length < 3) {
    const seen = new Set(matches.map((c) => c.city))
    for (let i = 0; i < cities.length; i++) {
      if (!seen.has(cities[i].city) && norm(i).includes(q)) matches.push(cities[i])
    }
  }
  matches.sort((a, b) => b.addr_count - a.addr_count)
  return rankBySimilarity(matches.slice(0, limit * 2), query, (c) => c.city).slice(0, limit)
}
