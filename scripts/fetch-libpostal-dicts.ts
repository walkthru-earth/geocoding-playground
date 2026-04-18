/**
 * Fetch libpostal dictionary files and materialize them as JSON under
 * `packages/core/src/dictionaries/<lang>/<kind>.json`.
 *
 * Run with: `pnpm dlx tsx scripts/fetch-libpostal-dicts.ts`
 *
 * The script pins a commit SHA at the top. Bump it by hand when you want to
 * refresh, then re-run. 404s for missing files are recorded in `_meta.missing`
 * rather than treated as failures, libpostal coverage is uneven per language.
 *
 * Output format per kind:
 *   street_types.json, directionals.json, unit_types.json:
 *     { _meta: {...}, entries: [{ canonical, variants: string[] }, ...] }
 *   ambiguous.json:
 *     { _meta: {...}, tokens: string[] }
 *
 * All tokens are lowercased and NFKD-normalized on write so they line up with
 * `normalizeForSearch` at query time.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Pinned libpostal repo, resolved SHA, and targets. Constants only, no user
// input is ever passed through execFile, so shell injection is a non-issue.
const LIBPOSTAL_REPO = 'openvenues/libpostal'
const SHA_RE = /^[0-9a-f]{7,40}$/i
const LIBPOSTAL_SHA = resolveSha()

const TARGET_LANGS = [
  'en',
  'de',
  'fr',
  'es',
  'it',
  'nl',
  'pt',
  'ja',
  'pl',
  'da',
  'nb',
  'sv',
  'fi',
  'cs',
  'sk',
  'sl',
  'hr',
  'sr',
  'lt',
  'lv',
  'et',
  'hu',
  'ro',
  'is',
  'ca',
  'eu',
  'gl',
] as const

const KIND_FILES: Record<string, string> = {
  street_types: 'street_types.txt',
  directionals: 'directionals.txt',
  unit_types: 'unit_types_standalone.txt',
  ambiguous: 'ambiguous_expansions.txt',
}

interface Entry {
  canonical: string
  variants: string[]
}

interface KindMeta {
  libpostal_repo: string
  libpostal_sha: string
  source_file: string
  fetched_at: string
  license: string
  attribution: string
  missing?: true
}

interface EntryFile {
  _meta: KindMeta
  entries: Entry[]
}

interface AmbiguousFile {
  _meta: KindMeta
  tokens: string[]
}

function ghApi(path: string): string {
  return execFileSync('gh', ['api', path, '--jq', '.'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim()
}

function ghApiJq(path: string, jq: string): string {
  return execFileSync('gh', ['api', path, '--jq', jq], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim()
}

function resolveSha(): string {
  const override = process.env.LIBPOSTAL_SHA
  if (override && SHA_RE.test(override)) return override
  const sha = execFileSync('gh', ['api', `repos/${LIBPOSTAL_REPO}/commits/master`, '--jq', '.sha'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (!SHA_RE.test(sha)) {
    throw new Error(`Unexpected SHA from gh: ${sha}`)
  }
  return sha
}

// Applied after NFKD to match `normalizeForSearch` in packages/core/src/search.ts.
// Keep these two in sync, dictionary tokens are looked up on NFKD-normalized
// query input, so ligatures must be decomposed identically on both sides.
const LIGATURE_MAP: [RegExp, string][] = [
  [/ß/g, 'ss'],
  [/\u1e9e/g, 'ss'],
  [/ø/gi, 'o'],
  [/æ/gi, 'ae'],
  [/œ/gi, 'oe'],
  [/đ/gi, 'd'],
  [/ł/gi, 'l'],
]

function normalizeToken(s: string): string {
  let out = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  for (const [re, replacement] of LIGATURE_MAP) {
    out = out.replace(re, replacement)
  }
  return out.toLowerCase().trim()
}

function parsePipeLines(text: string): Entry[] {
  const out: Entry[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const parts = line
      .split('|')
      .map((p) => normalizeToken(p))
      .filter(Boolean)
    if (parts.length === 0) continue
    const canonical = parts[0]
    const variants = Array.from(new Set(parts.slice(1).filter((v) => v !== canonical)))
    const key = `${canonical}\x00${variants.join('|')}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ canonical, variants })
  }
  return out
}

function parseTokenLines(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const token = normalizeToken(line)
    if (!token || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

interface FetchResult {
  ok: boolean
  text: string
}

function fetchFile(lang: string, file: string): FetchResult {
  const apiPath = `repos/${LIBPOSTAL_REPO}/contents/resources/dictionaries/${lang}/${file}?ref=${LIBPOSTAL_SHA}`
  try {
    const b64 = ghApiJq(apiPath, '.content')
    if (!b64) return { ok: false, text: '' }
    const buf = Buffer.from(b64.replace(/\n/g, ''), 'base64')
    return { ok: true, text: buf.toString('utf8') }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/Not Found|HTTP 404/i.test(msg)) {
      console.warn(`[fetch] ${lang}/${file}: ${msg.slice(0, 160)}`)
    }
    return { ok: false, text: '' }
  }
}

function langExists(lang: string): boolean {
  try {
    ghApi(`repos/${LIBPOSTAL_REPO}/contents/resources/dictionaries/${lang}?ref=${LIBPOSTAL_SHA}`)
    return true
  } catch {
    return false
  }
}

function makeMeta(sourceFile: string, missing = false): KindMeta {
  const meta: KindMeta = {
    libpostal_repo: LIBPOSTAL_REPO,
    libpostal_sha: LIBPOSTAL_SHA,
    source_file: sourceFile,
    fetched_at: new Date().toISOString(),
    license: 'MIT',
    attribution:
      'libpostal by Al Barrentine, MIT License. https://github.com/openvenues/libpostal. Dictionaries imported at the pinned commit.',
  }
  if (missing) meta.missing = true
  return meta
}

function writeJSON(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const outRoot = resolve(here, '..', 'packages', 'core', 'src', 'dictionaries')
  console.log(`[libpostal] repo=${LIBPOSTAL_REPO} sha=${LIBPOSTAL_SHA}`)
  console.log(`[libpostal] writing to ${outRoot}`)

  const summary: Array<{ lang: string; kind: string; count: number; missing: boolean }> = []

  for (const lang of TARGET_LANGS) {
    if (!langExists(lang)) {
      console.warn(`[libpostal] skipping ${lang}, not present upstream`)
      continue
    }
    for (const [kind, file] of Object.entries(KIND_FILES)) {
      const result = fetchFile(lang, file)
      const outPath = resolve(outRoot, lang, `${kind}.json`)
      if (!result.ok) {
        if (kind === 'ambiguous') {
          const empty: AmbiguousFile = { _meta: makeMeta(file, true), tokens: [] }
          writeJSON(outPath, empty)
        } else {
          const empty: EntryFile = { _meta: makeMeta(file, true), entries: [] }
          writeJSON(outPath, empty)
        }
        summary.push({ lang, kind, count: 0, missing: true })
        continue
      }
      if (kind === 'ambiguous') {
        const tokens = parseTokenLines(result.text)
        const data: AmbiguousFile = { _meta: makeMeta(file), tokens }
        writeJSON(outPath, data)
        summary.push({ lang, kind, count: tokens.length, missing: false })
      } else {
        const entries = parsePipeLines(result.text)
        const data: EntryFile = { _meta: makeMeta(file), entries }
        writeJSON(outPath, data)
        summary.push({ lang, kind, count: entries.length, missing: false })
      }
    }
    console.log(`[libpostal] ${lang} done`)
  }

  console.log('\n[libpostal] summary:')
  for (const row of summary) {
    const tag = row.missing ? '(missing)' : `${row.count} entries`
    console.log(`  ${row.lang}/${row.kind}: ${tag}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
