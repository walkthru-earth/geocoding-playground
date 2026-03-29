<script lang="ts">
  import { queryObjects, queryObjectsWithRetry, tilePath, getTileSource, isTileCached, ms, addStep, updateLastStep, htmlEsc } from '@walkthru-earth/geocoding-core'
  import type { AddressRow, StepEntry } from '@walkthru-earth/geocoding-core'
  import MapView from '../lib/MapView.svelte'
  import SplitPane from '../lib/components/SplitPane.svelte'
  import StepLog from '../lib/components/StepLog.svelte'
  import ResultsTable from '../lib/components/ResultsTable.svelte'
  import maplibregl from 'maplibre-gl'
  import { cellToBoundary } from 'h3-js'
  import { shouldShowTour, showNavTour } from '../lib/tour'
  import { track } from '../lib/analytics'

  // Show welcome tour on first visit
  $effect(() => {
    if (shouldShowTour()) {
      const timer = setTimeout(() => showNavTour(), 800)
      return () => clearTimeout(timer)
    }
  })

  let lat = $state(40.4168)
  let lon = $state(-3.7038)
  let radius = $state(250)
  let resultLimit = $state(10)
  let results = $state<AddressRow[]>([])
  let searching = $state(false)
  let error = $state('')
  let searchTime = $state(0)
  let steps = $state<StepEntry[]>([])
  let mapView = $state<MapView>()
  let searchGen = 0

  function log(text: string, status?: StepEntry['status']) {
    steps = addStep(steps, text, status)
  }
  function updateLast(text: string, status?: StepEntry['status']) {
    steps = updateLastStep(steps, text, status)
  }

  let clickMarker: maplibregl.Marker | null = null

  function onMapReady(map: maplibregl.Map) {
    map.getCanvas().style.cursor = 'crosshair'
    map.on('click', (e) => {
      // Don't trigger search if the click was on a marker element
      const target = e.originalEvent?.target as HTMLElement | null
      if (target?.closest('.result-marker')) return

      lat = Math.round(e.lngLat.lat * 10000) / 10000
      lon = Math.round(e.lngLat.lng * 10000) / 10000

      if (clickMarker) clickMarker.remove()
      clickMarker = new maplibregl.Marker({ color: getComputedStyle(document.documentElement).getPropertyValue('--wt-marker-primary').trim() || '#36d399' })
        .setLngLat(e.lngLat)
        .addTo(map)

      map.flyTo({ center: e.lngLat, zoom: Math.max(map.getZoom(), 14), duration: 800 })
      track('map_clicked', { lat, lon })
      search()
    })
  }

  async function search() {
    const gen = ++searchGen
    searching = true
    error = ''
    results = []
    steps = []
    mapView?.clearResultMarkers()

    const totalT0 = performance.now()
    try {
      // ── Step 1: H3 parent computation + tile_index lookup (single query) ──
      // Computes the res-4 h3_parent for the click point (or grid_disk for large radius)
      // and joins with tile_index in one round-trip to get country + region.
      let t0 = performance.now()
      const needDisk = radius > 5000
      const gridK = radius <= 5000 ? 0 : radius <= 10000 ? 1 : 2
      log(`Step 1  Tile lookup${needDisk ? ` (grid_disk k=${gridK})` : ''}...`, 'loading')

      // Single query: compute h3_parent AND join with tile_index to get country/region
      const tiles = needDisk
        ? await queryObjects<{ country: string; region: string; h3_parent: string; address_count: number }>(`
            WITH disk AS (
              SELECT UNNEST(h3_grid_disk(h3_latlng_to_cell(${lat}, ${lon}, 5), ${gridK})) AS cell
            ),
            parents AS (
              SELECT DISTINCT h3_h3_to_string(h3_cell_to_parent(cell, 4)) AS h3_parent
              FROM disk
            )
            SELECT t.country, t.region, t.h3_parent, t.address_count
            FROM parents p
            JOIN _tile_index t ON t.h3_parent = p.h3_parent
          `)
        : await queryObjects<{ country: string; region: string; h3_parent: string; address_count: number }>(`
            SELECT t.country, t.region, t.h3_parent, t.address_count
            FROM _tile_index t
            WHERE t.h3_parent = h3_h3_to_string(
              h3_cell_to_parent(h3_latlng_to_cell(${lat}, ${lon}, 5), 4)
            )
          `)

      if (gen !== searchGen) return

      if (tiles.length === 0) {
        updateLast('Step 1  No coverage at this location', 'error')
        error = 'No address coverage at this location.'
        return
      }

      // Sort by address count (densest tile first, most likely to have nearby results)
      tiles.sort((a, b) => b.address_count - a.address_count)

      updateLast(`Step 1  ${tiles[0].country}/${tiles[0].region}, ${tiles.length} tile(s) (${ms(t0)})`, 'done')

      tiles.forEach(t => {
        const cached = isTileCached(t.country, t.region, t.h3_parent)
        log(`        ${t.h3_parent}, ${t.address_count.toLocaleString()} addr${cached ? ' [cached]' : ''}`)
      })

      // Show tile boundaries on map
      const queriedTiles = new Set<string>()
      const skippedTiles = new Set<string>()
      showTilesOnMap(tiles, queriedTiles, skippedTiles)

      // ── Step 2: Query tiles by distance ──
      // Scans the full tile and ranks by Haversine distance. No h3_index cell
      // filter, because addresses in adjacent cells within the same tile are
      // often the nearest results (sparse tiles can have all addresses in one cell).
      // DuckDB scans 10K-50K cached rows with distance calc in <50ms.
      for (let i = 0; i < tiles.length; i++) {
        const { country, region, h3_parent } = tiles[i]

        t0 = performance.now()
        const cached = isTileCached(country, region, h3_parent)
        log(`Step 2  Tile ${i + 1}/${tiles.length}: ${h3_parent}, ${cached ? 'cached' : 'fetching'}...`, 'loading')

        let tileAddresses: AddressRow[] = []
        try {
          // Always cache tile for reverse geocoding (user clicks nearby again)
          const src = await getTileSource(country, region, h3_parent)

          tileAddresses = await queryObjects<AddressRow>(`
            SELECT
              full_address, street, number, city, region, postcode,
              '${country}' AS country,
              ST_Y(geometry) AS lat,
              ST_X(geometry) AS lon,
              h3_h3_to_string(h3_index) AS h3_index,
              2 * 6371000 * ASIN(SQRT(
                POWER(SIN(RADIANS(ST_Y(geometry) - ${lat}) / 2), 2) +
                COS(RADIANS(${lat})) * COS(RADIANS(ST_Y(geometry))) *
                POWER(SIN(RADIANS(ST_X(geometry) - ${lon}) / 2), 2)
              )) AS distance_m
            FROM ${src}
            ORDER BY distance_m
            LIMIT ${resultLimit}
          `)
        } catch (tileErr: any) {
          console.warn(`[reverse] Tile ${h3_parent} failed:`, tileErr.message)
          updateLast(
            `Step 2  Tile ${i + 1}/${tiles.length}: ${h3_parent}, failed (${ms(t0)})`,
            'error'
          )
          continue
        }

        if (gen !== searchGen) return
        queriedTiles.add(h3_parent)

        results = [...results, ...tileAddresses].sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0)).slice(0, resultLimit)
        updateLast(
          `Step 2  Tile ${i + 1}/${tiles.length}: ${h3_parent}, ${tileAddresses.length} nearby (${ms(t0)})`,
          'done'
        )

        // Update map: markers + tile status
        updateMapMarkers()
        showTilesOnMap(tiles, queriedTiles, skippedTiles)

        // Early exit: if we have enough results, skip remaining tiles
        if (results.length >= resultLimit) {
          const skipped = tiles.length - i - 1
          if (skipped > 0) {
            for (let j = i + 1; j < tiles.length; j++) skippedTiles.add(tiles[j].h3_parent)
            showTilesOnMap(tiles, queriedTiles, skippedTiles)
            log(`        Limit reached, skipping ${skipped} tile(s)`, 'done')
          }
          break
        }
      }

      searchTime = performance.now() - totalT0
      log(`Done    ${results.length} results in ${ms(totalT0)}`, 'done')
      track('reverse_geocode_search', {
        lat,
        lon,
        radius_m: radius,
        result_count: results.length,
        duration_ms: Math.round(searchTime),
        tiles_queried: queriedTiles.size,
      })
    } catch (e: any) {
      console.error('[reverse] Error:', e)
      error = e.message
      log(`Error: ${e.message}`, 'error')
      track('reverse_geocode_error', { lat, lon, error: e.message })
    } finally {
      searching = false
    }
  }

  function removeClickMarker() {
    if (clickMarker) { clickMarker.remove(); clickMarker = null }
  }

  function resultPopupHtml(r: AddressRow, idx: number): string {
    const dist = r.distance_m ?? 0
    const distStr = dist < 1000 ? `${Math.round(dist)}m` : `${(dist / 1000).toFixed(1)}km`
    const parts = [r.city, r.postcode].filter(Boolean).map(s => htmlEsc(s!)).join(' · ')
    return `<div class="popup-body">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span class="popup-badge ${idx === 0 ? 'popup-badge-primary' : 'popup-badge-secondary'}">${idx + 1}</span>
        <span class="popup-title">${htmlEsc(r.full_address)}</span>
      </div>
      ${parts ? `<div class="popup-subtitle">${parts}</div>` : ''}
      <div style="display:flex;align-items:center;gap:8px;margin-left:2rem;margin-top:2px">
        <span class="popup-distance">${distStr} away</span>
        <span class="popup-coords" style="margin-left:0;margin-top:0">${r.lat?.toFixed(5)}, ${r.lon?.toFixed(5)}</span>
      </div>
    </div>`
  }

  function updateMapMarkers() {
    if (!mapView || results.length === 0) return
    removeClickMarker()
    const points = results.filter(r => r.lat && r.lon).map((r, i) => ({
      lng: r.lon,
      lat: r.lat,
      popupHtml: resultPopupHtml(r, i),
    }))
    // Zoom in close enough to see individual result markers
    mapView.setResultMarkers(points, true)
  }

  /** Show tile boundaries on the map (res-4 parent tiles) */
  function showTilesOnMap(
    tiles: { country: string; h3_parent: string; address_count: number }[],
    queriedTiles: Set<string>,
    skippedTiles: Set<string>,
  ) {
    if (!mapView) return

    // Res-4 parent tiles: green = done, yellow = pending, gray = skipped
    const tileFeatures: GeoJSON.Feature[] = tiles.map(t => {
      const boundary = cellToBoundary(t.h3_parent)
      const coords = boundary.map(([lt, ln]) => [ln, lt])
      coords.push(coords[0])
      const status = queriedTiles.has(t.h3_parent) ? 'queried' : skippedTiles.has(t.h3_parent) ? 'skipped' : 'pending'
      return {
        type: 'Feature',
        properties: {
          h3_parent: t.h3_parent,
          country: t.country,
          address_count: t.address_count,
          status,
        },
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

  function flyToResult(r: AddressRow) {
    if (!mapView || !r.lat || !r.lon) return
    const idx = results.indexOf(r)
    mapView.openResultPopup(idx)
  }

  function setPreset(name: string, lt: number, ln: number) {
    track('preset_clicked', { preset: name, lat: lt, lon: ln })
    lat = lt
    lon = ln
    mapView?.flyTo(ln, lt, 16)
    search()
  }
</script>

<SplitPane>
  {#snippet left()}
  <div class="p-3 md:p-6 space-y-4 md:space-y-5">
    <div>
      <h2 class="text-lg md:text-xl font-bold tracking-tight">Reverse Geocode</h2>
      <p class="text-xs md:text-sm text-base-content/50 mt-1">Click the map or enter coordinates to find nearby addresses.</p>
    </div>

    <!-- Coordinate inputs -->
    <div class="grid grid-cols-2 gap-3">
      <label class="form-control">
        <div class="label"><span class="label-text text-base-content/50">Latitude</span></div>
        <input type="number" step="0.0001" class="input input-bordered" bind:value={lat} />
      </label>
      <label class="form-control">
        <div class="label"><span class="label-text text-base-content/50">Longitude</span></div>
        <input type="number" step="0.0001" class="input input-bordered" bind:value={lon} />
      </label>
    </div>

    <div class="flex gap-2 flex-wrap">
      <select class="select select-bordered select-sm md:select-md flex-1 min-w-[5rem]" bind:value={radius}>
        <option value={250}>~250m</option>
        <option value={500}>~500m</option>
        <option value={1000}>~1km</option>
        <option value={2000}>~2km</option>
      </select>
      <select class="select select-bordered select-sm md:select-md w-20 md:w-24" bind:value={resultLimit}>
        <option value={10}>10</option>
        <option value={25}>25</option>
        <option value={50}>50</option>
        <option value={100}>100</option>
      </select>
      <button class="btn btn-primary btn-sm md:btn-md rounded-full flex-1 min-w-[8rem]" onclick={search} disabled={searching}>
        {#if searching}
          <span class="loading loading-spinner loading-sm"></span>
        {:else}
          Find Addresses
        {/if}
      </button>
    </div>

    <!-- Presets -->
    <div class="flex gap-2 overflow-x-auto scrollbar-thin pb-1">
      <button class="preset-pill" onclick={() => setPreset('Puerta del Sol', 40.4168, -3.7038)}>Puerta del Sol</button>
      <button class="preset-pill" onclick={() => setPreset('Times Square', 40.7580, -73.9855)}>Times Sq</button>
      <button class="preset-pill" onclick={() => setPreset('Champs-Élysées', 48.8698, 2.3078)}>Champs-Élysées</button>
      <button class="preset-pill" onclick={() => setPreset('Colosseum', 41.8902, 12.4922)}>Colosseum</button>
      <button class="preset-pill" onclick={() => setPreset('Shibuya', 35.6595, 139.7004)}>Shibuya</button>
      <button class="preset-pill" onclick={() => setPreset('Av Paulista', -23.5614, -46.6558)}>Paulista</button>
      <button class="preset-pill" onclick={() => setPreset('La Rambla', 41.3818, 2.1735)}>La Rambla</button>
      <button class="preset-pill" onclick={() => setPreset('Sydney Opera', -33.8568, 151.2153)}>Opera House</button>
      <button class="preset-pill" onclick={() => setPreset('Hamburg Rathaus', 53.5503, 9.9928)}>Hamburg</button>
    </div>

    <!-- Step log -->
    <StepLog {steps} />

    {#if error}
      <div role="alert" class="alert alert-error">{error}</div>
    {/if}

    <!-- Results -->
    <ResultsTable
      {results}
      {searchTime}
      showDistance
      onRowClick={flyToResult}
      emptyMessage={!searching && steps.length > 0 && !error ? 'No addresses found nearby. Try increasing the radius.' : ''}
    />
  </div>
  {/snippet}

  {#snippet right()}
    <MapView bind:this={mapView} class="h-full w-full" center={[lon, lat]} zoom={12} onMapReady={onMapReady} />
  {/snippet}
</SplitPane>
