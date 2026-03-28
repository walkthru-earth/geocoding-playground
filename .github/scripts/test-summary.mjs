/**
 * Generate a comprehensive GitHub Actions Job Summary from Vitest JSON output.
 * Usage: node .github/scripts/test-summary.mjs <test-results.json> [coverage-dir]
 *
 * Writes Markdown to $GITHUB_STEP_SUMMARY (or stdout if not in CI).
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const jsonPath = process.argv[2]
const coverageDir = process.argv[3]

if (!jsonPath) {
  console.error('Usage: node test-summary.mjs <test-results.json> [coverage-dir]')
  process.exit(1)
}

const data = JSON.parse(readFileSync(jsonPath, 'utf-8'))
const durationMs = data.testResults.reduce((sum, s) => sum + (s.endTime - s.startTime), 0)
const durationSec = (durationMs / 1000).toFixed(1)

// ── Summary header ──────────────────────────────────────────

const icon = data.success ? '✅' : '❌'
const lines = []
lines.push(`# ${icon} Unit Test Report`)
lines.push('')
lines.push('| Metric | Result |')
lines.push('|--------|--------|')
lines.push(`| **Test Suites** | ${data.numPassedTestSuites} passed / ${data.numTotalTestSuites} total |`)
lines.push(
  `| **Tests** | ${data.numPassedTests} passed, ${data.numFailedTests} failed, ${data.numPendingTests} skipped / ${data.numTotalTests} total |`,
)
lines.push(`| **Duration** | ${durationSec}s |`)
lines.push('')

// ── Per-file breakdown ──────────────────────────────────────

lines.push('## Test Suites')
lines.push('')
lines.push('| Status | File | Tests | Duration |')
lines.push('|--------|------|-------|----------|')

for (const suite of data.testResults) {
  const fileName = suite.name.replace(/^.*src\//, 'src/')
  const suiteDur = ((suite.endTime - suite.startTime) / 1000).toFixed(2)
  const testCount = suite.assertionResults.length
  const passed = suite.assertionResults.filter((t) => t.status === 'passed').length
  const failed = suite.assertionResults.filter((t) => t.status === 'failed').length
  const statusIcon = suite.status === 'passed' ? '✅' : '❌'

  let countStr = `${passed} passed`
  if (failed > 0) countStr += `, ${failed} failed`

  lines.push(`| ${statusIcon} | \`${fileName}\` | ${countStr} / ${testCount} | ${suiteDur}s |`)
}

lines.push('')

// ── Describe-level breakdown ────────────────────────────────

lines.push('## Test Details')
lines.push('')

for (const suite of data.testResults) {
  const fileName = suite.name.replace(/^.*src\//, 'src/')
  const failed = suite.assertionResults.filter((t) => t.status === 'failed')

  // Group tests by top-level describe
  const groups = new Map()
  for (const test of suite.assertionResults) {
    const group = test.ancestorTitles[0] || '(root)'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(test)
  }

  lines.push(`### \`${fileName}\``)
  lines.push('')

  for (const [group, tests] of groups) {
    const groupPassed = tests.filter((t) => t.status === 'passed').length
    const groupFailed = tests.filter((t) => t.status === 'failed').length
    const groupIcon = groupFailed > 0 ? '❌' : '✅'

    lines.push(`<details${groupFailed > 0 ? ' open' : ''}>`)
    lines.push(`<summary>${groupIcon} <strong>${group}</strong> (${groupPassed}/${tests.length} passed)</summary>`)
    lines.push('')
    lines.push('| Status | Test |')
    lines.push('|--------|------|')

    for (const test of tests) {
      const testIcon = test.status === 'passed' ? '✅' : test.status === 'failed' ? '❌' : '⏭️'
      const path = [...test.ancestorTitles.slice(1), test.title].join(' > ')
      lines.push(`| ${testIcon} | ${path} |`)
    }

    lines.push('')
    lines.push('</details>')
    lines.push('')
  }

  // Show failure details
  if (failed.length > 0) {
    lines.push('#### Failures')
    lines.push('')
    for (const test of failed) {
      const path = [...test.ancestorTitles, test.title].join(' > ')
      lines.push(`**${path}**`)
      lines.push('```')
      lines.push(test.failureMessages.join('\n').slice(0, 500))
      lines.push('```')
      lines.push('')
    }
  }
}

// ── Coverage summary (if available) ─────────────────────────

if (coverageDir) {
  const coveragePath = `${coverageDir}/coverage-final.json`
  if (existsSync(coveragePath)) {
    const coverage = JSON.parse(readFileSync(coveragePath, 'utf-8'))

    lines.push('## Coverage')
    lines.push('')
    lines.push('| File | Statements | Branches | Functions | Lines |')
    lines.push('|------|-----------|----------|-----------|-------|')

    let totalStmts = 0,
      coveredStmts = 0
    let totalBranches = 0,
      coveredBranches = 0
    let totalFns = 0,
      coveredFns = 0
    let totalLines = 0,
      coveredLines = 0

    for (const [filePath, data] of Object.entries(coverage)) {
      const fileName = filePath.replace(/^.*src\//, 'src/')

      const stmts = Object.values(data.s)
      const branches = Object.values(data.b).flat()
      const fns = Object.values(data.f)
      const lineMap = data.l || {}
      const lineVals = Object.values(lineMap)

      const stmtCov = stmts.length ? (stmts.filter((v) => v > 0).length / stmts.length) * 100 : 100
      const brCov = branches.length ? (branches.filter((v) => v > 0).length / branches.length) * 100 : 100
      const fnCov = fns.length ? (fns.filter((v) => v > 0).length / fns.length) * 100 : 100
      const lineCov = lineVals.length ? (lineVals.filter((v) => v > 0).length / lineVals.length) * 100 : 100

      totalStmts += stmts.length
      coveredStmts += stmts.filter((v) => v > 0).length
      totalBranches += branches.length
      coveredBranches += branches.filter((v) => v > 0).length
      totalFns += fns.length
      coveredFns += fns.filter((v) => v > 0).length
      totalLines += lineVals.length
      coveredLines += lineVals.filter((v) => v > 0).length

      const pct = (v) => (v >= 80 ? `🟢 ${v.toFixed(1)}%` : v >= 50 ? `🟡 ${v.toFixed(1)}%` : `🔴 ${v.toFixed(1)}%`)
      lines.push(`| \`${fileName}\` | ${pct(stmtCov)} | ${pct(brCov)} | ${pct(fnCov)} | ${pct(lineCov)} |`)
    }

    const pct = (c, t) => {
      const v = t ? (c / t) * 100 : 100
      return v >= 80 ? `🟢 ${v.toFixed(1)}%` : v >= 50 ? `🟡 ${v.toFixed(1)}%` : `🔴 ${v.toFixed(1)}%`
    }
    lines.push(
      `| **Total** | ${pct(coveredStmts, totalStmts)} | ${pct(coveredBranches, totalBranches)} | ${pct(coveredFns, totalFns)} | ${pct(coveredLines, totalLines)} |`,
    )
    lines.push('')
  }
}

// ── Output ──────────────────────────────────────────────────

const markdown = lines.join('\n')

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  console.log(`Summary written to $GITHUB_STEP_SUMMARY (${data.numTotalTests} tests)`)
} else {
  console.log(markdown)
}
