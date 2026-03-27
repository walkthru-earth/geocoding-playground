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
  if (bgA.size === 0 && bgB.size === 0) return 0

  let intersection = 0
  for (const bg of bgA) {
    if (bgB.has(bg)) intersection++
  }

  const union = bgA.size + bgB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** Re-rank items by Jaccard bigram similarity to query. */
export function rankBySimilarity<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  if (items.length <= 1 || query.length < 2) return items
  return items
    .map(item => ({ item, score: jaccardSimilarity(query, getText(item)) }))
    .sort((a, b) => b.score - a.score)
    .map(s => s.item)
}

// ── JS array autocomplete (sub-millisecond) ─────────────────
// Replaces DuckDB SQL LIKE queries for instant keystroke response.

import type { CityRecord, PostcodeRecord, StreetRecord } from './types'

/** Filter + rank streets by prefix. <1ms for 200K+ entries. */
export function searchStreets(
  streets: StreetRecord[],
  query: string,
  limit = 15,
): StreetRecord[] {
  const q = query.toLowerCase()
  let matches = streets.filter(s => s.street_lower.startsWith(q))
  // If few prefix matches, try contains
  if (matches.length < 3) {
    const seen = new Set(matches.map(s => s.street_lower))
    const extra = streets.filter(s => !seen.has(s.street_lower) && s.street_lower.includes(q))
    matches = [...matches, ...extra]
  }
  // Sort by addr_count descending, then rank by similarity
  matches.sort((a, b) => b.addr_count - a.addr_count)
  return rankBySimilarity(matches.slice(0, limit * 2), query, s => s.street_lower).slice(0, limit)
}

/** Filter + rank postcodes by prefix. <1ms even for 466K NL postcodes. */
export function searchPostcodes(
  postcodes: PostcodeRecord[],
  query: string,
  limit = 15,
): PostcodeRecord[] {
  const q = query.toUpperCase()
  const matches = postcodes.filter(p => p.postcode.toUpperCase().startsWith(q))
  matches.sort((a, b) => b.addr_count - a.addr_count)
  return matches.slice(0, limit)
}

/** Filter + rank cities by prefix with fallback to contains. */
export function searchCities(
  cities: CityRecord[],
  query: string,
  limit = 20,
): CityRecord[] {
  const q = query.toLowerCase()
  let matches = cities.filter(c => c.city.toLowerCase().startsWith(q))
  if (matches.length < 3) {
    const seen = new Set(matches.map(c => c.city))
    const extra = cities.filter(c => !seen.has(c.city) && c.city.toLowerCase().includes(q))
    matches = [...matches, ...extra]
  }
  matches.sort((a, b) => b.addr_count - a.addr_count)
  return rankBySimilarity(matches.slice(0, limit * 2), query, c => c.city).slice(0, limit)
}
