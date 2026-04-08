import type { StepEntry } from './types'

// ── Number formatting ───────────────────────────────────────

/** Format large numbers compactly: 1.2B, 3.5M, 10.2K */
export function fmt(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

/** Format numbers with full locale separators */
export function fmtFull(n: number): string {
  return n.toLocaleString()
}

/** Format byte sizes: B, KB, MB */
export function formatSize(bytes: number): string {
  if (bytes < 0) return 'N/A'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

// ── Timing ──────────────────────────────────────────────────

/** Format elapsed time from a performance.now() start */
export function ms(t0: number): string {
  return `${((performance.now() - t0) / 1000).toFixed(2)}s`
}

// ── SQL helpers ─────────────────────────────────────────────

/** Escape single quotes for DuckDB SQL strings */
export function esc(s: string): string {
  return s.replace(/'/g, "''")
}

/** Escape HTML special characters for safe insertion into innerHTML */
export function htmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const CC_RE = /^[A-Z]{2}$/
export const H3_RE = /^[0-9a-f]+$/i
const BUCKET_RE = /^[0-9a-z_]+$/i

/** Validate a 2-letter uppercase country code. Throws on invalid input. */
export function validateCC(cc: string): void {
  if (!CC_RE.test(cc)) throw new Error(`Invalid country code: ${cc}`)
}

/** Validate an H3 tile id (hex digits only). Throws on invalid input. */
export function validateH3(h: string): void {
  if (typeof h !== 'string' || !H3_RE.test(h)) throw new Error(`Invalid h3 id: ${h}`)
}

/** Validate a tile bucket id (alphanumerics + underscore). Throws on invalid input. */
export function validateBucket(b: string): void {
  if (typeof b !== 'string' || !BUCKET_RE.test(b)) throw new Error(`Invalid bucket: ${b}`)
}

/** Validate a finite number (not NaN/Infinity). Throws on invalid input. */
export function validateFiniteNumber(n: number, label: string): void {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`Invalid ${label}: ${n}`)
}

// Whitelist of allowed `FROM` source expressions. Matches one of:
// 1. A quoted tile cache identifier, `"_tile_XX_<hex>_<bucket>"`, produced by
//    `tileCacheTableName` after country/h3/bucket are validated.
// 2. `read_parquet('https://...parquet')` with a single HTTPS tile URL.
// 3. `read_parquet(['https://...parquet',...])` with one or more HTTPS tile URLs.
// Anything else is rejected so callers cannot smuggle arbitrary SQL into a
// `FROM ${src}` interpolation point.
const SAFE_TILE_IDENT_RE = /^"_tile_[A-Z]{2}_[a-f0-9]+_[a-z0-9_]+"$/
const SAFE_PARQUET_URL = "'https://[A-Za-z0-9._~:/?#@!$&+=%-]+\\.parquet'"
const SAFE_PARQUET_SINGLE_RE = new RegExp(`^read_parquet\\(${SAFE_PARQUET_URL}\\)$`)
const SAFE_PARQUET_LIST_RE = new RegExp(`^read_parquet\\(\\[${SAFE_PARQUET_URL}(?:,${SAFE_PARQUET_URL})*\\]\\)$`)

/** Validate a SQL `FROM` source expression against the tile source whitelist. */
export function validateSourceExpr(src: string): void {
  if (typeof src !== 'string') throw new Error(`Invalid src: ${src}`)
  if (SAFE_TILE_IDENT_RE.test(src)) return
  if (SAFE_PARQUET_SINGLE_RE.test(src)) return
  if (SAFE_PARQUET_LIST_RE.test(src)) return
  throw new Error(`Invalid src: ${src}`)
}

// ── Data conversion ─────────────────────────────────────────

/** Normalize Arrow/DuckDB array values to plain JS string arrays */
export function toArr(v: unknown): string[] {
  if (v == null) return []
  return Array.isArray(v) ? v : Array.from(v as Iterable<string>)
}

// ── Step log helpers ────────────────────────────────────────

/** Append a step entry to the log */
export function addStep(steps: StepEntry[], text: string, status?: StepEntry['status']): StepEntry[] {
  return [...steps, { text, status }]
}

/** Replace the last step entry in the log */
export function updateLastStep(steps: StepEntry[], text: string, status?: StepEntry['status']): StepEntry[] {
  return [...steps.slice(0, -1), { text, status }]
}
