<script lang="ts">
  import { queryObjects, tilePath, prefetchCountry, isCountryCached, onCacheLog, getTileSource, isTileCached } from '../lib/duckdb'
  import MapView from '../lib/MapView.svelte'
  import SplitPane from '../lib/components/SplitPane.svelte'
  import StepLog from '../lib/components/StepLog.svelte'
  import ResultsTable from '../lib/components/ResultsTable.svelte'
  import { SearchCache, rankBySimilarity } from '../lib/search'
  import { getParser } from '../lib/address-parser'
  import { esc, toArr, ms, addStep, updateLastStep } from '../lib/utils'
  import type { CityRow, SuggestRow, AddressRow, StepEntry } from '../lib/types'

  const presetsByCountry: Record<string, { label: string; city: string; query: string }[]> = {
    NL: [
      { label: 'Keizersgracht 185', city: 'Amsterdam', query: 'keizersgracht 185' },
      { label: '1016 (postcode)', city: 'Amsterdam', query: '1016' },
      { label: 'Prinsengracht', city: 'Amsterdam', query: 'prinsengracht' },
    ],
    US: [
      { label: 'Broadway NYC', city: 'New York', query: 'broadway' },
      { label: 'Michigan Ave Chicago', city: 'CHICAGO', query: 'michigan avenue' },
      { label: '5th Avenue NYC', city: 'New York', query: '5th avenue' },
    ],
    DE: [
      { label: 'Hauptstraße Hamburg', city: 'Hamburg', query: 'hauptstraße' },
      { label: 'Friedrichstraße Köln', city: 'Köln', query: 'friedrichstraße' },
      { label: 'Berliner Straße Bremen', city: 'Bremen', query: 'berliner straße' },
    ],
    FR: [
      { label: 'Champs Elysées', city: 'Paris 8e Arrondissement', query: 'avenue des champs' },
      { label: 'Rue de Rivoli', city: 'Paris 1er Arrondissement', query: 'rue de rivoli' },
      { label: 'Bd Haussmann', city: 'Paris 9e Arrondissement', query: 'boulevard haussmann' },
    ],
    IT: [
      { label: 'Via del Corso Roma', city: 'Roma', query: 'via del corso' },
      { label: 'Via Roma', city: 'Roma', query: 'via roma' },
      { label: 'Corso Buenos Aires Milano', city: 'Milano', query: 'corso buenos aires' },
    ],
    ES: [
      { label: 'Gran Via Barcelona', city: 'Barcelona', query: 'gran via' },
      { label: 'Rambla Barcelona', city: 'Barcelona', query: 'rambla' },
      { label: 'Castellana Madrid', city: 'Madrid', query: 'paseo de' },
    ],
    BR: [
      { label: 'Av Paulista SP', city: 'São Paulo', query: 'avenida paulista' },
      { label: 'Rua Augusta SP', city: 'São Paulo', query: 'rua augusta' },
    ],
    AU: [
      { label: 'George St Sydney', city: 'SYDNEY', query: 'george street' },
      { label: 'Collins St Melbourne', city: 'MELBOURNE', query: 'collins street' },
    ],
    CA: [
      { label: 'King St Toronto', city: 'Toronto', query: 'king street' },
    ],
    JP: [
      { label: '本郷', city: '岐阜市', query: '本郷' },
    ],
  }

  let countries = $state<string[]>([])
  let selectedCountry = $state('')
  let activePresets = $derived(presetsByCountry[selectedCountry] ?? [])
  let cityQuery = $state('')
  let cities = $state<CityRow[]>([])
  let selectedCity = $state<CityRow | null>(null)
  let addressQuery = $state('')
  let suggestions = $state<SuggestRow[]>([])
  let selectedSuggestion = $state<SuggestRow | null>(null)
  let results = $state<AddressRow[]>([])
  let searching = $state(false)
  let loadingCities = $state(false)
  let loadingSuggestions = $state(false)
  let prefetching = $state(false)
  let citiesReady = $state(false)
  let error = $state('')
  let searchTime = $state(0)
  let limit = $state(10)
  let steps = $state<StepEntry[]>([])
  let cacheInfo = $state('')
  let mapView = $state<MapView>()

  let suggestTimer: ReturnType<typeof setTimeout> | null = null
  const cityCache = new SearchCache<CityRow[]>()
  const suggestCache = new SearchCache<SuggestRow[]>()

  function log(text: string, status?: StepEntry['status']) {
    steps = addStep(steps, text, status)
  }
  function updateLast(text: string, status?: StepEntry['status']) {
    steps = updateLastStep(steps, text, status)
  }

  // ── Country-aware input parsing (delegated to address-parser module) ──

  function looksLikePostcode(q: string, cc: string): boolean {
    return getParser(cc).extractPostcode(q.trim()) !== null
  }

  onCacheLog((msg) => { cacheInfo = msg })

  $effect(() => { loadCountries() })

  async function loadCountries() {
    const rows = await queryObjects<{ country: string }>(`
      SELECT DISTINCT country
      FROM _manifest
      ORDER BY country
    `)
    countries = rows.map(r => r.country)
  }

  /** Called when user picks a country — prefetch indexes progressively.
   *  Cities load first → city field unlocks → streets/postcodes load in background. */
  async function onCountryChange() {
    selectedCity = null
    cities = []
    results = []
    steps = []
    suggestions = []
    selectedSuggestion = null
    cacheInfo = ''
    citiesReady = false
    cityCache.clear()
    suggestCache.clear()
    mapView?.clearResultMarkers()

    if (!selectedCountry) return

    if (isCountryCached(selectedCountry)) {
      citiesReady = true
      cacheInfo = `${selectedCountry}: indexes already cached`
      return
    }

    prefetching = true
    await prefetchCountryProgressive(selectedCountry)
    prefetching = false
  }

  /** Prefetch using shared duckdb.ts logic with progressive city unlock. */
  async function prefetchCountryProgressive(cc: string) {
    if (isCountryCached(cc)) { citiesReady = true; return }
    await prefetchCountry(cc, {
      onCitiesReady: (count) => {
        citiesReady = true
        cacheInfo = `${cc}: ${count} cities ready — loading streets & postcodes...`
      },
    })
  }


  /** City autocomplete — DuckDB SQL on cached in-memory table */
  async function searchCities() {
    if (!selectedCountry || cityQuery.length < 2) { cities = []; return }

    const cacheKey = `${selectedCountry}:${cityQuery.toLowerCase()}`
    const cached = cityCache.get(cacheKey)
    if (cached) {
      cities = rankBySimilarity(cached, cityQuery, c => c.city)
      return
    }

    loadingCities = true
    try {
      const result = await queryObjects<CityRow>(`
        SELECT region, city, tiles, addr_count,
               COALESCE(bbox_min_lon_e6, 0) AS bbox_min_lon_e6,
               COALESCE(bbox_max_lon_e6, 0) AS bbox_max_lon_e6,
               COALESCE(bbox_min_lat_e6, 0) AS bbox_min_lat_e6,
               COALESCE(bbox_max_lat_e6, 0) AS bbox_max_lat_e6
        FROM _cities_${selectedCountry}
        WHERE lower(city) LIKE '%${esc(cityQuery.toLowerCase())}%'
        ORDER BY addr_count DESC LIMIT 20
      `)
      cityCache.set(cacheKey, result)
      cities = rankBySimilarity(result, cityQuery, c => c.city)
    } catch (e: any) {
      error = e.message
    } finally {
      loadingCities = false
    }
  }

  function selectCity(city: CityRow) {
    selectedCity = city
    cityQuery = city.city
    cities = []
    selectedSuggestion = null
    suggestions = []
    results = []
    steps = []
    // Zoom map to city bbox if available
    if (city.bbox_min_lon_e6 && city.bbox_max_lat_e6 && mapView) {
      const pad = 0.01
      const minLon = (city.bbox_min_lon_e6 ?? 0) / 1e6 - pad
      const minLat = (city.bbox_min_lat_e6 ?? 0) / 1e6 - pad
      const maxLon = (city.bbox_max_lon_e6 ?? 0) / 1e6 + pad
      const maxLat = (city.bbox_max_lat_e6 ?? 0) / 1e6 + pad
      mapView.getMap()?.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 40 })
    }
  }

  /** Address/postcode autocomplete — DuckDB SQL on cached tables with debounce */
  function autocomplete() {
    if (!selectedCountry || addressQuery.length < 2) { suggestions = []; return }
    if (suggestTimer) clearTimeout(suggestTimer)
    suggestTimer = setTimeout(() => doAutocomplete(), 150)
  }

  async function doAutocomplete() {
    const q = addressQuery.trim().toLowerCase()
    const cc = selectedCountry

    const cacheKey = `${cc}:${q}`
    const cached = suggestCache.get(cacheKey)
    if (cached) {
      suggestions = rankBySimilarity(cached, q, s => s.label)
      return
    }

    loadingSuggestions = true
    try {
      const result: SuggestRow[] = []

      if (isCountryCached(cc)) {
        if (looksLikePostcode(q, cc)) {
          const rows = await queryObjects<{ postcode: string; tiles: string[]; addr_count: number }>(`
            SELECT postcode, tiles, addr_count FROM _postcodes_${cc}
            WHERE lower(postcode) LIKE '${esc(q)}%'
            ORDER BY addr_count DESC LIMIT 15
          `)
          rows.forEach(r => result.push({ type: 'postcode', label: r.postcode, tiles: r.tiles, addr_count: r.addr_count }))
        }

        // Always search streets too
        try {
          const rows = await queryObjects<{ street_lower: string; tiles: string[]; addr_count: number; primary_city: string }>(`
            SELECT street_lower, tiles, addr_count, primary_city FROM _streets_${cc}
            WHERE street_lower LIKE '${esc(q)}%'
            ORDER BY addr_count DESC LIMIT 15
          `)
          rows.forEach(r => result.push({ type: 'street', label: r.street_lower, tiles: r.tiles, addr_count: r.addr_count, primary_city: r.primary_city }))
        } catch { /* street table not available */ }
      }

      suggestCache.set(cacheKey, result)
      suggestions = rankBySimilarity(result, q, s => s.label)
    } catch (e: any) {
      console.warn('[autocomplete]', e.message)
      suggestions = []
    } finally {
      loadingSuggestions = false
    }
  }

  function selectSuggestion(s: SuggestRow) {
    selectedSuggestion = s
    addressQuery = s.label
    suggestions = []
  }

  function getSearchTiles(): { tiles: string[]; source: string } {

    if (selectedSuggestion) {
      const tiles = toArr(selectedSuggestion.tiles)
      if (selectedCity) {
        const cityTiles = new Set(toArr(selectedCity.tiles))
        const intersected = tiles.filter(t => cityTiles.has(t))
        if (intersected.length > 0) return { tiles: intersected, source: `${selectedSuggestion.type} ∩ city` }
      }
      return { tiles, source: `${selectedSuggestion.type} "${selectedSuggestion.label}"` }
    }
    if (selectedCity) return { tiles: toArr(selectedCity.tiles), source: `city "${selectedCity.city}"` }
    return { tiles: [], source: 'none' }
  }

  async function runPreset(preset: { label: string; city: string; query: string }) {
    const cc = selectedCountry
    if (!cc) return

    steps = []
    error = ''
    results = []
    selectedSuggestion = null
    addressQuery = preset.query
    mapView?.clearResultMarkers()

    // Ensure country is cached
    if (!isCountryCached(cc)) {
      log(`Step 1  Caching ${cc} indexes...`, 'loading')
      prefetching = true
      const info = await prefetchCountry(cc)
      prefetching = false
      citiesReady = true
      updateLast(`Step 1  ${cc} cached: ${info.cities} cities, ${info.postcodes} postcodes, ${info.streets} streets`, 'done')
    } else {
      log(`Step 1  ${cc} indexes already cached`, 'done')
    }

    // Find city from cache
    let t0 = performance.now()
    log(`Step 2  Looking up "${preset.city}"...`, 'loading')
    const cityResults = await queryObjects<CityRow>(`
      SELECT region, city, tiles, addr_count FROM _cities_${cc}
      WHERE lower(city) = '${esc(preset.city.toLowerCase())}'
      ORDER BY addr_count DESC LIMIT 1
    `)
    if (cityResults.length === 0) { updateLast(`Step 2  City not found!`, 'error'); return }
    const city = cityResults[0]
    selectedCity = city
    cityQuery = city.city
    updateLast(`Step 2  ${city.city} — ${toArr(city.tiles).length} tile(s), ${city.addr_count.toLocaleString()} addr (${ms(t0)})`, 'done')

    // Narrow via postcode or street index (from cache)
    t0 = performance.now()
    const q = preset.query.toLowerCase()
    if (looksLikePostcode(q, cc)) {
      log(`Step 3  Narrowing via postcodes for "${q}"...`, 'loading')
      const rows = await queryObjects<{ postcode: string; tiles: string[]; addr_count: number }>(`
        SELECT postcode, tiles, addr_count FROM _postcodes_${cc}
        WHERE lower(postcode) LIKE '${esc(q)}%'
        ORDER BY addr_count DESC LIMIT 1
      `)
      if (rows.length > 0) {
        selectedSuggestion = { type: 'postcode', label: rows[0].postcode, tiles: rows[0].tiles, addr_count: rows[0].addr_count }
        updateLast(`Step 3  Postcode "${rows[0].postcode}" → ${toArr(rows[0].tiles).length} tile(s) (${ms(t0)})`, 'done')
      } else {
        updateLast(`Step 3  No postcode match, using city tiles (${ms(t0)})`, 'done')
      }
    } else {
      log(`Step 3  Narrowing via streets for "${q.split(/\s+/)[0]}"...`, 'loading')
      try {
        const rows = await queryObjects<{ street_lower: string; tiles: string[]; addr_count: number }>(`
          SELECT street_lower, tiles, addr_count FROM _streets_${cc}
          WHERE street_lower LIKE '${esc(q.split(/\s+/)[0])}%'
          ORDER BY addr_count DESC LIMIT 1
        `)
        if (rows.length > 0) {
          selectedSuggestion = { type: 'street', label: rows[0].street_lower, tiles: rows[0].tiles, addr_count: rows[0].addr_count }
          updateLast(`Step 3  Street "${rows[0].street_lower}" → ${toArr(rows[0].tiles).length} tile(s) (${ms(t0)})`, 'done')
        } else {
          updateLast(`Step 3  No street match, using city tiles (${ms(t0)})`, 'done')
        }
      } catch {
        updateLast(`Step 3  street_index not deployed, using city tiles (${ms(t0)})`, 'done')
      }
    }

    await searchDirect()
  }

  async function searchDirect() {
    if (addressQuery.length < 2) return
    searching = true
    error = ''
    results = []
    searchTime = 0
    userNavigated = false

    const cc = selectedCountry
    const parser = getParser(cc)
    const parsed = parser.parseAddress(addressQuery)
    const where = parser.buildWhereClause(parsed)

    // Show what the parser detected
    const detected: string[] = []
    if (parsed.postcode) detected.push(`postcode=${parsed.postcode}`)
    if (parsed.street) detected.push(`street="${parsed.street}"`)
    if (parsed.number) detected.push(`number=${parsed.number}`)
    if (parsed.unit) detected.push(`unit=${parsed.unit}`)
    if (detected.length > 0) {
      log(`Parse   ${detected.join(', ')}`, 'done')
    }

    // Auto-narrow tiles using parsed fields (postcode → street → city fallback)
    let tiles: string[] = []
    let source = 'none'

    // Try postcode narrowing first
    if (parsed.postcode && isCountryCached(cc)) {
      const t0 = performance.now()
      try {
        const rows = await queryObjects<{ postcode: string; tiles: string[]; addr_count: number }>(`
          SELECT postcode, tiles, addr_count FROM _postcodes_${cc}
          WHERE lower(postcode) = '${esc(parsed.postcode.toLowerCase())}'
          LIMIT 1
        `)
        if (rows.length > 0) {
          tiles = toArr(rows[0].tiles)
          source = `postcode "${rows[0].postcode}" (${rows[0].addr_count.toLocaleString()} addr)`
          log(`Narrow  Postcode ${rows[0].postcode} → ${tiles.length} tile(s) (${ms(t0)})`, 'done')
        }
      } catch { /* no postcode table */ }
    }

    // Try street narrowing if no postcode tiles
    // Use full street name first for exact match, fall back to first word for prefix
    if (tiles.length === 0 && parsed.street && isCountryCached(cc)) {
      const t0 = performance.now()
      const streetFull = parsed.street.toLowerCase()
      try {
        // Try exact match first
        let rows = await queryObjects<{ street_lower: string; tiles: string[]; addr_count: number }>(`
          SELECT street_lower, tiles, addr_count FROM _streets_${cc}
          WHERE street_lower = '${esc(streetFull)}'
          LIMIT 1
        `)
        // Fall back to prefix match with full street name
        if (rows.length === 0) {
          rows = await queryObjects<{ street_lower: string; tiles: string[]; addr_count: number }>(`
            SELECT street_lower, tiles, addr_count FROM _streets_${cc}
            WHERE street_lower LIKE '${esc(streetFull)}%'
            ORDER BY addr_count DESC LIMIT 1
          `)
        }
        if (rows.length > 0) {
          tiles = toArr(rows[0].tiles)
          source = `street "${rows[0].street_lower}" (${rows[0].addr_count.toLocaleString()} addr)`
          log(`Narrow  Street "${rows[0].street_lower}" → ${tiles.length} tile(s) (${ms(t0)})`, 'done')
        }
      } catch { /* no street table */ }
    }

    // Intersect with city tiles if city is selected
    if (tiles.length > 0 && selectedCity) {
      const cityTiles = new Set(toArr(selectedCity.tiles))
      const intersected = tiles.filter(t => cityTiles.has(t))
      if (intersected.length > 0 && intersected.length < tiles.length) {
        log(`Narrow  City "${selectedCity.city}" intersection: ${tiles.length} → ${intersected.length} tile(s)`, 'done')
        tiles = intersected
        source += ` ∩ city`
      }
    }

    // Fallback: use manually selected suggestion or city tiles
    if (tiles.length === 0) {
      const manual = getSearchTiles()
      tiles = manual.tiles
      source = manual.source
    }

    if (tiles.length === 0) {
      error = 'No tiles to search. Select a city or pick a suggestion.'
      searching = false
      return
    }

    const totalT0 = performance.now()
    let remaining = limit

    // Decide strategy: use filter pushdown on remote file (fast for specific queries)
    // or use cached tile (fast for broad/repeated queries)
    const hasSpecificFilters = !!(parsed.postcode || (parsed.street && parsed.number))

    log(`Search  ${tiles.length} tile(s) via ${source}`)
    log(`SQL     WHERE ${where}`, undefined)
    if (hasSpecificFilters) {
      log(`Mode    Direct query with Parquet filter pushdown (~3 MB vs ~48 MB)`, undefined)
    }

    try {
      for (let i = 0; i < tiles.length; i++) {
        if (remaining <= 0) {
          log(`        Limit reached, skipping ${tiles.length - i} tile(s)`, 'done')
          break
        }
        const tile = tiles[i]
        const t0 = performance.now()
        log(`        ${tile} — querying...`, 'loading')

        let tileResults: AddressRow[] = []
        try {
          // If tile is already cached, always use cache (free)
          // If query has specific filters, use direct remote read (filter pushdown = less data)
          // Otherwise, cache the full tile for subsequent queries
          let src: string
          if (isTileCached(cc, tile)) {
            src = await getTileSource(cc, tile)
          } else if (hasSpecificFilters) {
            src = `read_parquet('${tilePath(cc, tile)}')`
          } else {
            src = await getTileSource(cc, tile)
          }

          tileResults = await queryObjects<AddressRow>(`
            SELECT full_address, street, number, city, region, postcode,
                   ST_Y(geometry) AS lat,
                   ST_X(geometry) AS lon,
                   h3_h3_to_string(h3_index) AS h3_index
            FROM ${src}
            WHERE ${where}
            LIMIT ${remaining}
          `)
        } catch (tileErr: any) {
          console.warn(`[geocode] Tile ${tile} failed:`, tileErr.message)
          updateLast(`        ${tile} — failed (${ms(t0)})`, 'error')
          continue
        }

        results = [...results, ...tileResults].slice(0, limit)
        remaining = limit - results.length
        updateLast(`        ${tile} — ${tileResults.length} match${tileResults.length !== 1 ? 'es' : ''} (${ms(t0)})`, 'done')

        // Update map progressively — only auto-fit on first batch
        updateMapMarkers(i === 0)
      }

      searchTime = performance.now() - totalT0
      log(`Done    ${results.length} results, total: ${ms(totalT0)}`, 'done')
    } catch (e: any) {
      console.error('[geocode]', e)
      error = e.message
      log(`Error: ${e.message}`, 'error')
    } finally {
      searching = false
    }
  }

  let userNavigated = false

  function resultPopupHtml(r: AddressRow, idx: number): string {
    const parts = [r.city, r.postcode].filter(Boolean).join(' · ')
    return `<div style="font-family:'Quicksand',sans-serif;line-height:1.6;padding:2px 0">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="background:#36d399;color:#0a2018;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">${idx + 1}</span>
        <span style="font-weight:700;font-size:14px">${r.full_address}</span>
      </div>
      ${parts ? `<div style="font-size:13px;opacity:0.6;margin-left:32px">${parts}</div>` : ''}
      <div style="font-size:11px;font-family:monospace;opacity:0.3;margin-left:32px;margin-top:3px">${r.lat?.toFixed(5)}, ${r.lon?.toFixed(5)}</div>
    </div>`
  }

  /** Update markers progressively. Only auto-fit on first batch unless user clicked a row. */
  function updateMapMarkers(isFirstBatch: boolean) {
    if (!mapView || results.length === 0) return
    const points = results.filter(r => r.lat && r.lon).map((r, i) => ({
      lng: r.lon,
      lat: r.lat,
      popupHtml: resultPopupHtml(r, i),
    }))
    const shouldFit = isFirstBatch && !userNavigated
    mapView.setResultMarkers(points, shouldFit)
  }

  function flyToResult(r: AddressRow) {
    if (!mapView || !r.lat || !r.lon) return
    userNavigated = true
    const idx = results.indexOf(r)
    mapView.openResultPopup(idx)
  }

  async function search() {
    steps = []
    mapView?.clearResultMarkers()
    if (isCountryCached(selectedCountry)) {
      log(`Step 1  ${selectedCountry} indexes cached`, 'done')
    }
    if (selectedCity) log(`Step 2  City: ${selectedCity.city}`, 'done')
    if (selectedSuggestion) log(`Step 3  ${selectedSuggestion.type}: ${selectedSuggestion.label}`, 'done')
    await searchDirect()
  }
</script>

<SplitPane>
  {#snippet left()}
  <div class="p-6 space-y-5">
    <!-- Header row -->
    <div class="flex items-center gap-3">
      <h2 class="text-xl font-bold tracking-tight flex-1">Forward Geocode</h2>
      <select class="select select-bordered w-40" bind:value={selectedCountry} onchange={onCountryChange}>
        <option value="">Country...</option>
        {#each countries as c}
          <option value={c}>{c}{isCountryCached(c) ? ' ✓' : ''}</option>
        {/each}
      </select>
      {#if prefetching}
        <span class="loading loading-spinner loading-sm text-primary"></span>
      {/if}
    </div>

    {#if cacheInfo && prefetching}
      <div class="text-sm text-base-content/50 -mt-3">{cacheInfo}</div>
    {/if}

    <!-- Presets -->
    {#if activePresets.length > 0}
      <div class="flex gap-2 flex-wrap">
        {#each activePresets as p}
          <button class="btn btn-sm rounded-full border-base-content/10 bg-base-content/[0.04] hover:bg-primary/10 hover:border-primary/20 hover:text-primary text-base-content/60 transition-all" onclick={() => runPreset(p)} disabled={searching || prefetching}>{p.label}</button>
        {/each}
      </div>
    {/if}

    <!-- Search fields -->
    <div class="space-y-3">
      <div class="relative">
        <input
          type="text"
          class="input input-bordered w-full"
          placeholder="City (optional)..."
          bind:value={cityQuery}
          oninput={() => searchCities()}
          disabled={!selectedCountry || !citiesReady}
        />
        {#if loadingCities}
          <span class="loading loading-spinner loading-sm absolute right-3 top-3"></span>
        {/if}
        {#if cities.length > 0}
          <ul class="menu bg-base-200 rounded-lg shadow-xl absolute z-50 w-full mt-1 max-h-60 overflow-y-auto border border-base-content/10">
            {#each cities as city}
              <li>
                <button onclick={() => selectCity(city)}>
                  <span class="font-bold">{city.city}</span>
                  {#if city.region}<span class="text-sm opacity-40">{city.region}</span>{/if}
                  <span class="badge badge-sm badge-ghost ml-auto">{city.addr_count.toLocaleString()}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="relative">
        <input
          type="text"
          class="input input-bordered w-full"
          placeholder="Street name, postcode, or address..."
          bind:value={addressQuery}
          oninput={() => { selectedSuggestion = null; autocomplete() }}
          onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && search()}
          disabled={!selectedCountry || prefetching}
        />
        {#if loadingSuggestions}
          <span class="loading loading-spinner loading-sm absolute right-3 top-3"></span>
        {/if}
        {#if suggestions.length > 0}
          <ul class="menu bg-base-200 rounded-lg shadow-xl absolute z-50 w-full mt-1 max-h-60 overflow-y-auto border border-base-content/10">
            {#each suggestions as s}
              {@const tileCount = toArr(s.tiles).length}
              <li>
                <button onclick={() => selectSuggestion(s)}>
                  <span class="badge badge-sm rounded-full" class:badge-primary={s.type === 'street'} class:badge-secondary={s.type === 'postcode'}>{s.type}</span>
                  <span class="font-bold">{s.label}</span>
                  {#if s.primary_city}<span class="text-sm opacity-40">{s.primary_city}</span>{/if}
                  <span class="badge badge-sm badge-ghost ml-auto">{tileCount}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="flex gap-2">
        <select class="select select-bordered w-24" bind:value={limit}>
          <option value={10}>10</option>
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
        <button class="btn btn-primary rounded-full flex-1" onclick={search} disabled={!selectedCountry || addressQuery.length < 2 || searching || prefetching}>
          {#if searching}
            <span class="loading loading-spinner loading-sm"></span>
          {:else}
            Search
          {/if}
        </button>
      </div>
    </div>

    <!-- Context badges -->
    {#if selectedCity || selectedSuggestion || (cacheInfo && !prefetching)}
      <div class="flex flex-wrap gap-2">
        {#if cacheInfo && !prefetching}
          <span class="badge badge-sm badge-outline">{cacheInfo}</span>
        {/if}
        {#if selectedCity}
          <span class="badge badge-sm badge-info">{selectedCity.city} · {toArr(selectedCity.tiles).length} tiles</span>
        {/if}
        {#if selectedSuggestion}
          {@const sugTileCount = toArr(selectedSuggestion.tiles).length}
          <span class="badge badge-sm" class:badge-primary={selectedSuggestion.type === 'street'} class:badge-secondary={selectedSuggestion.type === 'postcode'}>
            {selectedSuggestion.label} → {sugTileCount} tile{sugTileCount > 1 ? 's' : ''}
          </span>
        {/if}
      </div>
    {/if}

    <!-- Step log -->
    <StepLog {steps} />

    {#if error}
      <div role="alert" class="alert alert-error">{error}</div>
    {/if}

    <!-- Results -->
    <ResultsTable
      {results}
      {searchTime}
      onRowClick={flyToResult}
      emptyMessage={!searching && addressQuery.length > 1 && (selectedCity || selectedSuggestion) ? 'No results yet. Hit search or press Enter.' : ''}
    />
  </div>
  {/snippet}

  {#snippet right()}
    <MapView bind:this={mapView} class="h-full w-full" />
  {/snippet}
</SplitPane>
