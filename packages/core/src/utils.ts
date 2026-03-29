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

/** Validate a 2-letter uppercase country code. Throws on invalid input. */
export function validateCC(cc: string): void {
  if (!CC_RE.test(cc)) throw new Error(`Invalid country code: ${cc}`)
}

/** Validate a region string (state name or H3 hex). Throws on empty/invalid input. */
export function validateRegion(region: string): void {
  if (!region || typeof region !== 'string') throw new Error(`Invalid region: ${region}`)
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
