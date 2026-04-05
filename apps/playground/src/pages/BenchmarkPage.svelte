<script lang="ts">
  import { query, queryObjects, dataPath, indexPath, tilePath, formatSize } from '@walkthru-earth/geocoding-core'

  // ── State ──────────────────────────────────────────────────

  let activeTab = $state<'cdn' | 'queries' | 'parquet'>('cdn')
  let logs = $state<string[]>([])

  function log(msg: string) {
    logs = [...logs, `[${new Date().toISOString().slice(11, 23)}] ${msg}`]
  }

  // ── CDN Latency ────────────────────────────────────────────

  const S3_BASE = dataPath('')
  const SC_BASE = S3_BASE.replace(
    'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/',
    'https://data.source.coop/',
  )
  const CDN_BASES = { 's3-direct': S3_BASE, 'source-coop': SC_BASE } as const
  type CdnKey = keyof typeof CDN_BASES

  const CDN_TEST_FILES = [
    { id: 'manifest', label: 'manifest.parquet', path: 'manifest.parquet', desc: '~3 KB' },
    { id: 'tile_index', label: 'tile_index.parquet', path: 'tile_index.parquet', desc: '~560 KB' },
    { id: 'street_NL', label: 'street_index/NL', path: 'street_index/country=NL/data_0.parquet', desc: '~1.1 MB' },
    { id: 'city_NL', label: 'city_index/NL', path: 'city_index/country=NL/data_0.parquet', desc: '~15 KB' },
    { id: 'number_NL', label: 'number_index/NL', path: 'number_index/country=NL/data_0.parquet', desc: '~1.5 MB' },
  ]

  interface CdnResult { cdn: CdnKey; file: string; headMs: number; queryMs: number; rows: number; bytes: string; error?: string }

  let cdnResults = $state<CdnResult[]>([])
  let cdnRunning = $state(false)

  async function runCdnBenchmark() {
    cdnRunning = true
    cdnResults = []
    log('=== CDN LATENCY ===')

    for (const file of CDN_TEST_FILES) {
      for (const [cdnKey, base] of Object.entries(CDN_BASES)) {
        const url = `${base}${file.path}`
        const result: CdnResult = { cdn: cdnKey as CdnKey, file: file.id, headMs: 0, queryMs: 0, rows: 0, bytes: '?' }

        try {
          const ft0 = performance.now()
          const fetchRes = await fetch(url, { method: 'HEAD' })
          result.headMs = Math.round(performance.now() - ft0)
          result.bytes = fetchRes.headers.get('content-length') ?? '?'
          if (!fetchRes.ok) result.error = `HTTP ${fetchRes.status}`

          const qt0 = performance.now()
          const res = await query(`SELECT count(*)::INTEGER AS c FROM read_parquet('${url}')`)
          result.queryMs = Math.round(performance.now() - qt0)
          result.rows = res.rows[0]?.[0] ?? 0
        } catch (e: any) {
          result.error = e.message?.slice(0, 80)
        }

        cdnResults = [...cdnResults, result]
        log(`  [${cdnKey}] ${file.label}: HEAD ${result.headMs}ms, Query ${result.queryMs}ms`)
      }
    }

    cdnRunning = false
    log('=== CDN DONE ===')
  }

  $effect(() => { if (cdnResults.length === 0 && !cdnRunning) runCdnBenchmark() })

  // ── Query Benchmarks with EXPLAIN ANALYZE ──────────────────

  const TEST_COUNTRIES = ['NL', 'DE', 'US', 'FR', 'JP'] as const
  type TestCC = typeof TEST_COUNTRIES[number]

  interface QueryScenario {
    id: string
    label: string
    description: string
    buildSQL: (cc: TestCC) => string
  }

  const QUERY_SCENARIOS: QueryScenario[] = [
    {
      id: 'street-prefix',
      label: 'Street prefix search',
      description: 'LIKE prefix match on street_lower. Tests row-group min/max pushdown on sorted data.',
      buildSQL: (cc) => {
        const q = { NL: 'kerkstr', DE: 'hauptstr', US: 'broadway', FR: 'rue de', JP: '本郷' }[cc] ?? 'main'
        return `SELECT street_lower, primary_city, addr_count, len(tiles) AS num_tiles
          FROM read_parquet('${indexPath('street_index', cc)}')
          WHERE street_lower LIKE '${q}%' LIMIT 10`
      },
    },
    {
      id: 'postcode-prefix',
      label: 'Postcode prefix search',
      description: 'LIKE prefix match on postcode column.',
      buildSQL: (cc) => {
        const q = { NL: '1013', DE: '101', US: '100', FR: '750', JP: '' }[cc]
        if (!q) return ''
        return `SELECT postcode, addr_count, len(tiles) AS num_tiles
          FROM read_parquet('${indexPath('postcode_index', cc)}')
          WHERE postcode LIKE '${q}%' LIMIT 10`
      },
    },
    {
      id: 'city-search',
      label: 'City search',
      description: 'Case-insensitive city name prefix search with region.',
      buildSQL: (cc) => {
        const q = { NL: 'amsterdam', DE: 'berlin', US: 'new york', FR: 'paris', JP: '東京' }[cc] ?? 'main'
        return `SELECT city, region, addr_count, len(tiles) AS num_tiles
          FROM read_parquet('${indexPath('city_index', cc)}')
          WHERE lower(city) LIKE '${q}%' LIMIT 10`
      },
    },
    {
      id: 'number-pushdown',
      label: 'Number index (HTTP range pushdown)',
      description: 'Exact match on street_lower in number_index. ROW_GROUP_SIZE 2000 + bloom filters enable DuckDB to fetch only ~150 KB instead of the full file.',
      buildSQL: (cc) => {
        const q = { NL: 'keizersgracht', DE: 'friedrichstraße', US: 'broadway', FR: 'avenue des champs', JP: '本郷' }[cc] ?? 'main'
        return `SELECT street_lower, len(numbers) AS num_count
          FROM read_parquet('${indexPath('number_index', cc)}')
          WHERE street_lower = '${q}' LIMIT 1`
      },
    },
    {
      id: 'tile-scan',
      label: 'Geocoder tile scan (street_lower pushdown)',
      description: 'Query a geocoder tile with street_lower filter. Tests bloom filter skip on the street column.',
      buildSQL: (cc) => {
        // Small tiles (~10K addresses) verified to exist on v4 S3
        const tiles: Record<string, [string, string]> = {
          NL: ['84196b1ffffffff', 'keizersgracht'],
          DE: ['841f017ffffffff', 'friedrichstraße'],
          US: ['8426531ffffffff', 'broadway'],
          FR: ['8418457ffffffff', 'rue de'],
          JP: ['842ead5ffffffff', '本郷'],
        }
        const [tile, street] = tiles[cc] ?? ['84196b1ffffffff', 'main']
        return `SELECT full_address, street, number, city, postcode
          FROM read_parquet('${tilePath(cc, tile, '_')}')
          WHERE street_lower LIKE '${street}%' LIMIT 5`
      },
    },
  ]

  interface QueryResult {
    scenarioId: string
    coldMs: number
    warmMs: number
    rows: number
    sample: any[]
    plan: string
    error?: string
  }

  let selectedCountry = $state<TestCC>('NL')
  let queryResults = $state<QueryResult[]>([])
  let queryRunning = $state(false)
  let currentTest = $state('')
  let showPlans = $state(false)

  async function runExplainAnalyze(sql: string): Promise<string> {
    try {
      const res = await query(`EXPLAIN ANALYZE ${sql}`)
      const lines: string[] = []
      for (const row of res.rows) {
        if (row[1]) lines.push(String(row[1]))
      }
      return lines.join('\n')
    } catch {
      return '(EXPLAIN ANALYZE not available)'
    }
  }

  async function runQueryBenchmarks() {
    queryRunning = true
    queryResults = []
    const cc = selectedCountry
    log(`=== QUERY BENCHMARKS (${cc}) ===`)

    for (const scenario of QUERY_SCENARIOS) {
      const sql = scenario.buildSQL(cc)
      if (!sql) continue

      currentTest = scenario.label
      log(`  ${scenario.label}...`)

      const result: QueryResult = { scenarioId: scenario.id, coldMs: 0, warmMs: 0, rows: 0, sample: [], plan: '' }

      try {
        // Cold run
        const t0 = performance.now()
        const res = await query(sql)
        result.coldMs = Math.round(performance.now() - t0)
        result.rows = res.rows.length
        result.sample = res.rows.slice(0, 3).map((row: any[]) => {
          const obj: any = {}
          res.columns.forEach((col: string, i: number) => { obj[col] = row[i] })
          return obj
        })

        // Warm run
        const t1 = performance.now()
        await query(sql)
        result.warmMs = Math.round(performance.now() - t1)

        // EXPLAIN ANALYZE
        result.plan = await runExplainAnalyze(sql)

        log(`    cold=${result.coldMs}ms, warm=${result.warmMs}ms, rows=${result.rows}`)
      } catch (e: any) {
        result.error = e.message?.slice(0, 120)
        log(`    ERROR: ${result.error}`)
      }

      queryResults = [...queryResults, result]
    }

    currentTest = ''
    queryRunning = false
    log('=== QUERIES DONE ===')
  }

  // ── Parquet Metadata Inspector ─────────────────────────────

  interface ParquetFileInfo {
    label: string
    url: string
    numRows: number
    numRowGroups: number
    fileSize: number
    columns: { name: string; type: string; compression: string; hasBloom: boolean; avgSize: number }[]
    error?: string
  }

  let parquetCountry = $state<TestCC>('NL')
  let parquetResults = $state<ParquetFileInfo[]>([])
  let parquetRunning = $state(false)

  async function inspectParquetFiles() {
    parquetRunning = true
    parquetResults = []
    const cc = parquetCountry
    log(`=== PARQUET METADATA (${cc}) ===`)

    const files = [
      { label: 'city_index', url: indexPath('city_index', cc) },
      { label: 'street_index', url: indexPath('street_index', cc) },
      { label: 'postcode_index', url: indexPath('postcode_index', cc) },
      { label: 'number_index', url: indexPath('number_index', cc) },
    ]

    for (const file of files) {
      log(`  ${file.label}...`)
      const info: ParquetFileInfo = { label: file.label, url: file.url, numRows: 0, numRowGroups: 0, fileSize: 0, columns: [] }

      try {
        // File-level metadata
        const fileMeta = await queryObjects<{ num_rows: number; num_row_groups: number; file_size_bytes: number }>(`
          SELECT num_rows::INTEGER AS num_rows, num_row_groups::INTEGER AS num_row_groups, file_size_bytes::INTEGER AS file_size_bytes
          FROM parquet_file_metadata('${file.url}')
        `)
        if (fileMeta.length > 0) {
          info.numRows = fileMeta[0].num_rows
          info.numRowGroups = fileMeta[0].num_row_groups
          info.fileSize = fileMeta[0].file_size_bytes
        }

        // Column-level metadata (from first row group)
        const colMeta = await queryObjects<{ name: string; type: string; compression: string; has_bloom: boolean; avg_size: number }>(`
          SELECT
            path_in_schema AS name,
            type,
            compression,
            (bloom_filter_offset IS NOT NULL) AS has_bloom,
            (total_compressed_size / GREATEST(num_values, 1))::INTEGER AS avg_size
          FROM parquet_metadata('${file.url}')
          WHERE row_group_id = 0
          ORDER BY path_in_schema
        `)
        info.columns = colMeta.map(c => ({
          name: c.name,
          type: c.type,
          compression: c.compression,
          hasBloom: c.has_bloom,
          avgSize: c.avg_size,
        }))

        log(`    ${info.numRows} rows, ${info.numRowGroups} row groups, ${formatSize(info.fileSize)}`)
      } catch (e: any) {
        info.error = e.message?.slice(0, 100)
        log(`    ERROR: ${info.error}`)
      }

      parquetResults = [...parquetResults, info]
    }

    parquetRunning = false
    log('=== PARQUET DONE ===')
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between flex-wrap gap-2">
    <h1 class="text-xl md:text-2xl font-bold">Benchmark & Inspect</h1>
  </div>

  <!-- Tab bar -->
  <div role="tablist" class="tabs tabs-bordered">
    <button role="tab" class="tab" class:tab-active={activeTab === 'cdn'} onclick={() => activeTab = 'cdn'}>CDN Latency</button>
    <button role="tab" class="tab" class:tab-active={activeTab === 'queries'} onclick={() => activeTab = 'queries'}>Query Benchmark</button>
    <button role="tab" class="tab" class:tab-active={activeTab === 'parquet'} onclick={() => activeTab = 'parquet'}>Parquet Inspector</button>
  </div>

  <!-- ═══ CDN Tab ═══ -->
  {#if activeTab === 'cdn'}
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <p class="text-sm text-base-content/60">
          Comparing S3 direct vs Source Cooperative proxy. HEAD = HTTP round-trip latency. Query = full DuckDB read_parquet.
        </p>
        <button class="btn btn-xs btn-outline" onclick={runCdnBenchmark} disabled={cdnRunning}>
          {#if cdnRunning}<span class="loading loading-spinner loading-xs"></span>{:else}Re-run{/if}
        </button>
      </div>

      {#if cdnResults.length > 0}
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr>
                <th>File</th>
                {#each Object.keys(CDN_BASES) as key}
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
                {@const winner = s3q < scq ? 's3' : scq < s3q ? 'sc' : 'tie'}
                {@const diff = Math.abs(s3q - scq)}
                <tr>
                  <td>
                    <div class="font-mono text-xs">{file.label}</div>
                    <div class="text-xs opacity-40">{file.desc}</div>
                  </td>
                  <td class="text-right font-mono text-xs">
                    {#if s3?.error}<span class="text-error">{s3.error}</span>{:else}{s3?.headMs ?? '-'}ms{/if}
                  </td>
                  <td class="text-right font-mono text-xs" class:text-success={winner === 's3'}>
                    {#if s3?.error}<span class="text-error">-</span>{:else}{s3?.queryMs ?? '-'}ms{/if}
                  </td>
                  <td class="text-right font-mono text-xs">
                    {#if sc?.error}<span class="text-error">{sc.error}</span>{:else}{sc?.headMs ?? '-'}ms{/if}
                  </td>
                  <td class="text-right font-mono text-xs" class:text-success={winner === 'sc'}>
                    {#if sc?.error}<span class="text-error">-</span>{:else}{sc?.queryMs ?? '-'}ms{/if}
                  </td>
                  <td>
                    {#if winner !== 'tie' && diff > 50}
                      <span class="badge badge-sm" class:badge-primary={winner === 'sc'} class:badge-secondary={winner === 's3'}>
                        {winner === 'sc' ? 'SC' : 'S3'} -{diff}ms
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
      {/if}
    </div>
  {/if}

  <!-- ═══ Query Benchmark Tab ═══ -->
  {#if activeTab === 'queries'}
    <div class="space-y-4">
      <div class="flex items-center gap-3 flex-wrap">
        <select class="select select-bordered select-sm" bind:value={selectedCountry} disabled={queryRunning}>
          {#each TEST_COUNTRIES as cc}
            <option value={cc}>{cc}</option>
          {/each}
        </select>
        <button class="btn btn-primary btn-sm" onclick={runQueryBenchmarks} disabled={queryRunning}>
          {#if queryRunning}
            <span class="loading loading-spinner loading-xs"></span>
            {currentTest}
          {:else}
            Run All Queries
          {/if}
        </button>
        {#if queryResults.length > 0}
          <label class="label cursor-pointer gap-2">
            <span class="label-text text-xs">Show EXPLAIN ANALYZE</span>
            <input type="checkbox" class="toggle toggle-xs toggle-primary" bind:checked={showPlans} />
          </label>
        {/if}
      </div>

      <p class="text-sm text-base-content/60">
        Each query runs cold (first fetch from S3), then warm (Parquet metadata cached).
        EXPLAIN ANALYZE shows the execution plan with per-operator timing and actual row counts.
      </p>

      {#each QUERY_SCENARIOS as scenario}
        {@const result = queryResults.find(r => r.scenarioId === scenario.id)}
        <div class="card bg-base-200 p-4">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="font-bold text-sm">{scenario.label}</h3>
            {#if result && !result.error}
              <span class="badge badge-sm" class:badge-success={result.coldMs < 500} class:badge-warning={result.coldMs >= 500 && result.coldMs < 2000} class:badge-error={result.coldMs >= 2000}>
                {result.coldMs}ms cold
              </span>
              <span class="badge badge-sm badge-outline" class:badge-success={result.warmMs < 100} class:badge-warning={result.warmMs >= 100}>
                {result.warmMs}ms warm
              </span>
              <span class="badge badge-ghost badge-sm">{result.rows} rows</span>
            {/if}
          </div>
          <p class="text-xs text-base-content/50 mb-2">{scenario.description}</p>

          {#if result}
            {#if result.error}
              <div class="alert alert-error text-xs py-1">{result.error}</div>
            {:else}
              <!-- SQL -->
              <details class="mb-2">
                <summary class="text-xs text-base-content/40 cursor-pointer hover:text-base-content/60">SQL</summary>
                <pre class="text-xs bg-base-300 rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap">{scenario.buildSQL(selectedCountry)}</pre>
              </details>

              <!-- Sample results -->
              {#if result.sample.length > 0}
                <details class="mb-2">
                  <summary class="text-xs text-base-content/40 cursor-pointer hover:text-base-content/60">Sample ({result.sample.length} of {result.rows})</summary>
                  <div class="overflow-x-auto mt-1">
                    <table class="table table-xs bg-base-300 rounded">
                      <thead>
                        <tr>
                          {#each Object.keys(result.sample[0]) as col}
                            <th class="text-xs">{col}</th>
                          {/each}
                        </tr>
                      </thead>
                      <tbody>
                        {#each result.sample as row}
                          <tr>
                            {#each Object.values(row) as val}
                              <td class="font-mono text-xs max-w-[200px] truncate">{val}</td>
                            {/each}
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                </details>
              {/if}

              <!-- EXPLAIN ANALYZE plan -->
              {#if showPlans && result.plan}
                <details open>
                  <summary class="text-xs text-primary cursor-pointer hover:text-primary/80 font-medium">EXPLAIN ANALYZE</summary>
                  <pre class="text-[11px] leading-tight bg-base-300 rounded p-3 mt-1 overflow-x-auto max-h-80 overflow-y-auto font-mono">{result.plan}</pre>
                </details>
              {/if}
            {/if}
          {:else if !queryRunning}
            <p class="text-xs opacity-30">Click "Run All Queries" to benchmark</p>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- ═══ Parquet Inspector Tab ═══ -->
  {#if activeTab === 'parquet'}
    <div class="space-y-4">
      <div class="flex items-center gap-3">
        <select class="select select-bordered select-sm" bind:value={parquetCountry} disabled={parquetRunning}>
          {#each TEST_COUNTRIES as cc}
            <option value={cc}>{cc}</option>
          {/each}
        </select>
        <button class="btn btn-primary btn-sm" onclick={inspectParquetFiles} disabled={parquetRunning}>
          {#if parquetRunning}
            <span class="loading loading-spinner loading-xs"></span>
            Inspecting...
          {:else}
            Inspect Files
          {/if}
        </button>
      </div>

      <p class="text-sm text-base-content/60">
        Reads Parquet file metadata and column statistics via <code class="text-xs">parquet_file_metadata()</code> and <code class="text-xs">parquet_metadata()</code>.
        Bloom filters enable row-group skipping for exact-match queries. Small row groups (ROW_GROUP_SIZE 2000) in number_index enable HTTP range-request pushdown (~150 KB per query).
      </p>

      {#each parquetResults as info}
        <div class="card bg-base-200 p-4">
          <div class="flex items-center gap-2 mb-2">
            <h3 class="font-bold text-sm">{info.label}</h3>
            {#if !info.error}
              <span class="badge badge-ghost badge-sm">{info.numRows.toLocaleString()} rows</span>
              <span class="badge badge-ghost badge-sm">{info.numRowGroups} row groups</span>
              <span class="badge badge-ghost badge-sm">{formatSize(info.fileSize)}</span>
              {#if info.numRowGroups > 1}
                <span class="badge badge-sm badge-outline">~{Math.round(info.numRows / info.numRowGroups)} rows/group</span>
              {/if}
            {/if}
          </div>

          {#if info.error}
            <div class="alert alert-error text-xs py-1">{info.error}</div>
          {:else if info.columns.length > 0}
            <div class="overflow-x-auto">
              <table class="table table-xs">
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Type</th>
                    <th>Compression</th>
                    <th>Bloom Filter</th>
                    <th>Avg bytes/val</th>
                  </tr>
                </thead>
                <tbody>
                  {#each info.columns as col}
                    <tr>
                      <td class="font-mono text-xs">{col.name}</td>
                      <td class="text-xs">{col.type}</td>
                      <td class="text-xs">{col.compression}</td>
                      <td>
                        {#if col.hasBloom}
                          <span class="badge badge-success badge-xs">Yes</span>
                        {:else}
                          <span class="badge badge-ghost badge-xs">No</span>
                        {/if}
                      </td>
                      <td class="font-mono text-xs">{col.avgSize}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </div>
      {/each}

      {#if parquetResults.length === 0 && !parquetRunning}
        <p class="text-sm opacity-40">Click "Inspect Files" to read Parquet metadata from S3</p>
      {/if}
    </div>
  {/if}

  <!-- Logs (always visible) -->
  {#if logs.length > 0}
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title font-bold text-sm">Logs ({logs.length} entries)</div>
      <div class="collapse-content">
        <pre class="text-xs bg-base-300 p-3 rounded max-h-60 overflow-y-auto">{logs.join('\n')}</pre>
      </div>
    </div>
  {/if}
</div>
