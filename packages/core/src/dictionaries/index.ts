/**
 * Runtime index over the libpostal dictionaries committed under
 * `packages/core/src/dictionaries/<lang>/<kind>.json`.
 *
 * All maps are built once at module init and frozen. The hot path
 * (`expandStreetVariants`, `expandDirectional`) does pure `Map.get` lookups
 * with no per-call allocation of `Set`, `Map`, or `RegExp` (required by the
 * "Hot-path allocations" rule in CLAUDE.md).
 *
 * The dictionaries are derived from libpostal's pipe-delimited text files and
 * carry the upstream MIT attribution in each JSON's `_meta` block.
 */

import { validateCC } from '../utils'
import { languagesForCC } from './countries'

// ── JSON shapes ─────────────────────────────────────────────

interface EntryFile {
  _meta: { libpostal_sha: string; missing?: true }
  entries: Array<{ canonical: string; variants: string[] }>
}

interface AmbiguousFile {
  _meta: { libpostal_sha: string; missing?: true }
  tokens: string[]
}

// ── Eager JSON load ─────────────────────────────────────────
// Vite inlines these at build time. Vitest resolves them at test time.
// Keys look like `./<lang>/<kind>.json`.

const STREET_TYPES_MODULES = import.meta.glob<EntryFile>('./*/street_types.json', { eager: true })
const DIRECTIONALS_MODULES = import.meta.glob<EntryFile>('./*/directionals.json', { eager: true })
const AMBIGUOUS_MODULES = import.meta.glob<AmbiguousFile>('./*/ambiguous.json', { eager: true })

// ── Normalization ───────────────────────────────────────────
// Mirror of `normalizeForSearch` in packages/core/src/search.ts. Duplicated
// on purpose, we only need the NFKD + diacritics + ligatures subset here and
// the module loads before `search.ts` in the import graph. Keep both in sync.

const LIGATURE_MAP: [RegExp, string][] = [
  [/ß/g, 'ss'],
  [/\u1e9e/g, 'ss'],
  [/ø/gi, 'o'],
  [/æ/gi, 'ae'],
  [/œ/gi, 'oe'],
  [/đ/gi, 'd'],
  [/ł/gi, 'l'],
]

function normalize(token: string): string {
  let s = token.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  for (const [re, replacement] of LIGATURE_MAP) {
    s = s.replace(re, replacement)
  }
  return s.toLowerCase().trim()
}

// ── Per-language expansion maps ─────────────────────────────

type ExpansionMap = ReadonlyMap<string, readonly string[]>

interface LanguagePack {
  street: ExpansionMap
  directional: ExpansionMap
  ambiguous: ReadonlySet<string>
}

const EMPTY_PACK: LanguagePack = Object.freeze({
  street: new Map<string, readonly string[]>(),
  directional: new Map<string, readonly string[]>(),
  ambiguous: new Set<string>(),
})

function modulePathToLang(path: string): string {
  // path looks like `./en/street_types.json`
  const parts = path.split('/')
  return parts[1] ?? ''
}

function buildExpansionMap(entries: Array<{ canonical: string; variants: string[] }>): ExpansionMap {
  // Each canonical + variant forms an entry that maps back to the full set of
  // synonyms (canonical + every variant), so looking up any spelling yields
  // every other spelling.
  const out = new Map<string, string[]>()
  for (const { canonical, variants } of entries) {
    const canon = normalize(canonical)
    if (!canon) continue
    const forms = new Set<string>()
    forms.add(canon)
    for (const v of variants) {
      const n = normalize(v)
      if (n) forms.add(n)
    }
    const synonyms = Array.from(forms)
    for (const form of synonyms) {
      const existing = out.get(form)
      if (existing) {
        const merged = new Set(existing)
        for (const s of synonyms) merged.add(s)
        out.set(form, Array.from(merged))
      } else {
        out.set(form, synonyms)
      }
    }
  }
  return out
}

function buildAmbiguousSet(tokens: string[]): ReadonlySet<string> {
  const out = new Set<string>()
  for (const t of tokens) {
    const n = normalize(t)
    if (n) out.add(n)
  }
  return out
}

function collectLanguagePacks(): ReadonlyMap<string, LanguagePack> {
  const langs = new Set<string>()
  for (const p of Object.keys(STREET_TYPES_MODULES)) langs.add(modulePathToLang(p))
  for (const p of Object.keys(DIRECTIONALS_MODULES)) langs.add(modulePathToLang(p))
  for (const p of Object.keys(AMBIGUOUS_MODULES)) langs.add(modulePathToLang(p))

  const packs = new Map<string, LanguagePack>()
  for (const lang of langs) {
    if (!lang) continue
    const streetMod = STREET_TYPES_MODULES[`./${lang}/street_types.json`]
    const directionalMod = DIRECTIONALS_MODULES[`./${lang}/directionals.json`]
    const ambiguousMod = AMBIGUOUS_MODULES[`./${lang}/ambiguous.json`]
    packs.set(lang, {
      street: streetMod?.entries?.length ? buildExpansionMap(streetMod.entries) : new Map(),
      directional: directionalMod?.entries?.length ? buildExpansionMap(directionalMod.entries) : new Map(),
      ambiguous: ambiguousMod?.tokens?.length ? buildAmbiguousSet(ambiguousMod.tokens) : new Set(),
    })
  }
  return packs
}

const LANGUAGE_PACKS = collectLanguagePacks()

// ── Public API ──────────────────────────────────────────────

/**
 * Return the languages associated with a country code.
 *
 * Throws on malformed CC (catches bad routing bugs early). Returns a readonly
 * array, defaulting to `['en']` when the CC isn't mapped.
 */
export function getCountryLanguages(cc: string): readonly string[] {
  validateCC(cc)
  return languagesForCC(cc)
}

function expand(kind: 'street' | 'directional', cc: string, token: string): string[] {
  validateCC(cc)
  const normalized = normalize(token)
  if (!normalized) return []

  const langs = languagesForCC(cc)

  // If the normalized input is flagged ambiguous in any of the country's
  // languages, return the input untouched, expansion is too risky.
  for (const lang of langs) {
    const pack = LANGUAGE_PACKS.get(lang) ?? EMPTY_PACK
    if (pack.ambiguous.has(normalized)) return [normalized]
  }

  const result: string[] = [normalized]
  const seen = new Set<string>([normalized])
  for (const lang of langs) {
    const pack = LANGUAGE_PACKS.get(lang) ?? EMPTY_PACK
    const synonyms = kind === 'street' ? pack.street.get(normalized) : pack.directional.get(normalized)
    if (!synonyms) continue
    for (const s of synonyms) {
      if (!seen.has(s)) {
        seen.add(s)
        result.push(s)
      }
    }
  }
  return result
}

/**
 * Expand a street-type token (e.g. "ave" -> ["ave", "avenue", ...]).
 *
 * Input is lowercased and NFKD-normalized. Output is deduplicated with the
 * normalized input at index 0. If the token is in any of the country's
 * `ambiguous` sets, expansion is suppressed and only the input is returned.
 *
 * SAFETY: the returned values are raw strings. Callers that interpolate them
 * into SQL MUST wrap each value with `esc()`.
 */
export function expandStreetVariants(cc: string, token: string): string[] {
  return expand('street', cc, token)
}

/**
 * Expand a directional token (e.g. "n" -> ["n", "north", ...]).
 *
 * Same normalization, deduplication, ambiguity, and SQL-safety rules as
 * `expandStreetVariants`.
 */
export function expandDirectional(cc: string, token: string): string[] {
  return expand('directional', cc, token)
}

/**
 * Test-only helper. Expose the normalized form used for lookups so tests
 * and callers who need to line up input with the dictionary can agree on
 * the spelling without re-implementing the normalization rules.
 */
export function normalizeDictToken(token: string): string {
  return normalize(token)
}
