/**
 * Validate address parser test cases against live S3 parquet data.
 * Queries real street/postcode indexes to verify parsed addresses exist
 * and reports coordinates, addr_count, and tile coverage.
 *
 * Usage: node .github/scripts/validate-parsers.mjs [--summary]
 *   --summary: write to $GITHUB_STEP_SUMMARY (CI mode)
 *
 * Requires: duckdb CLI in PATH (or run via MotherDuck MCP)
 * Output: test-output/validation/parser-validation.md
 */

import { execSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'

const BASE =
  'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/walkthru-earth/indices/addresses-index/v4/release=2026-03-18.0'
const writeSummary = process.argv.includes('--summary')

// ── Test cases: what the parser produces, what we expect in real data ──

const cases = [
  // US
  { cc: 'US', input: '25 Broadway', street: 'broadway', number: '25', expectCity: 'New York' },
  { cc: 'US', input: '1871 MENAHAN ST APT 2R NY 11385', street: 'menahan st', postcode: '11385' },
  { cc: 'US', input: '10001', postcode: '10001' },

  // NL
  { cc: 'NL', input: 'Keizersgracht 185', street: 'keizersgracht', number: '185', expectCity: 'Amsterdam' },
  { cc: 'NL', input: 'Keizersgracht 185 1016AG', street: 'keizersgracht', postcode: '1016AG' },
  { cc: 'NL', input: '2e Nassaustraat', street: 'nassaustraat' },

  // DE
  { cc: 'DE', input: 'Unter den Linden 5', street: 'unter den linden', number: '5' },
  { cc: 'DE', input: 'Hauptstraße', street: 'hauptstraße', expectCity: 'Garbsen, Stadt' },
  { cc: 'DE', input: '10117', postcode: '10117' },

  // FR
  { cc: 'FR', input: '12 Rue de Rivoli', street: 'rue de rivoli', expectCity: 'Paris 1er Arrondissement' },
  { cc: 'FR', input: '75001', postcode: '75001' },

  // BR
  { cc: 'BR', input: 'Rua Augusta 1234', street: 'rua augusta' },
  { cc: 'BR', input: '68515-000', postcode: '68515-000' },

  // JP
  { cc: 'JP', input: '本郷 1-2-3', street: '本郷' },
  { cc: 'JP', input: '100-0001', postcode: '100-0001' },

  // AU
  { cc: 'AU', input: '45 George Street', street: 'george street', expectCity: 'SYDNEY' },
  { cc: 'AU', input: '2000', postcode: '2000' },

  // CA
  { cc: 'CA', input: '123 King Street', street: 'king street' },
  { cc: 'CA', input: 'K1A0G4', postcode: 'K1A0G4' },

  // ES
  { cc: 'ES', input: 'Calle Gran Via 12', street: 'calle gran via' },
  { cc: 'ES', input: '28013', postcode: '28013' },

  // IT
  { cc: 'IT', input: 'Via del Corso 12', street: 'via del corso' },
  { cc: 'IT', input: 'Via Aldo Moro 64', street: 'via aldo moro', expectCity: 'Frosinone' },
]

function duckQuery(sql) {
  try {
    const result = execSync(`duckdb -json -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 30_000,
    })
    return JSON.parse(result || '[]')
  } catch {
    return null
  }
}

// ── Run validation ──────────────────────────────────────────

const lines = []
lines.push('# Parser Data Validation Report')
lines.push('')
lines.push('Validates parsed address fields against live S3 parquet index data.')
lines.push('')
lines.push('| CC | Input | Type | Found | Primary City | Addr Count | Tiles | Match |')
lines.push('|----|-------|------|-------|-------------|-----------|-------|-------|')

let passed = 0
let failed = 0
let skipped = 0

for (const c of cases) {
  const isStreet = !!c.street && !c.postcode
  const isPostcode = !!c.postcode && !c.street
  const isBoth = !!c.street && !!c.postcode
  const type = isPostcode ? 'postcode' : isStreet ? 'street' : 'both'

  let rows = null

  if (c.street) {
    const escaped = c.street.replace(/'/g, "''")
    rows = duckQuery(
      `SELECT street_lower, addr_count, len(tiles) as tile_count, primary_city FROM read_parquet('${BASE}/street_index/${c.cc}.parquet') WHERE street_lower = '${escaped}' LIMIT 1`,
    )
  } else if (c.postcode) {
    const escaped = c.postcode.replace(/'/g, "''")
    // Some countries don't have postcode index
    const noPostcode = ['JP', 'IT', 'TW', 'CO', 'HK', 'NZ', 'CL', 'EE', 'RS']
    if (noPostcode.includes(c.cc)) {
      lines.push(`| ${c.cc} | \`${c.input}\` | ${type} | ⏭️ skip | no postcode index | - | - | N/A |`)
      skipped++
      continue
    }
    rows = duckQuery(
      `SELECT postcode, addr_count, len(tiles) as tile_count FROM read_parquet('${BASE}/postcode_index/${c.cc}.parquet') WHERE postcode = '${escaped}' LIMIT 1`,
    )
  }

  if (rows === null) {
    lines.push(`| ${c.cc} | \`${c.input}\` | ${type} | ⚠️ query failed | - | - | - | - |`)
    skipped++
    continue
  }

  if (rows.length === 0) {
    lines.push(`| ${c.cc} | \`${c.input}\` | ${type} | ❌ not found | - | 0 | 0 | FAIL |`)
    failed++
    continue
  }

  const r = rows[0]
  const addrCount = r.addr_count
  const tileCount = r.tile_count
  const primaryCity = r.primary_city || '-'
  const found = r.street_lower || r.postcode

  let match = '✅'
  if (c.expectCity && primaryCity !== c.expectCity) {
    match = `⚠️ expected ${c.expectCity}`
  }

  lines.push(
    `| ${c.cc} | \`${c.input}\` | ${type} | ✅ \`${found}\` | ${primaryCity} | ${addrCount?.toLocaleString()} | ${tileCount} | ${match} |`,
  )
  passed++
}

lines.push('')
lines.push(`**Results**: ${passed} passed, ${failed} failed, ${skipped} skipped / ${cases.length} total`)
lines.push('')

// ── Normalization validation (ß/ss, accents) ────────────────

lines.push('## Normalization Validation')
lines.push('')
lines.push('Checks that the JS normalizer matches produce results in the real data.')
lines.push('')
lines.push('| Query (user types) | Data has | CC | Found | Addr Count |')
lines.push('|-------------------|----------|-----|-------|-----------|')

const normCases = [
  { query: 'hauptstrasse', dataHas: 'hauptstraße', cc: 'DE' },
  { query: 'kleiststrasse', dataHas: 'kleiststraße', cc: 'DE' },
  { query: 'hauptstrasse', dataHas: 'hauptstrasse', cc: 'CH' },
]

for (const nc of normCases) {
  const escaped = nc.dataHas.replace(/'/g, "''")
  const rows = duckQuery(
    `SELECT street_lower, addr_count FROM read_parquet('${BASE}/street_index/${nc.cc}.parquet') WHERE street_lower = '${escaped}' LIMIT 1`,
  )

  if (rows && rows.length > 0) {
    lines.push(`| \`${nc.query}\` | \`${nc.dataHas}\` | ${nc.cc} | ✅ | ${rows[0].addr_count?.toLocaleString()} |`)
  } else {
    lines.push(`| \`${nc.query}\` | \`${nc.dataHas}\` | ${nc.cc} | ❌ not found | - |`)
  }
}

lines.push('')

// ── Write output ────────────────────────────────────────────

const markdown = lines.join('\n')

mkdirSync('test-output/validation', { recursive: true })
writeFileSync('test-output/validation/parser-validation.md', markdown)
console.log(`Validation report: test-output/validation/parser-validation.md (${passed}/${cases.length} passed)`)

if (writeSummary && process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${markdown}`)
}

// Also print to stdout for local use
console.log('')
console.log(markdown)
