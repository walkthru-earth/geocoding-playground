<script lang="ts">
  import {
    queryObjects, queryObjectsWithRetry, tilePath, prefetchCountry, isCountryCached, onCacheLog, getTileSource, isTileCached,
    SearchCache, rankBySimilarity,
    getParser, stripJPCoordZone,
    esc, toArr, ms, addStep, updateLastStep, htmlEsc,
    // Smart autocomplete (core)
    suggest, classifyInput, resolveTiles, rankSuggestions,
    buildPostcodeSQL, buildStreetSQL, buildPostcodeNarrowSQL, buildStreetNarrowSQL, buildNumberIndexSQL,
  } from '@walkthru-earth/geocoding-core'
  import type { CityRow, SuggestRow, AddressRow, StepEntry, AutocompleteQueryFns, InputClassification } from '@walkthru-earth/geocoding-core'
  import MapView from '../lib/MapView.svelte'
  import SplitPane from '../lib/components/SplitPane.svelte'
  import StepLog from '../lib/components/StepLog.svelte'
  import ResultsTable from '../lib/components/ResultsTable.svelte'
  import { startGeocodeTour, shouldShowReverseHint, showReverseGeocodingHint } from '../lib/tour'
  import { track } from '../lib/analytics'

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
  let selectedCityTiles = $derived(selectedCity ? new Set(toArr(selectedCity.tiles)) : null)
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
  let limit = $state(5)
  let steps = $state<StepEntry[]>([])
  let cacheInfo = $state('')
  let mapView = $state<MapView>()

  let suggestTimer: ReturnType<typeof setTimeout> | null = null
  let searchGen = 0
  let autoGen = 0
  const cityCache = new SearchCache<CityRow[]>()
  const suggestCache = new SearchCache<SuggestRow[]>()

  $effect(() => {
    return () => { if (suggestTimer) clearTimeout(suggestTimer) }
  })

  function log(text: string, status?: StepEntry['status']) {
    steps = addStep(steps, text, status)
  }
  function updateLast(text: string, status?: StepEntry['status']) {
    steps = updateLastStep(steps, text, status)
  }

  // ── Smart autocomplete query functions (bridge core engine to DuckDB) ──

  const autoQueryFns: AutocompleteQueryFns = {
    async queryPostcodes(cc: string, query: string, cityTiles: string[]): Promise<SuggestRow[]> {
      const sql = buildPostcodeSQL(cc, query, cityTiles)
      const rows = await queryObjects<{ postcode: string; tiles: string[]; addr_count: number }>(sql)
      return rows.map((r: { postcode: string; tiles: string[]; addr_count: number }) => ({
        type: 'postcode' as const, label: r.postcode, tiles: r.tiles, addr_count: r.addr_count,
      }))
    },
    async queryStreets(cc: string, query: string, cityTiles: string[]): Promise<SuggestRow[]> {
      try {
        const sql = buildStreetSQL(cc, query, cityTiles)
        const rows = await queryObjects<{ street_lower: string; tiles: string[]; addr_count: number; primary_city: string }>(sql)
        return rows.map((r: { street_lower: string; tiles: string[]; addr_count: number; primary_city: string }) => ({
          type: 'street' as const, label: r.street_lower, tiles: r.tiles, addr_count: r.addr_count, primary_city: r.primary_city,
        }))
      } catch { return [] }
    },
    async queryAddresses(cc: string, street: string, numberPrefix: string, tiles: string[]): Promise<SuggestRow[]> {
      try {
        // Query number_index via HTTP range request (~150 KB with row-group pushdown).
        // The number_index stores all distinct house numbers per street as a sorted array.
        // DuckDB-WASM fetches only the row group containing this street, not the whole file.
        const sql = buildNumberIndexSQL(cc, street)
        const rows = await queryObjects<{ street_lower: string; numbers: string[] }>(sql)
        if (rows.length === 0) return []

        const prefix = numberPrefix.toLowerCase()
        const isJP = cc === 'JP'

        // JP numbers in the index are "banchi-coordZone" (e.g., "362-9") where
        // the suffix is an MLIT survey grid zone, not a real address part.
        // Strip it before matching and displaying.
        const matched = toArr(rows[0].numbers)
          .map((n: string) => isJP ? stripJPCoordZone(n) : n)
          .filter((n: string) => n.toLowerCase().startsWith(prefix))
          // Deduplicate: after stripping coord zones, "362-7" and "362-9" both become "362"
          .filter((n: string, i: number, arr: string[]) => arr.indexOf(n) === i)
          .slice(0, 10)

        return matched.map((n: string) => ({
          type: 'address' as const,
          label: `${street} ${n}`,
          tiles,
          addr_count: 1,
        }))
      } catch { return [] }
    },
  }

  let lastClassification = $state<InputClassification | null>(null)

  onCacheLog((msg: string) => { cacheInfo = msg })

  $effect(() => { loadCountries() })

  // When the user interacts with the map (click or user-initiated zoom) thinking
  // it's reverse geocoding, guide them to the Reverse page. Only shown once.
  // We check originalEvent to ignore programmatic zooms (fitBounds, flyTo).
  $effect(() => {
    const map = mapView?.getMap()
    if (!map) return
    function onMapClick() {
      if (shouldShowReverseHint()) showReverseGeocodingHint()
    }
    function onUserZoom(e: { originalEvent?: Event }) {
      if (e.originalEvent && shouldShowReverseHint()) showReverseGeocodingHint()
    }
    map.on('click', onMapClick)
    map.on('zoomstart', onUserZoom)
    return () => {
      map.off('click', onMapClick)
      map.off('zoomstart', onUserZoom)
    }
  })

  /** When user clicks a disabled field, show the full guided tour. */
  function onDisabledFieldClick() {
    if (!selectedCountry) startGeocodeTour()
  }

  async function loadCountries() {
    const rows = await queryObjects<{ country: string }>(`
      SELECT DISTINCT country
      FROM _manifest
      ORDER BY country
    `)
    countries = rows.map((r: { country: string }) => r.country)
  }

  /** Called when user picks a country ,prefetch indexes progressively.
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
    track('country_selected', { country: selectedCountry })

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
      onCitiesReady: (count: number) => {
        citiesReady = true
        cacheInfo = `${cc}: ${count} cities ready ,loading streets & postcodes...`
      },
    })
  }


  /** City autocomplete ,DuckDB SQL on cached in-memory table */
  async function searchCities() {
    if (!selectedCountry || cityQuery.length < 2) { cities = []; return }

    const cacheKey = `${selectedCountry}:${cityQuery.toLowerCase()}`
    const cached = cityCache.get(cacheKey)
    if (cached) {
      cities = rankBySimilarity(cached, cityQuery, (c: CityRow) => c.city)
      return
    }

    loadingCities = true
    try {
      const result = await queryObjects<CityRow>(`
        SELECT region, city,
               list_distinct(flatten(list(tiles))) AS tiles,
               sum(addr_count)::INTEGER AS addr_count,
               COALESCE(min(bbox_min_lon_e6), 0) AS bbox_min_lon_e6,
               COALESCE(max(bbox_max_lon_e6), 0) AS bbox_max_lon_e6,
               COALESCE(min(bbox_min_lat_e6), 0) AS bbox_min_lat_e6,
               COALESCE(max(bbox_max_lat_e6), 0) AS bbox_max_lat_e6
        FROM _cities_${selectedCountry}
        WHERE lower(city) LIKE '%${esc(cityQuery.toLowerCase())}%'
        GROUP BY region, city
        ORDER BY addr_count DESC LIMIT 20
      `)
      cityCache.set(cacheKey, result)
      cities = rankBySimilarity(result, cityQuery, (c: CityRow) => c.city)
    } catch (e: any) {
      error = e.message
    } finally {
      loadingCities = false
    }
  }

  function selectCity(city: CityRow) {
    track('city_selected', { city: city.city, region: city.region, country: selectedCountry })
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

  /** Address/postcode autocomplete via smart engine (core) with debounce */
  function autocomplete() {
    if (!selectedCountry || addressQuery.length < 2) { suggestions = []; lastClassification = null; return }
    if (suggestTimer) clearTimeout(suggestTimer)
    suggestTimer = setTimeout(() => doAutocomplete(), 150)
  }

  async function doAutocomplete() {
    if (!isCountryCached(selectedCountry)) return

    const gen = ++autoGen
    loadingSuggestions = true
    try {
      const { classification, suggestions: results } = await suggest(
        addressQuery,
        selectedCountry,
        selectedCity?.city ?? null,
        selectedCityTiles,
        autoQueryFns,
        suggestCache,
      )
      if (gen !== autoGen) return
      lastClassification = classification
      suggestions = results
    } catch (e: any) {
      console.warn('[autocomplete]', e.message)
      track('autocomplete_error', { country: selectedCountry, error: e.message })
      suggestions = []
    } finally {
      loadingSuggestions = false
    }
  }

  function selectSuggestion(s: SuggestRow) {
    track('suggestion_selected', { type: s.type, country: selectedCountry })
    selectedSuggestion = s
    addressQuery = s.label
    suggestions = []
    lastClassification = null

    // Address suggestions (street + number) are ready to search immediately
    if (s.type === 'address') {
      search()
    }
  }

  function getSearchTiles(): { tiles: string[]; source: string } {
    return resolveTiles(selectedSuggestion, selectedCity, selectedCityTiles)
  }

  async function runPreset(preset: { label: string; city: string; query: string }) {
    const cc = selectedCountry
    if (!cc) return
    track('preset_clicked', { preset: preset.label, country: cc })

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
      SELECT region, city,
             list_distinct(flatten(list(tiles))) AS tiles,
             sum(addr_count)::INTEGER AS addr_count
      FROM _cities_${cc}
      WHERE lower(city) = '${esc(preset.city.toLowerCase())}'
      GROUP BY region, city
      ORDER BY addr_count DESC LIMIT 1
    `)
    if (cityResults.length === 0) { updateLast(`Step 2  City not found!`, 'error'); return }
    const city = cityResults[0]
    selectedCity = city
    cityQuery = city.city
    updateLast(`Step 2  ${city.city} ,${toArr(city.tiles).length} tile(s), ${city.addr_count.toLocaleString()} addr (${ms(t0)})`, 'done')

    // Narrow via postcode or street index (from cache)
    t0 = performance.now()
    const q = preset.query.toLowerCase()
    const cls = classifyInput(q, cc)
    if (cls.hasPostcode || cls.mode === 'postcode') {
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
    const gen = ++searchGen
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
        const rows = await queryObjects<{ postcode: string; tiles: string[]; addr_count: number }>(buildPostcodeNarrowSQL(cc, parsed.postcode))
        if (rows.length > 0) {
          tiles = toArr(rows[0].tiles)
          source = `postcode "${rows[0].postcode}" (${rows[0].addr_count.toLocaleString()} addr)`
          log(`Narrow  Postcode ${rows[0].postcode} \u2192 ${tiles.length} tile(s) (${ms(t0)})`, 'done')
        }
      } catch { /* no postcode table */ }
    }

    // Try street narrowing if no postcode tiles (exact then prefix)
    if (tiles.length === 0 && parsed.street && isCountryCached(cc)) {
      const t0 = performance.now()
      try {
        let rows = await queryObjects<{ street_lower: string; tiles: string[]; addr_count: number }>(buildStreetNarrowSQL(cc, parsed.street, true))
        if (rows.length === 0) {
          rows = await queryObjects<{ street_lower: string; tiles: string[]; addr_count: number }>(buildStreetNarrowSQL(cc, parsed.street, false))
        }
        if (rows.length > 0) {
          tiles = toArr(rows[0].tiles)
          source = `street "${rows[0].street_lower}" (${rows[0].addr_count.toLocaleString()} addr)`
          log(`Narrow  Street "${rows[0].street_lower}" \u2192 ${tiles.length} tile(s) (${ms(t0)})`, 'done')
        }
      } catch { /* no street table */ }
    }

    // Intersect with city tiles if city is selected
    if (tiles.length > 0 && selectedCityTiles) {
      const intersected = tiles.filter((t: string) => selectedCityTiles.has(t))
      if (intersected.length > 0 && intersected.length < tiles.length) {
        log(`Narrow  City "${selectedCity!.city}" intersection: ${tiles.length} → ${intersected.length} tile(s)`, 'done')
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
        if (gen !== searchGen) return
        if (remaining <= 0) {
          log(`        Limit reached, skipping ${tiles.length - i} tile(s)`, 'done')
          break
        }
        const tile = tiles[i]
        const t0 = performance.now()
        log(`        ${tile} ,querying...`, 'loading')

        let tileResults: AddressRow[] = []
        try {
          // If tile is already cached, always use cache (free)
          // If query has specific filters, use direct remote read (filter pushdown = less data)
          // Otherwise, cache the full tile for subsequent queries
          let src: string
          let useRetry = false
          if (isTileCached(cc, tile)) {
            src = await getTileSource(cc, tile)
          } else if (hasSpecificFilters) {
            src = `read_parquet('${tilePath(cc, tile)}')`
            useRetry = true
          } else {
            src = await getTileSource(cc, tile)
          }

          const queryFn = useRetry ? queryObjectsWithRetry : queryObjects
          tileResults = await queryFn<AddressRow>(`
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
          updateLast(`        ${tile} ,failed (${ms(t0)})`, 'error')
          continue
        }

        if (gen !== searchGen) return
        results = [...results, ...tileResults].slice(0, limit)
        remaining = limit - results.length
        updateLast(`        ${tile} ,${tileResults.length} match${tileResults.length !== 1 ? 'es' : ''} (${ms(t0)})`, 'done')

        // Update map progressively ,only auto-fit on first batch
        updateMapMarkers(i === 0)
      }

      searchTime = performance.now() - totalT0
      log(`Done    ${results.length} results, total: ${ms(totalT0)}`, 'done')
      track('forward_geocode_search', {
        country: cc,
        result_count: results.length,
        duration_ms: Math.round(searchTime),
        tile_count: tiles.length,
        has_postcode: !!parsed.postcode,
        has_street: !!parsed.street,
        has_number: !!parsed.number,
      })
    } catch (e: any) {
      console.error('[geocode]', e)
      error = e.message
      log(`Error: ${e.message}`, 'error')
      track('forward_geocode_error', { country: cc, error: e.message })
    } finally {
      searching = false
    }
  }

  let userNavigated = false

  function resultPopupHtml(r: AddressRow, idx: number): string {
    const parts = [r.city, r.postcode].filter(Boolean).map(s => htmlEsc(s!)).join(' · ')
    return `<div class="popup-body">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span class="popup-badge popup-badge-primary">${idx + 1}</span>
        <span class="popup-title">${htmlEsc(r.full_address)}</span>
      </div>
      ${parts ? `<div class="popup-subtitle">${parts}</div>` : ''}
      <div class="popup-coords">${r.lat?.toFixed(5)}, ${r.lon?.toFixed(5)}</div>
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
    if (suggestTimer) { clearTimeout(suggestTimer); suggestTimer = null }
    suggestions = []
    cities = []
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
  <div class="p-3 md:p-6 space-y-4 md:space-y-5">
    <!-- Header row -->
    <div class="flex items-center gap-2 md:gap-3 flex-wrap">
      <h2 class="text-lg md:text-xl font-bold tracking-tight flex-1 min-w-0">Forward Geocode</h2>
      <button class="btn btn-ghost btn-xs btn-circle opacity-40 hover:opacity-100" onclick={startGeocodeTour} aria-label="Show guided tour">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
      <select id="tour-country-select" class="select select-bordered select-sm md:select-md w-28 md:w-40" bind:value={selectedCountry} onchange={onCountryChange}>
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
      <div class="text-xs md:text-sm text-base-content/50 -mt-2 md:-mt-3 break-words">{cacheInfo}</div>
    {/if}

    <!-- Presets -->
    {#if activePresets.length > 0}
      <div id="tour-presets" class="flex gap-2 overflow-x-auto scrollbar-thin pb-1">
        {#each activePresets as p}
          <button class="preset-pill" onclick={() => runPreset(p)} disabled={searching || prefetching}>{p.label}</button>
        {/each}
      </div>
    {/if}

    <!-- Search fields -->
    <div class="space-y-3">
      <div class="relative">
        <input
          type="text"
          class="input input-bordered input-sm md:input-md w-full"
          id="tour-city-input"
          placeholder="City (optional)..."
          bind:value={cityQuery}
          oninput={() => searchCities()}
          disabled={!selectedCountry || !citiesReady}
        />
        {#if !selectedCountry}
          <div class="absolute inset-0 cursor-pointer" role="button" tabindex="0" aria-label="Select a country first" onclick={onDisabledFieldClick} onkeydown={(e) => e.key === 'Enter' && onDisabledFieldClick()}></div>
        {/if}
        {#if loadingCities}
          <span class="loading loading-spinner loading-sm absolute right-3 top-3"></span>
        {/if}
        {#if cities.length > 0}
          <ul class="menu bg-base-200 rounded-lg shadow-xl absolute z-50 w-full mt-1 max-h-60 overflow-y-auto border border-base-content/10">
            {#each cities as city}
              <li>
                <button class="flex items-center gap-2 min-w-0" onclick={() => selectCity(city)}>
                  <span class="font-bold truncate">{city.city}</span>
                  {#if city.region}<span class="text-xs opacity-40 shrink-0">{city.region}</span>{/if}
                  <span class="badge badge-sm badge-ghost ml-auto shrink-0">{city.addr_count.toLocaleString()}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="relative">
        <input
          type="text"
          class="input input-bordered input-sm md:input-md w-full"
          id="tour-address-input"
          placeholder="Street, postcode, or address..."
          bind:value={addressQuery}
          oninput={() => { selectedSuggestion = null; autocomplete() }}
          onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && search()}
          disabled={!selectedCountry || prefetching}
        />
        {#if !selectedCountry}
          <div class="absolute inset-0 cursor-pointer" role="button" tabindex="0" aria-label="Select a country first" onclick={onDisabledFieldClick} onkeydown={(e) => e.key === 'Enter' && onDisabledFieldClick()}></div>
        {/if}
        {#if loadingSuggestions}
          <span class="loading loading-spinner loading-sm absolute right-3 top-3"></span>
        {/if}
        {#if suggestions.length > 0}
          <ul class="menu bg-base-200 rounded-lg shadow-xl absolute z-50 w-full mt-1 max-h-60 overflow-y-auto border border-base-content/10">
            {#each suggestions as s}
              {@const tiles = toArr(s.tiles)}
              {@const tileCount = tiles.length}
              {@const cityNameMatch = selectedCity && s.primary_city && s.primary_city.toLowerCase() === selectedCity.city.toLowerCase()}
              {@const cityTileMatch = !cityNameMatch && selectedCityTiles && s.tiles && tiles.some((t: string) => selectedCityTiles.has(t))}
              {@const isInCity = cityNameMatch || cityTileMatch}
              <li>
                <button class="flex items-center gap-1.5 min-w-0" onclick={() => selectSuggestion(s)}>
                  <span class="badge badge-sm rounded-full shrink-0" class:badge-primary={s.type === 'street'} class:badge-secondary={s.type === 'postcode'} class:badge-accent={s.type === 'address'}>{s.type === 'address' ? '↵' : s.type}</span>
                  <span class="font-bold truncate">{s.label}</span>
                  {#if isInCity && selectedCity}
                    <span class="text-xs shrink-0 max-w-[8rem] truncate text-secondary">{selectedCity.city}</span>
                  {:else if s.primary_city}
                    <span class="text-xs shrink-0 max-w-[8rem] truncate opacity-40">{s.primary_city}</span>
                  {/if}
                  <span class="badge badge-sm badge-ghost ml-auto shrink-0">{tileCount}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="relative flex gap-2">
        <select class="select select-bordered select-sm md:select-md w-20 md:w-24" bind:value={limit}>
          <option value={5}>5</option>
          <option value={10}>10</option>
          <option value={20}>20</option>
          <option value={40}>40</option>
          <option value={80}>80</option>
        </select>
        <button id="tour-search-btn" class="btn btn-primary btn-sm md:btn-md rounded-full flex-1" onclick={search} disabled={!selectedCountry || addressQuery.length < 2 || searching || prefetching}>
          {#if searching}
            <span class="loading loading-spinner loading-sm"></span>
          {:else}
            Search
          {/if}
        </button>
        {#if !selectedCountry}
          <div class="absolute inset-0 cursor-pointer" role="button" tabindex="0" aria-label="Select a country first" onclick={onDisabledFieldClick} onkeydown={(e) => e.key === 'Enter' && onDisabledFieldClick()}></div>
        {/if}
      </div>
    </div>

    <!-- Context badges -->
    {#if selectedCity || selectedSuggestion || (cacheInfo && !prefetching)}
      <div class="flex flex-col sm:flex-row flex-wrap gap-1.5 md:gap-2">
        {#if cacheInfo && !prefetching}
          <span class="text-xs text-base-content/40 border border-base-content/10 rounded-lg px-2.5 py-1 leading-snug">{cacheInfo}</span>
        {/if}
        {#if selectedCity}
          <span class="badge badge-sm badge-info whitespace-nowrap">{selectedCity.city} · {selectedCityTiles?.size ?? 0} tiles</span>
        {/if}
        {#if selectedSuggestion}
          {@const sugTileCount = toArr(selectedSuggestion.tiles).length}
          <span class="badge badge-sm whitespace-nowrap" class:badge-primary={selectedSuggestion.type === 'street'} class:badge-secondary={selectedSuggestion.type === 'postcode'}>
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
