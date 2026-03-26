<script lang="ts">
  import { queryObjects, dataPath, tilePath, getTileSource, isTileCached } from '../lib/duckdb'
  import MapView from '../lib/MapView.svelte'
  import SplitPane from '../lib/components/SplitPane.svelte'
  import StepLog from '../lib/components/StepLog.svelte'
  import ResultsTable from '../lib/components/ResultsTable.svelte'
  import maplibregl from 'maplibre-gl'
  import { cellToBoundary } from 'h3-js'
  import { ms, addStep, updateLastStep } from '../lib/utils'
  import type { AddressRow, StepEntry } from '../lib/types'

  let lat = $state(52.3676)
  let lon = $state(4.9041)
  let radius = $state(250)
  let resultLimit = $state(10)
  let results = $state<AddressRow[]>([])
  let searching = $state(false)
  let error = $state('')
  let searchTime = $state(0)
  let steps = $state<StepEntry[]>([])
  let mapView = $state<MapView>()

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
      clickMarker = new maplibregl.Marker({ color: '#36d399' })
        .setLngLat(e.lngLat)
        .addTo(map)

      map.flyTo({ center: e.lngLat, zoom: Math.max(map.getZoom(), 14), duration: 800 })
      search()
    })
  }

  async function search() {
    searching = true
    error = ''
    results = []
    steps = []
    mapView?.clearResultMarkers()

    // Only fly to point when triggered from button (not map click — map already moved)
    // clearResultMarkers above already cleans the old markers

    const totalT0 = performance.now()
    try {
      // Step 1: Compute H3 cells for the search area
      // Res-5 cells are ~10km across. For radius ≤ 2km, a single center cell
      // always covers the entire search area — no grid_disk needed.
      // grid_disk only needed for very large radius (>5km).
      let t0 = performance.now()
      const needDisk = radius > 5000
      const gridK = radius <= 5000 ? 0 : radius <= 10000 ? 1 : 2
      log(`Step 1  H3 res-5 ${needDisk ? `grid_disk(k=${gridK})` : 'center cell'} + parent tile...`, 'loading')

      const h3Result = await queryObjects<{ h3_parent: string; cell_bigint: string; cell_hex: string }>(
        needDisk
          ? `WITH disk AS (
              SELECT UNNEST(h3_grid_disk(h3_latlng_to_cell(${lat}, ${lon}, 5), ${gridK})) AS cell
            )
            SELECT DISTINCT
              h3_h3_to_string(h3_cell_to_parent(cell, 4)) AS h3_parent,
              cell::BIGINT::VARCHAR AS cell_bigint,
              h3_h3_to_string(cell) AS cell_hex
            FROM disk`
          : `SELECT
              h3_h3_to_string(h3_cell_to_parent(h3_latlng_to_cell(${lat}, ${lon}, 5), 4)) AS h3_parent,
              h3_latlng_to_cell(${lat}, ${lon}, 5)::BIGINT::VARCHAR AS cell_bigint,
              h3_h3_to_string(h3_latlng_to_cell(${lat}, ${lon}, 5)) AS cell_hex`
      )

      // Group cells by their parent tile — each cell belongs to exactly one tile
      // Track both BIGINT (for SQL WHERE) and hex (for map visualization)
      const cellsByParent = new Map<string, string[]>()
      const cellBigintsByParent = new Map<string, string[]>()
      for (const r of h3Result) {
        const arr = cellsByParent.get(r.h3_parent) ?? []
        arr.push(r.cell_hex)
        cellsByParent.set(r.h3_parent, arr)
        const bArr = cellBigintsByParent.get(r.h3_parent) ?? []
        bArr.push(r.cell_bigint)
        cellBigintsByParent.set(r.h3_parent, bArr)
      }
      const parents = [...cellsByParent.keys()]
      const totalCells = h3Result.length
      updateLast(`Step 1  ${totalCells} H3 cells → ${parents.length} tile(s) (${ms(t0)})`, 'done')

      // Step 2: Find which tiles exist in our index
      t0 = performance.now()
      log('Step 2  Looking up tiles in cached tile_index...', 'loading')
      const parentList = parents.map(p => `'${p}'`).join(',')
      const tileResults = await queryObjects<{ country: string; h3_parent: string; address_count: number }>(`
        SELECT country, h3_parent, address_count
        FROM _tile_index
        WHERE h3_parent IN (${parentList})
      `)

      if (tileResults.length === 0) {
        updateLast('Step 2  No tiles found — this location has no address coverage', 'error')
        error = 'No address coverage at this location.'
        return
      }

      // Sort tiles: most matching cells first (tile closest to query point)
      tileResults.sort((a, b) => (cellsByParent.get(b.h3_parent)?.length ?? 0) - (cellsByParent.get(a.h3_parent)?.length ?? 0))

      updateLast(`Step 2  Found ${tileResults.length} tile(s) in index, sorted by proximity (${ms(t0)})`, 'done')
      tileResults.forEach(t => {
        const cells = cellsByParent.get(t.h3_parent) ?? []
        const cached = isTileCached(t.country, t.h3_parent)
        log(`        ${t.country}/${t.h3_parent} — ${t.address_count.toLocaleString()} addr, ${cells.length} cell(s)${cached ? ' [cached]' : ''}`)
      })

      // Show H3 grid on map (cells + tile boundaries)
      const queriedTiles = new Set<string>()
      const skippedTiles = new Set<string>()
      showH3OnMap(cellsByParent, tileResults, queriedTiles, skippedTiles)

      // Step 3: Query each tile — use filter pushdown on remote file for uncached tiles
      for (let i = 0; i < tileResults.length; i++) {
        const { country, h3_parent, address_count } = tileResults[i]
        const tileCells = cellsByParent.get(h3_parent) ?? []
        const tileCellBigints = cellBigintsByParent.get(h3_parent) ?? []

        t0 = performance.now()
        // Use BIGINT values for WHERE — enables row-group min/max pushdown
        const cellList = tileCellBigints.join(',')
        const cached = isTileCached(country, h3_parent)
        log(`Step 3  Tile ${i + 1}/${tileResults.length}: ${h3_parent} — ${cached ? 'cached' : 'remote pushdown'}, ${tileCells.length} cell(s)...`, 'loading')

        let tileAddresses: AddressRow[] = []
        try {
          // Use cached tile if available, otherwise query remote directly
          // with h3_index filter pushdown (downloads ~12 MB vs ~48 MB)
          const src = cached
            ? await getTileSource(country, h3_parent)
            : `read_parquet('${tilePath(country, h3_parent)}')`

          tileAddresses = await queryObjects<AddressRow>(`
            WITH addr AS (
              SELECT
                full_address, street, number, city, region, postcode,
                '${country}' AS country,
                ST_Y(geometry) AS lat,
                ST_X(geometry) AS lon,
                h3_h3_to_string(h3_index) AS h3_index
              FROM ${src}
              WHERE h3_index IN (${cellList})
            )
            SELECT *,
              2 * 6371000 * ASIN(SQRT(
                POWER(SIN(RADIANS(lat - ${lat}) / 2), 2) +
                COS(RADIANS(${lat})) * COS(RADIANS(lat)) *
                POWER(SIN(RADIANS(lon - ${lon}) / 2), 2)
              )) AS distance_m
            FROM addr
            ORDER BY distance_m
            LIMIT ${resultLimit}
          `)
        } catch (tileErr: any) {
          console.warn(`[reverse] Tile ${h3_parent} failed:`, tileErr.message)
          updateLast(
            `Step 3  Tile ${i + 1}/${tileResults.length}: ${h3_parent} — failed (${ms(t0)})`,
            'error'
          )
          continue
        }

        queriedTiles.add(h3_parent)

        results = [...results, ...tileAddresses].sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0)).slice(0, resultLimit)
        updateLast(
          `Step 3  Tile ${i + 1}/${tileResults.length}: ${h3_parent} — ${tileAddresses.length} nearby (${ms(t0)})`,
          'done'
        )

        // Update map: markers + tile status
        updateMapMarkers()
        showH3OnMap(cellsByParent, tileResults, queriedTiles, skippedTiles)

        // Early exit: if we have enough results, skip remaining tiles
        if (results.length >= resultLimit) {
          const skipped = tileResults.length - i - 1
          if (skipped > 0) {
            for (let j = i + 1; j < tileResults.length; j++) skippedTiles.add(tileResults[j].h3_parent)
            showH3OnMap(cellsByParent, tileResults, queriedTiles, skippedTiles)
            log(`        Limit reached, skipping ${skipped} tile(s)`, 'done')
          }
          break
        }
      }

      searchTime = performance.now() - totalT0
      log(`Done    ${results.length} results, total: ${ms(totalT0)}`, 'done')
    } catch (e: any) {
      console.error('[reverse] Error:', e)
      error = e.message
      log(`Error: ${e.message}`, 'error')
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
    const parts = [r.city, r.postcode].filter(Boolean).join(' · ')
    return `<div style="font-family:'Quicksand',sans-serif;line-height:1.6;padding:2px 0">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="background:${idx === 0 ? '#36d399' : '#f0a030'};color:${idx === 0 ? '#0a2018' : '#1a1000'};width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">${idx + 1}</span>
        <span style="font-weight:700;font-size:14px">${r.full_address}</span>
      </div>
      ${parts ? `<div style="font-size:13px;opacity:0.6;margin-left:32px">${parts}</div>` : ''}
      <div style="display:flex;align-items:center;gap:8px;margin-left:32px;margin-top:3px">
        <span style="font-size:13px;font-weight:700;color:#36d399">${distStr} away</span>
        <span style="font-size:11px;font-family:monospace;opacity:0.3">${r.lat?.toFixed(5)}, ${r.lon?.toFixed(5)}</span>
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

  /** Show H3 cells and tile boundaries on the map */
  function showH3OnMap(
    cellsByParent: Map<string, string[]>,
    tileResults: { country: string; h3_parent: string; address_count: number }[],
    queriedTiles: Set<string>,
    skippedTiles: Set<string>,
  ) {
    if (!mapView) return

    // Res-5 cells (the actual search area)
    const cellFeatures: GeoJSON.Feature[] = []
    for (const [parent, cells] of cellsByParent) {
      for (const cell of cells) {
        const boundary = cellToBoundary(cell)
        const coords = boundary.map(([lt, ln]) => [ln, lt])
        coords.push(coords[0])
        cellFeatures.push({
          type: 'Feature',
          properties: { cell, parent, queried: queriedTiles.has(parent) ? 'yes' : 'no' },
          geometry: { type: 'Polygon', coordinates: [coords] },
        })
      }
    }

    // Res-5 cells: green when queried, indigo when pending
    mapView.addGeoJSONLayer('h3-cells', { type: 'FeatureCollection', features: cellFeatures }, {
      fillColor: ['match', ['get', 'queried'], 'yes', '#22c55e', '#6366f1'] as any,
      fillOpacity: 0.15,
      lineColor: ['match', ['get', 'queried'], 'yes', '#22c55e', '#6366f1'] as any,
      lineWidth: 2,
    })

    // Res-4 parent tiles: green = done, yellow = pending, gray = skipped
    const tileFeatures: GeoJSON.Feature[] = tileResults.map(t => {
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
          cells: cellsByParent.get(t.h3_parent)?.length ?? 0,
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
      popupFn: (p) => `
        <div style="font-family: monospace; font-size: 12px; line-height: 1.6;">
          <div style="font-weight: bold; margin-bottom: 4px;">${p.country} / ${p.h3_parent}</div>
          <div>Addresses: <b>${Number(p.address_count).toLocaleString()}</b></div>
          <div>Matching cells: <b>${p.cells}</b></div>
          <div>Status: <b style="color: ${p.status === 'queried' ? '#22c55e' : p.status === 'skipped' ? '#64748b' : '#eab308'}">${p.status}</b></div>
        </div>
      `,
    })
  }

  function flyToResult(r: AddressRow) {
    if (!mapView || !r.lat || !r.lon) return
    const idx = results.indexOf(r)
    mapView.openResultPopup(idx)
  }

  function setPreset(name: string, lt: number, ln: number) {
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
    <div class="flex gap-2 flex-wrap">
      <button class="preset-pill" onclick={() => setPreset('Dam Square', 52.3731, 4.8932)}>Dam Square</button>
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
