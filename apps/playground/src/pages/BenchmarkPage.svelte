<script lang="ts">
  import { query, queryObjects, dataPath, formatSize } from '@walkthru-earth/geocoding-core'

  const EXPERIMENTS_BASE = dataPath('experiments')

  // Index versions to benchmark
  const INDEX_VERSIONS = {
    'v1-current': {
      label: 'V1: Current (no coords)',
      street: (cc: string) => dataPath(`street_index/${cc}.parquet`),
      postcode: (cc: string) => dataPath(`postcode_index/${cc}.parquet`),
      city: () => dataPath('city_index.parquet'),
      hasCoords: false,
      hasCity: false,
    },
    'v2-enriched': {
      label: 'V2: Enriched (DOUBLE coords + city)',
      street: (cc: string) => `${EXPERIMENTS_BASE}/v2-enriched/street_index/${cc}.parquet`,
      postcode: (cc: string) => `${EXPERIMENTS_BASE}/v2-enriched/postcode_index/${cc}.parquet`,
      city: (cc: string) => `${EXPERIMENTS_BASE}/v2-enriched/city_index_${cc}.parquet`,
      hasCoords: true,
      hasCity: true,
    },
    'v3-compact': {
      label: 'V3: Compact (INT32 coords + city)',
      street: (cc: string) => `${EXPERIMENTS_BASE}/v3-compact/street_index/${cc}.parquet`,
      postcode: (cc: string) => `${EXPERIMENTS_BASE}/v3-compact/postcode_index/${cc}.parquet`,
      city: (cc: string) => `${EXPERIMENTS_BASE}/v3-compact/city_index_${cc}.parquet`,
      hasCoords: true,
      hasCity: true,
    },
    'v4-hilbert': {
      label: 'V4: Hilbert-sorted (DOUBLE + spatial order)',
      street: (cc: string) => `${EXPERIMENTS_BASE}/v4-hilbert/street_index/${cc}.parquet`,
      postcode: (cc: string) => `${EXPERIMENTS_BASE}/v4-hilbert/postcode_index/${cc}.parquet`,
      city: (cc: string) => `${EXPERIMENTS_BASE}/v4-hilbert/city_index_${cc}.parquet`,
      hasCoords: true,
      hasCity: true,
    },
  } as const

  type VersionKey = keyof typeof INDEX_VERSIONS

  const TEST_COUNTRIES = ['NL', 'DE'] as const
  type TestCC = typeof TEST_COUNTRIES[number]

  // Test scenarios
  const SCENARIOS = [
    { id: 'street-prefix', label: 'Street prefix', type: 'street' as const, queries: { NL: 'kerkstr', DE: 'hauptstr' } },
    { id: 'street-common', label: 'Common street', type: 'street' as const, queries: { NL: 'dorpsstraat', DE: 'hauptstraße' } },
    { id: 'street-rare', label: 'Rare street', type: 'street' as const, queries: { NL: 'zonnebloem', DE: 'kirschbaum' } },
    { id: 'postcode-exact', label: 'Postcode exact', type: 'postcode' as const, queries: { NL: '1013BJ', DE: '10115' } },
    { id: 'postcode-prefix', label: 'Postcode prefix', type: 'postcode' as const, queries: { NL: '1013', DE: '101' } },
    { id: 'city-search', label: 'City search', type: 'city' as const, queries: { NL: 'amsterdam', DE: 'berlin' } },
  ]

  interface BenchResult {
    version: VersionKey
    scenario: string
    country: TestCC
    query: string
    rows: number
    timeMs: number
    fileSize?: number
    sample?: any[]
    error?: string
  }

  let selectedCountry = $state<TestCC>('NL')
  let results = $state<BenchResult[]>([])
  let running = $state(false)
  let currentTest = $state('')
  let fileSizes = $state<Record<string, Record<string, number>>>({})
  let logs = $state<string[]>([])

  function log(msg: string) {
    logs = [...logs, `[${new Date().toISOString().slice(11, 23)}] ${msg}`]
  }

  // ── CDN / Proxy latency comparison ──────────────────────

  const CDN_BASES = {
    's3-direct': 'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/walkthru-earth/indices/addresses-index/v1/release=2026-03-18.0',
    'source-coop': 'https://data.source.coop/walkthru-earth/indices/addresses-index/v1/release=2026-03-18.0',
  } as const

  type CdnKey = keyof typeof CDN_BASES

  const CDN_TEST_FILES = [
    { id: 'tile_index', label: 'tile_index.parquet', path: 'tile_index.parquet', desc: '562 KB, 17.5K rows' },
    { id: 'manifest', label: 'manifest.parquet', path: 'manifest.parquet', desc: '3 KB, 39 rows' },
    { id: 'street_NL', label: 'street_index/NL.parquet', path: 'street_index/NL.parquet', desc: '1.1 MB, 136K rows' },
    { id: 'tile_small', label: 'NL small tile', path: 'geocoder/country=NL/h3/84194d9ffffffff.parquet', desc: '5.3 MB' },
  ]

  interface CdnResult {
    cdn: CdnKey
    file: string
    fetchMs: number
    queryMs: number
    rows: number
    error?: string
  }

  let cdnResults = $state<CdnResult[]>([])
  let cdnRunning = $state(false)
  let cdnDone = $state(false)

  async function runCdnBenchmark() {
    cdnRunning = true
    cdnResults = []
    log('=== CDN LATENCY BENCHMARK ===')

    for (const file of CDN_TEST_FILES) {
      for (const [cdnKey, base] of Object.entries(CDN_BASES)) {
        const url = `${base}/${file.path}`
        log(`  [${cdnKey}] ${file.label}...`)

        const result: CdnResult = { cdn: cdnKey as CdnKey, file: file.id, fetchMs: 0, queryMs: 0, rows: 0 }

        try {
          // Measure HTTP fetch time (just metadata / first bytes)
          const ft0 = performance.now()
          const fetchRes = await fetch(url, { method: 'HEAD' })
          result.fetchMs = Math.round(performance.now() - ft0)

          if (!fetchRes.ok) {
            result.error = `HTTP ${fetchRes.status}`
            log(`    HEAD: ${result.error}`)
          } else {
            log(`    HEAD: ${result.fetchMs}ms (${fetchRes.headers.get('content-length') ?? '?'} bytes)`)
          }

          // Measure DuckDB query time (full read)
          const qt0 = performance.now()
          const res = await query(`SELECT count(*)::INTEGER AS c FROM read_parquet('${url}')`)
          result.queryMs = Math.round(performance.now() - qt0)
          result.rows = res.rows[0]?.[0] ?? 0
          log(`    Query: ${result.queryMs}ms (${result.rows} rows)`)
        } catch (e: any) {
          result.error = e.message?.slice(0, 80)
          log(`    ERROR: ${result.error}`)
        }

        cdnResults = [...cdnResults, result]
      }
    }

    cdnRunning = false
    cdnDone = true
    log('=== CDN BENCHMARK COMPLETE ===')
  }

  // Auto-run CDN benchmark on mount
  $effect(() => { if (!cdnDone && !cdnRunning) runCdnBenchmark() })

  // ── File size measurement ──
  async function measureFileSizes(cc: TestCC) {
    log(`Measuring file sizes for ${cc}...`)
    const sizes: Record<string, Record<string, number>> = {}

    for (const [vKey, vDef] of Object.entries(INDEX_VERSIONS)) {
      sizes[vKey] = {}
      for (const fType of ['street', 'postcode', 'city'] as const) {
        try {
          const url = vDef[fType](cc)
          const res = await queryObjects<{ file_size: number }>(`
            SELECT sum(total_compressed_size)::INTEGER AS file_size
            FROM parquet_metadata('${url}')
          `)
          sizes[vKey][fType] = res[0]?.file_size ?? 0
        } catch {
          sizes[vKey][fType] = -1  // not available
        }
      }
    }
    fileSizes = sizes
    log(`File sizes measured for ${cc}`)
  }

  // ── Benchmark runner ──
  async function runBenchmarks() {
    running = true
    results = []
    logs = []
    const cc = selectedCountry

    await measureFileSizes(cc)

    for (const scenario of SCENARIOS) {
      const q = scenario.queries[cc]
      if (!q) continue

      for (const [vKey, vDef] of Object.entries(INDEX_VERSIONS)) {
        // Skip v4-hilbert for DE (only NL generated)
        if (vKey === 'v4-hilbert' && cc === 'DE') continue

        currentTest = `${vDef.label} / ${scenario.label}`
        log(`Running: ${currentTest} → "${q}"`)

        const result: BenchResult = {
          version: vKey as VersionKey,
          scenario: scenario.id,
          country: cc,
          query: q,
          rows: 0,
          timeMs: 0,
        }

        try {
          const url = vDef[scenario.type](cc)
          let sql = ''

          if (scenario.type === 'street') {
            const cols = vDef.hasCity
              ? 'street_lower, primary_city, addr_count, len(tiles) AS num_tiles'
              : 'street_lower, addr_count, len(tiles) AS num_tiles'
            sql = `SELECT ${cols} FROM read_parquet('${url}')
              WHERE street_lower LIKE '${q.toLowerCase()}%' LIMIT 10`
          } else if (scenario.type === 'postcode') {
            const coordCols = vDef.hasCoords
              ? (vKey === 'v3-compact' ? ', lon_e6, lat_e6' : ', avg_lon, avg_lat')
              : ''
            sql = `SELECT postcode, addr_count, len(tiles) AS num_tiles${coordCols}
              FROM read_parquet('${url}')
              WHERE postcode LIKE '${q}%' LIMIT 10`
          } else {
            // city
            const bboxCols = vDef.hasCoords
              ? (vKey === 'v3-compact'
                ? ', bbox_min_lon_e6, bbox_max_lon_e6, bbox_min_lat_e6, bbox_max_lat_e6'
                : ', bbox_min_lon, bbox_max_lon, bbox_min_lat, bbox_max_lat')
              : ''
            sql = `SELECT city, addr_count, len(tiles) AS num_tiles${bboxCols}
              FROM read_parquet('${url}')
              WHERE lower(city) LIKE '${q.toLowerCase()}%' LIMIT 10`
          }

          const t0 = performance.now()
          const res = await query(sql)
          result.timeMs = Math.round(performance.now() - t0)
          result.rows = res.rows.length
          result.sample = res.rows.slice(0, 3).map((row: any[]) => {
            const obj: any = {}
            res.columns.forEach((col: string, i: number) => { obj[col] = row[i] })
            return obj
          })
        } catch (e: any) {
          result.error = e.message?.slice(0, 100)
          result.timeMs = -1
          log(`  ERROR: ${result.error}`)
        }

        results = [...results, result]
        if (result.timeMs >= 0) {
          log(`  → ${result.rows} rows in ${result.timeMs}ms`)
        }
      }
    }

    // Run a second pass (warm cache) for more accurate timing
    log('')
    log('=== WARM CACHE PASS (repeat all queries) ===')
    const warmResults: BenchResult[] = []

    for (const scenario of SCENARIOS) {
      const q = scenario.queries[cc]
      if (!q) continue

      for (const [vKey, vDef] of Object.entries(INDEX_VERSIONS)) {
        if (vKey === 'v4-hilbert' && cc === 'DE') continue

        const url = vDef[scenario.type](cc)
        let sql = ''

        if (scenario.type === 'street') {
          sql = `SELECT street_lower FROM read_parquet('${url}') WHERE street_lower LIKE '${q.toLowerCase()}%' LIMIT 10`
        } else if (scenario.type === 'postcode') {
          sql = `SELECT postcode FROM read_parquet('${url}') WHERE postcode LIKE '${q}%' LIMIT 10`
        } else {
          sql = `SELECT city FROM read_parquet('${url}') WHERE lower(city) LIKE '${q.toLowerCase()}%' LIMIT 10`
        }

        try {
          const t0 = performance.now()
          const res = await query(sql)
          const ms = Math.round(performance.now() - t0)
          warmResults.push({
            version: vKey as VersionKey,
            scenario: scenario.id,
            country: cc,
            query: q,
            rows: res.rows.length,
            timeMs: ms,
          })
          log(`  [warm] ${vDef.label} / ${scenario.label}: ${ms}ms`)
        } catch {
          warmResults.push({
            version: vKey as VersionKey,
            scenario: scenario.id,
            country: cc,
            query: q,
            rows: 0,
            timeMs: -1,
            error: 'failed',
          })
        }
      }
    }

    // Merge warm results
    results = [...results, ...warmResults.map(r => ({ ...r, scenario: r.scenario + '-warm' }))]

    currentTest = ''
    running = false
    log('=== BENCHMARK COMPLETE ===')
  }

  // ── Helpers ──
  function getResultsForScenario(scenarioId: string): BenchResult[] {
    return results.filter(r => r.scenario === scenarioId)
  }

  function getWarmResultsForScenario(scenarioId: string): BenchResult[] {
    return results.filter(r => r.scenario === scenarioId + '-warm')
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between flex-wrap gap-2">
    <h1 class="text-xl md:text-2xl font-bold">Index Benchmark</h1>
    <div class="flex items-center gap-2 md:gap-3">
      <select class="select select-bordered select-xs md:select-sm" bind:value={selectedCountry} disabled={running}>
        {#each TEST_COUNTRIES as cc}
          <option value={cc}>{cc}</option>
        {/each}
      </select>
      <button class="btn btn-primary btn-xs md:btn-sm" onclick={runBenchmarks} disabled={running}>
        {#if running}
          <span class="loading loading-spinner loading-xs"></span>
          {currentTest}
        {:else}
          Run Benchmarks
        {/if}
      </button>
    </div>
  </div>

  <!-- CDN / Proxy latency comparison -->
  <div class="card bg-base-200 p-4">
    <div class="flex items-center justify-between mb-2">
      <h2 class="font-bold">CDN Latency Comparison</h2>
      {#if cdnRunning}
        <span class="loading loading-spinner loading-xs"></span>
      {:else if cdnDone}
        <button class="btn btn-xs btn-ghost" onclick={runCdnBenchmark}>Re-run</button>
      {/if}
    </div>
    <p class="text-xs text-base-content/50 mb-3">
      Comparing S3 direct ({CDN_BASES['s3-direct'].split('/')[2]}) vs Source Cooperative proxy ({CDN_BASES['source-coop'].split('/')[2]}).
      HEAD = HTTP round-trip, Query = full DuckDB read_parquet.
    </p>
    {#if cdnResults.length > 0}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>File</th>
              {#each Object.entries(CDN_BASES) as [key, _]}
                <th class="text-center" colspan="2">{key}</th>
              {/each}
              <th>Winner</th>
            </tr>
            <tr>
              <th></th>
              {#each Object.keys(CDN_BASES) as _}
                <th class="text-right text-xs opacity-50">HEAD</th>
                <th class="text-right text-xs opacity-50">Query</th>
              {/each}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each CDN_TEST_FILES as file}
              {@const s3 = cdnResults.find(r => r.cdn === 's3-direct' && r.file === file.id)}
              {@const sc = cdnResults.find(r => r.cdn === 'source-coop' && r.file === file.id)}
              {@const s3q = s3?.queryMs ?? Infinity}
              {@const scq = sc?.queryMs ?? Infinity}
              {@const winner = s3q < scq ? 's3-direct' : scq < s3q ? 'source-coop' : 'tie'}
              {@const diff = Math.abs(s3q - scq)}
              <tr>
                <td>
                  <div class="font-mono text-xs">{file.label}</div>
                  <div class="text-xs opacity-40">{file.desc}</div>
                </td>
                <td class="text-right font-mono text-xs">
                  {#if s3?.error}<span class="text-error">{s3.error}</span>{:else}{s3?.fetchMs ?? '-'}ms{/if}
                </td>
                <td class="text-right font-mono text-xs" class:text-success={winner === 's3-direct'}>
                  {#if s3?.error}<span class="text-error">-</span>{:else}{s3?.queryMs ?? '-'}ms{/if}
                </td>
                <td class="text-right font-mono text-xs">
                  {#if sc?.error}<span class="text-error">{sc.error}</span>{:else}{sc?.fetchMs ?? '-'}ms{/if}
                </td>
                <td class="text-right font-mono text-xs" class:text-success={winner === 'source-coop'}>
                  {#if sc?.error}<span class="text-error">-</span>{:else}{sc?.queryMs ?? '-'}ms{/if}
                </td>
                <td>
                  {#if winner !== 'tie' && diff > 50}
                    <span class="badge badge-sm" class:badge-primary={winner === 'source-coop'} class:badge-secondary={winner === 's3-direct'}>
                      {winner === 'source-coop' ? 'SC' : 'S3'} -{diff}ms
                    </span>
                  {:else}
                    <span class="badge badge-ghost badge-sm">~same</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if !cdnRunning}
      <p class="text-xs opacity-40">Click Re-run to test</p>
    {/if}
  </div>

  <!-- Version descriptions -->
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3">
    {#each Object.entries(INDEX_VERSIONS) as [key, def]}
      <div class="card bg-base-200 p-3">
        <h3 class="font-semibold text-sm">{def.label}</h3>
        <div class="text-xs text-base-content/60 mt-1">
          {#if key === 'v1-current'}
            Baseline. street_lower + tiles + addr_count. No location data.
          {:else if key === 'v2-enriched'}
            + primary_city + avg_lon/avg_lat (DOUBLE). Autocomplete disambiguation + map pin.
          {:else if key === 'v3-compact'}
            + primary_city + lon_e6/lat_e6 (INT32). Same features, ~40% smaller coords.
          {:else}
            Hilbert spatial sort. Nearby streets clustered in same row groups. Better spatial pushdown.
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <!-- File sizes -->
  {#if Object.keys(fileSizes).length > 0}
    <div class="card bg-base-200 p-4">
      <h2 class="font-bold mb-2">File Sizes ({selectedCountry})</h2>
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>Version</th>
              <th>Street Index</th>
              <th>Postcode Index</th>
              <th>City Index</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {#each Object.entries(fileSizes) as [ver, sizes]}
              {@const total = Object.values(sizes).reduce((a, b) => a + (b > 0 ? b : 0), 0)}
              <tr>
                <td class="font-mono text-xs">{ver}</td>
                <td>{formatSize(sizes.street ?? -1)}</td>
                <td>{formatSize(sizes.postcode ?? -1)}</td>
                <td>{formatSize(sizes.city ?? -1)}</td>
                <td class="font-bold">{formatSize(total)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}

  <!-- Results by scenario -->
  {#each SCENARIOS as scenario}
    {@const cold = getResultsForScenario(scenario.id)}
    {@const warm = getWarmResultsForScenario(scenario.id)}
    {#if cold.length > 0}
      <div class="card bg-base-200 p-4">
        <h2 class="font-bold mb-1">{scenario.label}: "{scenario.queries[selectedCountry]}"</h2>
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr>
                <th>Version</th>
                <th>Cold (ms)</th>
                <th>Warm (ms)</th>
                <th>Rows</th>
                <th>Sample</th>
              </tr>
            </thead>
            <tbody>
              {#each cold as r}
                {@const w = warm.find(w => w.version === r.version)}
                <tr>
                  <td class="font-mono text-xs">{r.version}</td>
                  <td>
                    {#if r.error}
                      <span class="text-error text-xs">{r.error}</span>
                    {:else}
                      <span class:text-success={r.timeMs < 500}
                            class:text-warning={r.timeMs >= 500 && r.timeMs < 2000}
                            class:text-error={r.timeMs >= 2000}>
                        {r.timeMs}ms
                      </span>
                    {/if}
                  </td>
                  <td>
                    {#if w && !w.error}
                      <span class:text-success={w.timeMs < 100}
                            class:text-warning={w.timeMs >= 100 && w.timeMs < 500}
                            class:text-error={w.timeMs >= 500}>
                        {w.timeMs}ms
                      </span>
                    {:else}
                      -
                    {/if}
                  </td>
                  <td>{r.rows}</td>
                  <td class="text-xs font-mono max-w-sm truncate">
                    {#if r.sample && r.sample.length > 0}
                      {JSON.stringify(r.sample[0]).slice(0, 120)}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  {/each}

  <!-- Logs -->
  {#if logs.length > 0}
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title font-bold">Logs ({logs.length} entries)</div>
      <div class="collapse-content">
        <pre class="text-xs bg-base-300 p-3 rounded max-h-80 overflow-y-auto">{logs.join('\n')}</pre>
      </div>
    </div>
  {/if}
</div>
