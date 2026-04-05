<script lang="ts">
  import {
    queryObjects, queryObjectsWithRetry, tilePath, prefetchCountry, isCountryCached, onCacheLog,
    getTileSource, isTileCached, expandTilesToBucketGroups, tileSourceExpr,
    cancelPendingQuery, getCountryTable,
    SearchCache, searchCities as searchCitiesJS,
    getParser, stripJPCoordZone,
    esc, toArr, ms, addStep, updateLastStep, htmlEsc,
    suggest, classifyInput, resolveTiles, rankSuggestions,
    buildPostcodeSQL, buildStreetSQL, buildPostcodeNarrowSQL, buildStreetNarrowSQL, buildNumberIndexSQL,
    // Reverse geocode (core)
    radiusToBbox, gridKForRadius, buildTileLookupSQL, buildReverseQuerySQL,
  } from '@walkthru-earth/geocoding-core'
  import type { CityRow, SuggestRow, AddressRow, StepEntry, AutocompleteQueryFns, InputClassification, TileBucketRow } from '@walkthru-earth/geocoding-core'
  import MapView from '../lib/MapView.svelte'
  import SplitPane from '../lib/components/SplitPane.svelte'
  import StepLog from '../lib/components/StepLog.svelte'
  import ResultsTable from '../lib/components/ResultsTable.svelte'
  import { startGeocodeTour } from '../lib/tour'
  import { track } from '../lib/analytics'
  import maplibregl from 'maplibre-gl'
  import { cellToBoundary } from 'h3-js'

  // ── Forward geocode presets (per-country) ──────────────────

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
      { label: '本郷 岐阜', city: '岐阜市', query: '本郷' },
      { label: '篠原町 浜松', city: '浜松市中央区', query: '篠原町' },
      { label: '原町 新宿', city: '新宿区', query: '原町' },
    ],
  }

  // ── Reverse location presets ───────────────────────────────

  const locationPresets = [
    { label: 'Puerta del Sol', lat: 40.4168, lon: -3.7038 },
    { label: 'Times Sq', lat: 40.7580, lon: -73.9855 },
    { label: 'Champs-Élysées', lat: 48.8698, lon: 2.3078 },
    { label: 'Colosseum', lat: 41.8902, lon: 12.4922 },
    { label: 'Shibuya', lat: 35.6595, lon: 139.7004 },
    { label: 'La Rambla', lat: 41.3818, lon: 2.1735 },
    { label: 'Opera House', lat: -33.8568, lon: 151.2153 },
    { label: 'Hamburg', lat: 53.5503, lon: 9.9928 },
  ]

  // ── Shared state ───────────────────────────────────────────

  let results = $state.raw<AddressRow[]>([])
  let searching = $state(false)
  let error = $state('')
  let searchTime = $state(0)
  let steps = $state<StepEntry[]>([])
  let mapView = $state<MapView>()
  let lastMode = $state<'forward' | 'reverse' | null>(null)

  // ── Forward geocode state ──────────────────────────────────

  let countries = $state.raw<string[]>([])
  let selectedCountry = $state('')
  let activePresets = $derived(presetsByCountry[selectedCountry] ?? [])

  let cityQuery = $state('')
  let cities = $state.raw<CityRow[]>([])
  let allCityRecords = $state.raw<CityRow[]>([])
  let selectedCity = $state<CityRow | null>(null)
  let selectedCityTiles = $derived(selectedCity ? new Set(toArr(selectedCity.tiles)) : null)
  let addressQuery = $state('')
  let suggestions = $state.raw<SuggestRow[]>([])
  let selectedSuggestion = $state<SuggestRow | null>(null)
  let loadingSuggestions = $state(false)
  let prefetching = $state(false)
  let citiesReady = $state(false)
  let cacheInfo = $state('')
  let limit = $state(5)
  let searchScope = $state<'city' | 'country'>('city')
  let lastClassification = $state<InputClassification | null>(null)

  let suggestTimer: ReturnType<typeof setTimeout> | null = null
  let searchGen = 0
  let autoGen = 0
  const suggestCache = new SearchCache<SuggestRow[]>()
  let userNavigated = false

  // ── Reverse geocode state ──────────────────────────────────

  let clickLat = $state<number | null>(null)
  let clickLon = $state<number | null>(null)
  let radius = $state(250)
  let resultLimit = $state(10)
  let reverseGen = 0
  let clickMarker: maplibregl.Marker | null = null
  let pendingAutoCity = ''

  // ── Lifecycle ──────────────────────────────────────────────

  $effect(() => {
    return () => { if (suggestTimer) clearTimeout(suggestTimer) }
  })

  onCacheLog((msg: string) => { cacheInfo = msg })
  $effect(() => { loadCountries() })

  // ── Shared helpers ─────────────────────────────────────────

  function log(text: string, status?: StepEntry['status']) {
    steps = addStep(steps, text, status)
  }
  function updateLast(text: string, status?: StepEntry['status']) {
    steps = updateLastStep(steps, text, status)
  }

  function removeClickMarker() {
    if (clickMarker) { clickMarker.remove(); clickMarker = null }
  }

  function resultPopupHtml(r: AddressRow, idx: number): string {
    const parts = [r.city, r.postcode].filter(Boolean).map(s => htmlEsc(s!)).join(' · ')
    const distLine = r.distance_m != null
      ? `<div style="display:flex;align-items:center;gap:8px;margin-left:2rem;margin-top:2px">
          <span class="popup-distance">${r.distance_m < 1000 ? `${Math.round(r.distance_m)}m` : `${(r.distance_m / 1000).toFixed(1)}km`} away</span>
          <span class="popup-coords" style="margin-left:0;margin-top:0">${r.lat?.toFixed(5)}, ${r.lon?.toFixed(5)}</span>
        </div>`
      : `<div class="popup-coords">${r.lat?.toFixed(5)}, ${r.lon?.toFixed(5)}</div>`
    return `<div class="popup-body">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span class="popup-badge ${idx === 0 ? 'popup-badge-primary' : 'popup-badge-secondary'}">${idx + 1}</span>
        <span class="popup-title">${htmlEsc(r.full_address)}</span>
      </div>
      ${parts ? `<div class="popup-subtitle">${parts}</div>` : ''}
      ${distLine}
    </div>`
  }

  function updateMapMarkers(autoFit: boolean) {
    if (!mapView || results.length === 0) return
    if (lastMode === 'reverse') removeClickMarker()
    const points = results.filter(r => r.lat && r.lon).map((r, i) => ({
      lng: r.lon,
      lat: r.lat,
      popupHtml: resultPopupHtml(r, i),
    }))
    const shouldFit = autoFit && (lastMode === 'reverse' || !userNavigated)
    mapView.setResultMarkers(points, shouldFit)
  }

  function flyToResult(r: AddressRow) {
    if (!mapView || !r.lat || !r.lon) return
    userNavigated = true
    const idx = results.indexOf(r)
    mapView.openResultPopup(idx)
  }

  /** When user clicks a disabled field, show the guided tour. */
  function onDisabledFieldClick() {
    if (!selectedCountry) startGeocodeTour()
  }

  // ── Map setup ──────────────────────────────────────────────

  function onMapReady(map: maplibregl.Map) {
    map.getCanvas().style.cursor = 'crosshair'
    map.on('click', (e) => {
      const target = e.originalEvent?.target as HTMLElement | null
      if (target?.closest('.result-marker')) return

      clickLat = Math.round(e.lngLat.lat * 10000) / 10000
      clickLon = Math.round(e.lngLat.lng * 10000) / 10000

      if (clickMarker) clickMarker.remove()
      clickMarker = new maplibregl.Marker({
        color: getComputedStyle(document.documentElement).getPropertyValue('--wt-marker-primary').trim() || '#36d399',
      })
        .setLngLat(e.lngLat)
        .addTo(map)

      map.flyTo({ center: e.lngLat, zoom: Math.max(map.getZoom(), 14), duration: 800 })
      track('map_clicked', { lat: clickLat, lon: clickLon })
      reverseSearch()
    })
  }

  // ── Smart autocomplete query functions (bridge core to DuckDB) ──

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
        const sql = buildNumberIndexSQL(cc, street)
        const rows = await queryObjects<{ street_lower: string; numbers: string[] }>(sql)
        if (rows.length === 0) return []

        const prefix = numberPrefix.toLowerCase()
        const isJP = cc === 'JP'
        const matched = toArr(rows[0].numbers)
          .map((n: string) => isJP ? stripJPCoordZone(n) : n)
          .filter((n: string) => n.toLowerCase().startsWith(prefix))
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

  // ── Forward geocode functions ──────────────────────────────

  async function loadCountries() {
    const rows = await queryObjects<{ country: string }>(`
      SELECT DISTINCT country FROM _manifest ORDER BY country
    `)
    countries = rows.map((r: { country: string }) => r.country)
  }

  async function onCountryChange(opts?: { keepResults?: boolean }) {
    selectedCity = null
    searchScope = 'city'
    cities = []
    allCityRecords = []
    if (!opts?.keepResults) {
      results = []
      steps = []
      mapView?.clearResultMarkers()
    }
    suggestions = []
    selectedSuggestion = null
    cacheInfo = ''
    citiesReady = false
    suggestCache.clear()

    if (!selectedCountry) return
    track('country_selected', { country: selectedCountry })

    if (!isCountryCached(selectedCountry)) {
      prefetching = true
      await prefetchCountry(selectedCountry, {
        onCitiesReady: async (count: number) => {
          citiesReady = true
          cacheInfo = `${selectedCountry}: ${count} cities ready, loading streets & postcodes...`
          const citiesT = getCountryTable('_cities', selectedCountry)
          const rows = await queryObjects<CityRow>(
            `SELECT city, region, tiles, addr_count, bbox_min_lon_e6, bbox_max_lon_e6, bbox_min_lat_e6, bbox_max_lat_e6 FROM ${citiesT}`
          )
          allCityRecords = rows
          if (pendingAutoCity) {
            autoSelectCity(pendingAutoCity)
            pendingAutoCity = ''
          }
        },
      })
      prefetching = false
    } else {
      citiesReady = true
      cacheInfo = `${selectedCountry}: indexes already cached`
      if (allCityRecords.length === 0) {
        const citiesT = getCountryTable('_cities', selectedCountry)
        const rows = await queryObjects<CityRow>(
          `SELECT city, region, tiles, addr_count, bbox_min_lon_e6, bbox_max_lon_e6, bbox_min_lat_e6, bbox_max_lat_e6 FROM ${citiesT}`
        )
        allCityRecords = rows
      }
      if (pendingAutoCity) {
        autoSelectCity(pendingAutoCity)
        pendingAutoCity = ''
      }
    }
  }

  function searchCities() {
    if (!selectedCountry || cityQuery.length < 2) { cities = []; return }
    cities = searchCitiesJS(allCityRecords as any, cityQuery, 20) as CityRow[]
  }

  function selectCity(city: CityRow, opts?: { keepResults?: boolean; skipZoom?: boolean }) {
    track('city_selected', { city: city.city, country: selectedCountry })
    selectedCity = city
    cityQuery = city.city
    cities = []
    selectedSuggestion = null
    suggestions = []
    if (!opts?.keepResults) {
      results = []
      steps = []
    }
    if (!opts?.skipZoom && city.bbox_min_lon_e6 && city.bbox_max_lat_e6 && mapView) {
      const pad = 0.01
      const minLon = (city.bbox_min_lon_e6 ?? 0) / 1e6 - pad
      const minLat = (city.bbox_min_lat_e6 ?? 0) / 1e6 - pad
      const maxLon = (city.bbox_max_lon_e6 ?? 0) / 1e6 + pad
      const maxLat = (city.bbox_max_lat_e6 ?? 0) / 1e6 + pad
      mapView.getMap()?.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 40 })
    }
  }

  function autocomplete() {
    if (!selectedCountry || !isCountryCached(selectedCountry) || addressQuery.length < 2) { suggestions = []; lastClassification = null; return }
    if (suggestTimer) clearTimeout(suggestTimer)
    suggestTimer = setTimeout(() => doAutocomplete(), 150)
  }

  async function doAutocomplete() {
    if (!isCountryCached(selectedCountry)) return
    const gen = ++autoGen
    loadingSuggestions = true
    try {
      const { classification, suggestions: results } = await suggest(
        addressQuery, selectedCountry, selectedCity?.city ?? null,
        selectedCityTiles, autoQueryFns, suggestCache,
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
    if (s.type === 'address') forwardSearch()
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
    lastMode = 'forward'
    selectedSuggestion = null
    addressQuery = preset.query
    removeClickMarker()
    mapView?.clearResultMarkers()

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

    let t0 = performance.now()
    log(`Step 2  Looking up "${preset.city}"...`, 'loading')
    const citiesT = getCountryTable('_cities', cc)
    const cityResults = await queryObjects<CityRow>(`
      SELECT city, region,
             list_distinct(flatten(list(tiles))) AS tiles,
             sum(addr_count)::INTEGER AS addr_count
      FROM ${citiesT}
      WHERE lower(city) = '${esc(preset.city.toLowerCase())}'
      GROUP BY city, region
      ORDER BY addr_count DESC LIMIT 1
    `)
    if (cityResults.length === 0) { updateLast(`Step 2  City not found!`, 'error'); return }
    const city = cityResults[0]
    selectedCity = city
    cityQuery = city.city
    updateLast(`Step 2  ${city.city}, ${toArr(city.tiles).length} tile(s), ${city.addr_count.toLocaleString()} addr (${ms(t0)})`, 'done')

    t0 = performance.now()
    const q = preset.query.toLowerCase()
    const cls = classifyInput(q, cc)
    if (cls.hasPostcode || cls.mode === 'postcode') {
      log(`Step 3  Narrowing via postcodes for "${q}"...`, 'loading')
      const postcodesT = getCountryTable('_postcodes', cc)
      const rows = await queryObjects<{ postcode: string; tiles: string[]; addr_count: number }>(`
        SELECT postcode, tiles, addr_count FROM ${postcodesT}
        WHERE lower(postcode) LIKE '${esc(q)}%'
        ORDER BY addr_count DESC LIMIT 1
      `)
      if (rows.length > 0) {
        selectedSuggestion = { type: 'postcode', label: rows[0].postcode, tiles: rows[0].tiles, addr_count: rows[0].addr_count }
        updateLast(`Step 3  Postcode "${rows[0].postcode}" -> ${toArr(rows[0].tiles).length} tile(s) (${ms(t0)})`, 'done')
      } else {
        updateLast(`Step 3  No postcode match, using city tiles (${ms(t0)})`, 'done')
      }
    } else {
      log(`Step 3  Narrowing via streets for "${q.split(/\s+/)[0]}"...`, 'loading')
      try {
        const streetsT = getCountryTable('_streets', cc)
        const rows = await queryObjects<{ street_lower: string; tiles: string[]; addr_count: number }>(`
          SELECT street_lower, tiles, addr_count FROM ${streetsT}
          WHERE street_lower LIKE '${esc(q.split(/\s+/)[0])}%'
          ORDER BY addr_count DESC LIMIT 1
        `)
        if (rows.length > 0) {
          selectedSuggestion = { type: 'street', label: rows[0].street_lower, tiles: rows[0].tiles, addr_count: rows[0].addr_count }
          updateLast(`Step 3  Street "${rows[0].street_lower}" -> ${toArr(rows[0].tiles).length} tile(s) (${ms(t0)})`, 'done')
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
    await cancelPendingQuery()
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

    const detected: string[] = []
    if (parsed.postcode) detected.push(`postcode=${parsed.postcode}`)
    if (parsed.street) detected.push(`street="${parsed.street}"`)
    if (parsed.number) detected.push(`number=${parsed.number}`)
    if (parsed.unit) detected.push(`unit=${parsed.unit}`)
    if (detected.length > 0) {
      log(`Parse   ${detected.join(', ')}`, 'done')
    }

    let tiles: string[] = []
    let source = 'none'

    if (parsed.postcode && isCountryCached(cc)) {
      const t0 = performance.now()
      try {
        const rows = await queryObjects<{ postcode: string; tiles: string[]; addr_count: number }>(buildPostcodeNarrowSQL(cc, parsed.postcode))
        if (rows.length > 0) {
          tiles = toArr(rows[0].tiles)
          source = `postcode "${rows[0].postcode}" (${rows[0].addr_count.toLocaleString()} addr)`
          log(`Narrow  Postcode ${rows[0].postcode} -> ${tiles.length} tile(s) (${ms(t0)})`, 'done')
        }
      } catch { /* no postcode table */ }
    }

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
          log(`Narrow  Street "${rows[0].street_lower}" -> ${tiles.length} tile(s) (${ms(t0)})`, 'done')
        }
      } catch { /* no street table */ }
    }

    const effectiveScope = selectedCity ? searchScope : 'country'
    if (tiles.length > 0 && selectedCityTiles && selectedCity) {
      const cityTiles = tiles.filter((t: string) => selectedCityTiles.has(t))
      const otherTiles = tiles.filter((t: string) => !selectedCityTiles.has(t))
      if (cityTiles.length > 0) {
        if (effectiveScope === 'city') {
          tiles = cityTiles
          log(`Narrow  City "${selectedCity.city}": ${cityTiles.length} tile(s) (city scope)`, 'done')
        } else {
          tiles = [...cityTiles, ...otherTiles]
          log(`Narrow  City "${selectedCity.city}" intersection: ${cityTiles.length} tile(s) first, ${otherTiles.length} remaining`, 'done')
        }
        source += ' + city'
      } else if (cityTiles.length === 0 && otherTiles.length > 0) {
        if (effectiveScope === 'city') {
          error = `"${parsed.street || addressQuery}" not found in ${selectedCity.city}. Switch to Country scope to search nationwide.`
          searching = false
          return
        }
        log(`Narrow  "${parsed.street}" not in "${selectedCity.city}", searching ${tiles.length} tile(s) nationwide`, 'done')
      }
    }

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

    const tileGroups = await expandTilesToBucketGroups(cc, tiles)
    if (tileGroups.length === 0) {
      error = 'No tile data found for these tiles.'
      searching = false
      return
    }

    const totalBuckets = tileGroups.reduce((s, g) => s + g.buckets.length, 0)
    const totalT0 = performance.now()
    let remaining = limit

    const hasSpecificFilters = !!(parsed.postcode || (parsed.street && parsed.number))

    log(`Search  ${tileGroups.length} tile(s), ${totalBuckets} bucket(s) via ${source}`)
    log(`SQL     WHERE ${where}`, undefined)

    try {
      if (hasSpecificFilters && tileGroups.length > 1) {
        log(`Mode    Batch query with Parquet filter pushdown`, undefined)
        const allUrls: string[] = []
        for (const { h3Res4, buckets: tileBuckets } of tileGroups) {
          for (const b of tileBuckets) {
            allUrls.push(tilePath(cc, h3Res4, b))
          }
        }
        const src = `read_parquet([${allUrls.map(u => `'${u}'`).join(',')}])`
        const t0 = performance.now()
        log(`        Batch across ${allUrls.length} file(s)...`, 'loading')
        try {
          results = await queryObjectsWithRetry<AddressRow>(`
            SELECT full_address, street, number, city, region, postcode,
                   ST_Y(geometry) AS lat, ST_X(geometry) AS lon,
                   h3_h3_to_string(h3_index) AS h3_index
            FROM ${src}
            WHERE ${where}
            LIMIT ${limit}
          `)
          if (gen !== searchGen) return
          updateLast(`        Batch across ${allUrls.length} file(s), ${results.length} match(es) (${ms(t0)})`, 'done')
          searching = false
          updateMapMarkers(true)
        } catch (batchErr: any) {
          console.warn('[geocode] Batch query failed, falling back to per-tile:', batchErr.message)
          updateLast(`        Batch failed (${ms(t0)}), falling back to per-tile...`, 'error')
          results = []
        }
      }

      // ── Sequential mode: fallback or broad queries without specific filters ──
      if (results.length === 0) {
        if (!hasSpecificFilters) {
          log(`Mode    Sequential tile queries`, undefined)
        }
        let consecutiveEmpty = 0
        const MAX_EMPTY_AFTER_RESULTS = 5

        for (let i = 0; i < tileGroups.length; i++) {
          if (gen !== searchGen) return
          if (remaining <= 0) {
            log(`        Limit reached, skipping ${tileGroups.length - i} tile(s)`, 'done')
            break
          }
          if (results.length > 0 && consecutiveEmpty >= MAX_EMPTY_AFTER_RESULTS) {
            log(`        ${tileGroups.length - i} tile(s) skipped (${consecutiveEmpty} consecutive empty)`, 'done')
            break
          }

          const { h3Res4, buckets: tileBuckets } = tileGroups[i]
          const label = tileBuckets.length === 1 && tileBuckets[0] === '_'
            ? h3Res4 : `${h3Res4} (${tileBuckets.length} buckets)`
          const t0 = performance.now()
          log(`        ${label}, querying...`, 'loading')

          let tileResults: AddressRow[] = []
          try {
            let src: string
            let useRetry = false
            if (tileBuckets.length === 1 && isTileCached(cc, h3Res4, tileBuckets[0])) {
              src = await getTileSource(cc, h3Res4, tileBuckets[0])
            } else if (hasSpecificFilters || tileBuckets.length > 1) {
              src = tileSourceExpr(cc, h3Res4, tileBuckets)
              useRetry = true
            } else {
              src = await getTileSource(cc, h3Res4, tileBuckets[0])
            }

            const queryFn = useRetry ? queryObjectsWithRetry : queryObjects
            tileResults = await queryFn<AddressRow>(`
              SELECT full_address, street, number, city, region, postcode,
                     ST_Y(geometry) AS lat, ST_X(geometry) AS lon,
                     h3_h3_to_string(h3_index) AS h3_index
              FROM ${src}
              WHERE ${where}
              LIMIT ${remaining}
            `)
          } catch (tileErr: any) {
            console.warn(`[geocode] Tile ${h3Res4} failed:`, tileErr.message)
            updateLast(`        ${label}, failed (${ms(t0)})`, 'error')
            continue
          }

          if (gen !== searchGen) return

          if (tileResults.length > 0) { consecutiveEmpty = 0 } else { consecutiveEmpty++ }

          results = [...results, ...tileResults].slice(0, limit)
          remaining = limit - results.length
          updateLast(`        ${label}, ${tileResults.length} match${tileResults.length !== 1 ? 'es' : ''} (${ms(t0)})`, 'done')

          if (results.length > 0 && searching) searching = false
          updateMapMarkers(i === 0)
        }
      }

      searchTime = performance.now() - totalT0
      log(`Done    ${results.length} results, total: ${ms(totalT0)}`, 'done')
      track('forward_geocode_search', {
        country: cc, region: '',
        result_count: results.length,
        duration_ms: Math.round(searchTime),
        tile_count: tileGroups.length,
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

  function forwardSearch() {
    if (suggestTimer) { clearTimeout(suggestTimer); suggestTimer = null }
    suggestions = []
    cities = []
    steps = []
    lastMode = 'forward'
    removeClickMarker()
    mapView?.clearResultMarkers()
    if (isCountryCached(selectedCountry)) {
      log(`Step 1  ${selectedCountry} indexes cached`, 'done')
    }
    if (selectedCity) log(`Step 2  City: ${selectedCity.city}`, 'done')
    if (selectedSuggestion) log(`Step 3  ${selectedSuggestion.type}: ${selectedSuggestion.label}`, 'done')
    searchDirect()
  }

  // ── Reverse geocode functions ──────────────────────────────

  async function reverseSearch() {
    if (clickLat === null || clickLon === null) return
    const gen = ++reverseGen
    searching = true
    lastMode = 'reverse'
    error = ''
    results = []
    steps = []
    mapView?.clearResultMarkers()

    const lat = clickLat, lon = clickLon
    const totalT0 = performance.now()

    try {
      const k = gridKForRadius(radius)
      log(`Step 1  Tile lookup${k > 0 ? ` (grid_disk k=${k})` : ''}...`, 'loading')

      const tiles = await queryObjects<TileBucketRow>(buildTileLookupSQL(lat, lon, k))
      if (gen !== reverseGen) return

      if (tiles.length === 0) {
        updateLast('Step 1  No coverage at this location', 'error')
        error = 'No address coverage at this location.'
        return
      }

      tiles.sort((a, b) => b.address_count - a.address_count)
      updateLast(`Step 1  ${tiles[0].country}/${tiles[0].region || '-'}, ${tiles.length} bucket(s) (${ms(totalT0)})`, 'done')

      tiles.forEach(t => {
        const label = t.bucket === '_' ? t.h3_res4 : `${t.h3_res4}/${t.bucket}`
        const cached = isTileCached(t.country, t.h3_res4, t.bucket)
        log(`        ${label}, ${t.address_count.toLocaleString()} addr${cached ? ' [cached]' : ''}`)
      })

      const queriedTiles = new Set<string>()
      const skippedTiles = new Set<string>()
      showTilesOnMap(tiles, queriedTiles, skippedTiles)

      const bbox = radiusToBbox(lat, lon, radius)

      for (let i = 0; i < tiles.length; i++) {
        const { country, h3_res4, bucket } = tiles[i]
        const label = bucket === '_' ? h3_res4 : `${h3_res4}/${bucket}`
        const t0 = performance.now()
        const cached = isTileCached(country, h3_res4, bucket)
        log(`Step 2  Bucket ${i + 1}/${tiles.length}: ${label}, ${cached ? 'cached' : 'fetching'}...`, 'loading')

        let tileAddresses: AddressRow[] = []
        try {
          const src = cached
            ? await getTileSource(country, h3_res4, bucket)
            : `read_parquet('${tilePath(country, h3_res4, bucket)}')`

          tileAddresses = await queryObjects<AddressRow>(buildReverseQuerySQL(src, country, lat, lon, bbox, resultLimit))
        } catch (err: any) {
          console.warn(`[reverse] Bucket ${label} failed:`, err.message)
          updateLast(`Step 2  Bucket ${i + 1}/${tiles.length}: ${label}, failed (${ms(t0)})`, 'error')
          continue
        }

        if (gen !== reverseGen) return
        queriedTiles.add(h3_res4)

        results = [...results, ...tileAddresses].sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0)).slice(0, resultLimit)
        updateLast(`Step 2  Bucket ${i + 1}/${tiles.length}: ${label}, ${tileAddresses.length} nearby (${ms(t0)})`, 'done')

        updateMapMarkers(true)
        showTilesOnMap(tiles, queriedTiles, skippedTiles)

        if (results.length >= resultLimit) {
          const skipped = tiles.length - i - 1
          if (skipped > 0) {
            for (let j = i + 1; j < tiles.length; j++) skippedTiles.add(tiles[j].h3_res4)
            showTilesOnMap(tiles, queriedTiles, skippedTiles)
            log(`        Limit reached, skipping ${skipped} bucket(s)`, 'done')
          }
          break
        }
      }

      searchTime = performance.now() - totalT0
      log(`Done    ${results.length} results in ${ms(totalT0)}`, 'done')
      track('reverse_geocode_search', {
        lat, lon, radius_m: radius,
        result_count: results.length,
        duration_ms: Math.round(searchTime),
        tiles_queried: queriedTiles.size,
      })

      // Auto-fill country and city from reverse results
      if (results.length > 0) {
        autoFillFromReverse(tiles[0].country, results[0].city)
      }
    } catch (e: any) {
      console.error('[reverse] Error:', e)
      error = e.message
      log(`Error: ${e.message}`, 'error')
      track('reverse_geocode_error', { lat, lon, error: e.message })
    } finally {
      searching = false
    }
  }

  async function autoFillFromReverse(cc: string, cityName: string) {
    pendingAutoCity = cityName
    if (cc === selectedCountry) {
      if (citiesReady && allCityRecords.length > 0) {
        autoSelectCity(cityName)
        pendingAutoCity = ''
      }
      return
    }
    selectedCountry = cc
    await onCountryChange({ keepResults: true })
  }

  function autoSelectCity(cityName: string) {
    if (!cityName || allCityRecords.length === 0) return
    const match = searchCitiesJS(allCityRecords as any, cityName, 1) as CityRow[]
    if (match.length > 0) {
      selectCity(match[0], { keepResults: true, skipZoom: true })
    }
  }

  function setLocationPreset(name: string, lt: number, ln: number) {
    track('preset_clicked', { preset: name, lat: lt, lon: ln })
    clickLat = lt
    clickLon = ln
    if (clickMarker) clickMarker.remove()
    clickMarker = new maplibregl.Marker({
      color: getComputedStyle(document.documentElement).getPropertyValue('--wt-marker-primary').trim() || '#36d399',
    })
      .setLngLat([ln, lt])
      .addTo(mapView!.getMap()!)
    mapView?.flyTo(ln, lt, 16)
    reverseSearch()
  }

  /** Show tile boundaries on the map (res-4 hexagons) */
  function showTilesOnMap(
    tiles: { country: string; h3_res4: string; bucket: string; address_count: number }[],
    queriedTiles: Set<string>,
    skippedTiles: Set<string>,
  ) {
    if (!mapView) return

    const seen = new Set<string>()
    const uniqueTiles = tiles.filter(t => {
      if (seen.has(t.h3_res4)) return false
      seen.add(t.h3_res4)
      return true
    })

    const tileFeatures: GeoJSON.Feature[] = uniqueTiles.map(t => {
      const boundary = cellToBoundary(t.h3_res4)
      const coords = boundary.map(([lt, ln]) => [ln, lt])
      coords.push(coords[0])
      const status = queriedTiles.has(t.h3_res4) ? 'queried' : skippedTiles.has(t.h3_res4) ? 'skipped' : 'pending'
      return {
        type: 'Feature',
        properties: { h3_res4: t.h3_res4, country: t.country, address_count: t.address_count, status },
        geometry: { type: 'Polygon', coordinates: [coords] },
      }
    })

    mapView.addGeoJSONLayer('h3-tiles', { type: 'FeatureCollection', features: tileFeatures }, {
      fillColor: ['match', ['get', 'status'], 'queried', '#22c55e', 'skipped', '#64748b', '#eab308'] as any,
      fillOpacity: 0.1,
      lineColor: ['match', ['get', 'status'], 'queried', '#22c55e', 'skipped', '#64748b', '#eab308'] as any,
      lineWidth: 1.5,
    })
  }
</script>

<SplitPane>
  {#snippet left()}
  <div class="p-3 md:p-6 space-y-4 md:space-y-5">
    <!-- Header row -->
    <div class="flex items-center gap-2 md:gap-3 flex-wrap">
      <h2 class="text-lg md:text-xl font-bold tracking-tight flex-1 min-w-0">Geocoding Playground</h2>
      <button class="btn btn-ghost btn-xs btn-circle opacity-40 hover:opacity-100" onclick={startGeocodeTour} aria-label="Show guided tour">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
      <select id="tour-country-select" class="select select-bordered select-sm md:select-md w-28 md:w-40" bind:value={selectedCountry} onchange={() => onCountryChange()}>
        <option value="">Country...</option>
        {#each countries as c}
          <option value={c}>{c}</option>
        {/each}
      </select>
      {#if prefetching}
        <span class="loading loading-spinner loading-sm text-primary"></span>
      {/if}
    </div>

    {#if cacheInfo && prefetching}
      <div class="text-xs md:text-sm text-base-content/50 -mt-2 md:-mt-3 break-words">{cacheInfo}</div>
    {/if}

    <!-- Forward presets -->
    {#if activePresets.length > 0 && citiesReady}
      <div id="tour-presets" class="flex gap-2 overflow-x-auto scrollbar-thin pb-1">
        {#each activePresets as p}
          <button class="preset-pill" onclick={() => runPreset(p)} disabled={searching || prefetching}>{p.label}</button>
        {/each}
      </div>
    {/if}

    <!-- Search fields -->
    <div class="space-y-3">
      <div class="relative">
        <input type="text" class="input input-bordered input-sm md:input-md w-full" id="tour-city-input"
          placeholder="City (optional)..."
          bind:value={cityQuery}
          oninput={() => searchCities()}
          disabled={!selectedCountry || !citiesReady}
        />
        {#if !selectedCountry}
          <div class="absolute inset-0 cursor-pointer" role="button" tabindex="0" aria-label="Select a country first" onclick={onDisabledFieldClick} onkeydown={(e) => e.key === 'Enter' && onDisabledFieldClick()}></div>
        {/if}
        {#if cities.length > 0}
          <ul class="menu bg-base-200 rounded-lg shadow-xl absolute z-50 w-full mt-1 max-h-60 overflow-y-auto border border-base-content/10">
            {#each cities as city}
              <li>
                <button class="flex items-center gap-2 min-w-0" onclick={() => selectCity(city)}>
                  <span class="font-bold truncate">{city.city}</span>
                  <span class="badge badge-sm badge-ghost ml-auto shrink-0">{city.addr_count.toLocaleString()}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="relative">
        <input type="text" class="input input-bordered input-sm md:input-md w-full" id="tour-address-input"
          placeholder="Street, postcode, or address..."
          bind:value={addressQuery}
          oninput={() => { selectedSuggestion = null; autocomplete() }}
          onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && forwardSearch()}
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
        {#if selectedCity}
          <select class="select select-bordered select-sm md:select-md w-24 md:w-28" bind:value={searchScope} title="Search scope">
            <option value="city">City</option>
            <option value="country">Country</option>
          </select>
        {/if}
        <button id="tour-search-btn" class="btn btn-primary btn-sm md:btn-md rounded-full flex-1" onclick={forwardSearch} disabled={!selectedCountry || addressQuery.length < 2 || searching || prefetching}>
          {#if searching && lastMode === 'forward'}
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

    <!-- Reverse geocode context (shown after map click) -->
    {#if clickLat !== null && clickLon !== null}
      <div class="flex items-center gap-2 flex-wrap border border-base-content/10 rounded-lg px-3 py-2 bg-base-200/30">
        <span class="text-xs font-mono text-base-content/50">{clickLat}, {clickLon}</span>
        <select class="select select-bordered select-xs w-16" bind:value={radius}>
          <option value={250}>250m</option>
          <option value={500}>500m</option>
          <option value={1000}>1km</option>
          <option value={2000}>2km</option>
        </select>
        <select class="select select-bordered select-xs w-14" bind:value={resultLimit}>
          <option value={10}>10</option>
          <option value={25}>25</option>
          <option value={50}>50</option>
        </select>
        <button class="btn btn-outline btn-xs rounded-full flex-1 min-w-[6rem]" onclick={reverseSearch} disabled={searching}>
          {#if searching && lastMode === 'reverse'}
            <span class="loading loading-spinner loading-xs"></span>
          {:else}
            Find Nearby
          {/if}
        </button>
      </div>
    {/if}

    <!-- Location presets -->
    <div class="flex gap-2 overflow-x-auto scrollbar-thin pb-1">
      {#each locationPresets as p}
        <button class="preset-pill !text-[10px] md:!text-xs" onclick={() => setLocationPreset(p.label, p.lat, p.lon)} disabled={searching}>{p.label}</button>
      {/each}
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
            {selectedSuggestion.label} -> {sugTileCount} tile{sugTileCount > 1 ? 's' : ''}
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
      showDistance={lastMode === 'reverse'}
      onRowClick={flyToResult}
      emptyMessage={
        !searching && lastMode === 'reverse' && steps.length > 0 && !error
          ? 'No addresses found nearby. Try increasing the radius.'
          : !searching && lastMode === 'forward' && addressQuery.length > 1 && (selectedCity || selectedSuggestion)
            ? 'No results yet. Hit search or press Enter.'
            : ''
      }
    />
  </div>
  {/snippet}

  {#snippet right()}
    <MapView bind:this={mapView} class="h-full w-full" onMapReady={onMapReady} />
  {/snippet}
</SplitPane>
