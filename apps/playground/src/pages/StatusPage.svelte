<script lang="ts">
  import { queryObjects, dataPath, tilePath, fmt, fmtFull } from '@walkthru-earth/geocoding-core'

  function getMarkerColor(type: 'primary' | 'secondary'): string {
    const prop = type === 'primary' ? '--wt-marker-primary' : '--wt-marker-secondary'
    return getComputedStyle(document.documentElement).getPropertyValue(prop).trim() || (type === 'primary' ? '#36d399' : '#f0a030')
  }
  import type { ManifestRow, TileStatsRow, TileBucket, IndexAvailRow } from '@walkthru-earth/geocoding-core'
  import MapView from '../lib/MapView.svelte'
  import { cellToBoundary, isValidCell } from 'h3-js'

  // ── Tile investigation modal ──────────────────────────────
  interface TileInspect {
    country: string
    h3_parent: string
    address_count: number
    unique_cities: number
    unique_postcodes: number
    primary_region: string
  }
  interface TileDetail {
    topStreets: { street: string; count: number }[]
    topCities: { city: string; count: number }[]
    topPostcodes: { postcode: string; count: number }[]
    sampleAddresses: { full_address: string; street: string; number: string; unit: string; city: string; region: string; postcode: string; lat: number; lon: number }[]
    totalRows: number
    fileUrl: string
    fetchMs: number
  }

  let inspectTile = $state<TileInspect | null>(null)
  let inspectDetail = $state<TileDetail | null>(null)
  let inspectLoading = $state(false)
  let inspectError = $state('')

  // Listen for investigate button clicks from popup HTML
  function handleInvestigate(e: Event) {
    const btn = (e.target as HTMLElement).closest('[data-investigate]') as HTMLElement | null
    if (!btn) return
    const country = btn.dataset.country!
    const h3 = btn.dataset.h3!
    const addrCount = Number(btn.dataset.addresses)
    const cities = Number(btn.dataset.cities)
    const postcodes = Number(btn.dataset.postcodes)
    const region = btn.dataset.region!
    investigateTile({ country, h3_parent: h3, address_count: addrCount, unique_cities: cities, unique_postcodes: postcodes, primary_region: region })
  }

  async function investigateTile(tile: TileInspect) {
    inspectTile = tile
    inspectDetail = null
    inspectError = ''
    inspectLoading = true

    const url = tilePath(tile.country, tile.h3_parent)
    const t0 = performance.now()

    try {
      const [topStreets, topCities, topPostcodes, sampleAddresses, countResult] = await Promise.all([
        queryObjects<{ street: string; count: number }>(`
          SELECT street, count(*)::INTEGER AS count
          FROM read_parquet('${url}')
          WHERE street IS NOT NULL AND street != ''
          GROUP BY street ORDER BY count DESC LIMIT 15
        `),
        queryObjects<{ city: string; count: number }>(`
          SELECT city, count(*)::INTEGER AS count
          FROM read_parquet('${url}')
          WHERE city IS NOT NULL AND city != ''
          GROUP BY city ORDER BY count DESC LIMIT 15
        `),
        queryObjects<{ postcode: string; count: number }>(`
          SELECT postcode, count(*)::INTEGER AS count
          FROM read_parquet('${url}')
          WHERE postcode IS NOT NULL AND postcode != ''
          GROUP BY postcode ORDER BY count DESC LIMIT 15
        `),
        queryObjects<{ full_address: string; street: string; number: string; unit: string; city: string; region: string; postcode: string; lat: number; lon: number }>(`
          SELECT full_address, street, number, unit, city, region, postcode,
                 ST_Y(geometry) AS lat, ST_X(geometry) AS lon
          FROM read_parquet('${url}')
          USING SAMPLE 10
        `),
        queryObjects<{ total: number }>(`
          SELECT count(*)::INTEGER AS total FROM read_parquet('${url}')
        `),
      ])

      inspectDetail = {
        topStreets,
        topCities,
        topPostcodes,
        sampleAddresses,
        totalRows: countResult[0]?.total ?? 0,
        fileUrl: url,
        fetchMs: Math.round(performance.now() - t0),
      }
    } catch (e: any) {
      inspectError = e.message
    } finally {
      inspectLoading = false
    }
  }

  function closeInspect() {
    inspectTile = null
    inspectDetail = null
    inspectError = ''
  }

  // Event delegation for investigate buttons inside map popups
  $effect(() => {
    document.addEventListener('click', handleInvestigate)
    return () => document.removeEventListener('click', handleInvestigate)
  })

  let manifest = $state<ManifestRow[]>([])
  let tileStats = $state<TileStatsRow[]>([])
  let tileBuckets = $state<TileBucket[]>([])
  let indexAvail = $state<IndexAvailRow[]>([])
  let loading = $state(true)
  let error = $state('')
  let mapView = $state<MapView>()
  let mapReady = $state(false)
  let selectedTab = $state<'overview' | 'tiles' | 'quality' | 'countries'>('overview')

  let totalAddresses = $derived(manifest.reduce((s, r) => s + r.address_count, 0))
  let totalTiles = $derived(manifest.reduce((s, r) => s + r.tile_count, 0))
  let totalCountries = $derived(manifest.length)
  let release = $derived(manifest[0]?.overture_release ?? '-')

  let maxCount = $derived(manifest[0]?.address_count ?? 1)

  // Tile size analytics
  let avgTileSize = $derived(totalTiles > 0 ? Math.round(totalAddresses / totalTiles) : 0)
  let maxTileRow = $derived(tileStats.reduce((max, r) => r.max_addr > max.max_addr ? r : max, tileStats[0] ?? { max_addr: 0, country: '' }))

  // Countries with/without indexes
  let countriesWithPostcode = $derived(indexAvail.filter(r => r.has_postcode).length)
  let countriesWithStreet = $derived(indexAvail.filter(r => r.has_street).length)
  let countriesWithCity = $derived(indexAvail.filter(r => r.has_city).length)
  // Autocomplete readiness: has enriched indexes (primary_city + centroid)
  let countriesFullAutocomplete = $derived(indexAvail.filter(r => r.has_street && r.has_city).length)

  // Known issues: depth-1 countries (no region) with oversized bboxes
  function hasOversizedBbox(row: ManifestRow): boolean {
    return (row.bbox_max_lon - row.bbox_min_lon) > 100
  }
  function hasNoRegion(cc: string): boolean {
    const ts = tileStatsFor(cc)
    return ts !== undefined && ts.regions === 0
  }

  // Computed for templates (avoid @const outside valid positions)
  let maxBucketTiles = $derived(Math.max(...tileBuckets.map(b => b.tiles), 1))
  let maxMedian = $derived(Math.max(...tileStats.map(r => r.median_addr), 1))

  // Map layers
  let showCoverage = $state(true)
  let showTiles = $state(true)
  let tilesLoaded = $state(false)
  let tilesLoading = $state(false)

  interface TileGeoRow {
    country: string
    h3_parent: string
    address_count: number
    unique_cities: number
    unique_postcodes: number
    primary_region: string | null
  }

  $effect(() => { loadData() })

  async function loadData() {
    try {
      // Load manifest
      manifest = await queryObjects<ManifestRow>(`
        SELECT country, address_count, tile_count,
               bbox_min_lon, bbox_max_lon, bbox_min_lat, bbox_max_lat,
               overture_release
        FROM _manifest
        ORDER BY address_count DESC
      `)

      // Per-country tile analytics from tile_index
      tileStats = await queryObjects<TileStatsRow>(`
        SELECT
          country,
          count(*)::INTEGER AS tiles,
          sum(address_count)::INTEGER AS total_addr,
          avg(address_count)::INTEGER AS avg_addr,
          median(address_count)::INTEGER AS median_addr,
          max(address_count)::INTEGER AS max_addr,
          min(address_count)::INTEGER AS min_addr,
          sum(unique_postcodes)::INTEGER AS total_postcodes,
          sum(unique_cities)::INTEGER AS total_cities,
          count(DISTINCT primary_region)::INTEGER AS regions
        FROM _tile_index
        GROUP BY country
        ORDER BY total_addr DESC
      `)

      // Tile size distribution (global)
      tileBuckets = await queryObjects<TileBucket>(`
        SELECT
          CASE
            WHEN address_count > 1000000 THEN '1M+'
            WHEN address_count > 500000 THEN '500K–1M'
            WHEN address_count > 100000 THEN '100K–500K'
            WHEN address_count > 50000 THEN '50K–100K'
            WHEN address_count > 10000 THEN '10K–50K'
            WHEN address_count > 1000 THEN '1K–10K'
            ELSE '<1K'
          END AS bucket,
          count(*)::INTEGER AS tiles,
          sum(address_count)::INTEGER AS total_addr,
          CASE
            WHEN address_count > 1000000 THEN 7
            WHEN address_count > 500000 THEN 6
            WHEN address_count > 100000 THEN 5
            WHEN address_count > 50000 THEN 4
            WHEN address_count > 10000 THEN 3
            WHEN address_count > 1000 THEN 2
            ELSE 1
          END AS sort_key
        FROM _tile_index
        GROUP BY bucket, sort_key
        ORDER BY sort_key DESC
      `)

      // Derive index availability from tile_index stats
      // Countries with postcodes in their tiles have postcode_index files
      // Countries with unique_cities > 0 have city data (all do)
      // We can't cheaply probe S3 for file existence, so we use tile_index as proxy
      indexAvail = tileStats.map(ts => ({
        country: ts.country,
        has_postcode: ts.total_postcodes > 0,
        has_street: true, // street_index exists for all countries with address data
        has_city: ts.total_cities > 0, // city_index now per-country
        postcode_count: ts.total_postcodes,
        street_count: 0, // unknown without loading the file
        city_count: ts.total_cities,
      }))
    } catch (e: any) {
      error = e.message
    } finally {
      loading = false
    }
  }

  function onMapReady() { mapReady = true }

  async function loadTilesOnMap() {
    if (tilesLoaded || tilesLoading || !mapView || !mapReady) return
    tilesLoading = true
    try {
      const rows = await queryObjects<TileGeoRow>(`
        SELECT country, h3_parent, address_count, unique_cities, unique_postcodes, primary_region
        FROM _tile_index
      `)
      const features: any[] = []
      for (const row of rows) {
        if (!isValidCell(row.h3_parent)) continue
        const boundary = cellToBoundary(row.h3_parent)
        // h3-js returns [lat, lng] pairs, GeoJSON needs [lng, lat]
        const coords = boundary.map(([lat, lng]) => [lng, lat])
        coords.push(coords[0]) // close polygon
        features.push({
          type: 'Feature' as const,
          properties: {
            country: row.country,
            h3_parent: row.h3_parent,
            address_count: row.address_count,
            unique_cities: row.unique_cities,
            unique_postcodes: row.unique_postcodes,
            primary_region: row.primary_region ?? '-',
          },
          geometry: { type: 'Polygon' as const, coordinates: [coords] },
        })
      }
      mapView.addGeoJSONLayer('tiles', { type: 'FeatureCollection', features }, {
        fillColor: [
          'interpolate', ['linear'], ['get', 'address_count'],
          0, '#22c55e',
          50000, '#eab308',
          200000, '#f97316',
          1000000, '#ef4444',
        ] as any,
        fillOpacity: 0.3,
        lineColor: '#94a3b8',
        lineWidth: 0.5,
        visible: true,
        popupFn: (p) => `
          <div class="popup-mono">
            <div class="popup-mono-title">${p.country} / ${p.h3_parent}</div>
            <div>Addresses: <b>${Number(p.address_count).toLocaleString()}</b></div>
            <div>Cities: <b>${p.unique_cities}</b></div>
            <div>Postcodes: <b>${p.unique_postcodes}</b></div>
            <div>Region: <b>${p.primary_region}</b></div>
            <button
              data-investigate
              data-country="${p.country}"
              data-h3="${p.h3_parent}"
              data-addresses="${p.address_count}"
              data-cities="${p.unique_cities}"
              data-postcodes="${p.unique_postcodes}"
              data-region="${p.primary_region}"
              style="margin-top:6px;padding:3px 10px;font-size:12px;border-radius:6px;background:var(--wt-marker-primary, #36d399);color:#fff;border:none;cursor:pointer;width:100%"
            >Investigate</button>
          </div>
        `,
      })
      tilesLoaded = true
    } finally {
      tilesLoading = false
    }
  }

  function toggleCoverage() {
    showCoverage = !showCoverage
    mapView?.setLayerVisibility('coverage', showCoverage)
  }

  async function toggleTiles() {
    showTiles = !showTiles
    if (showTiles && !tilesLoaded) {
      await loadTilesOnMap()
    } else {
      mapView?.setLayerVisibility('tiles', showTiles)
    }
  }

  function showBboxes() {
    if (!mapView || !mapReady || manifest.length === 0) return
    const features = manifest.map(row => {
      const ts = tileStatsFor(row.country)
      const idx = indexFor(row.country)
      return {
        type: 'Feature' as const,
        properties: {
          country: row.country,
          addresses: row.address_count,
          tiles: row.tile_count,
          release: row.overture_release,
          cities: ts?.total_cities ?? 0,
          postcodes: ts?.total_postcodes ?? 0,
          regions: ts?.regions ?? 0,
          median_addr: ts?.median_addr ?? 0,
          has_postcode: idx?.has_postcode ? 'Yes' : 'No',
          has_street: idx?.has_street ? 'Yes' : 'No',
          bbox: `${row.bbox_min_lon.toFixed(1)}..${row.bbox_max_lon.toFixed(1)}, ${row.bbox_min_lat.toFixed(1)}..${row.bbox_max_lat.toFixed(1)}`,
        },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[
            [row.bbox_min_lon, row.bbox_min_lat],
            [row.bbox_max_lon, row.bbox_min_lat],
            [row.bbox_max_lon, row.bbox_max_lat],
            [row.bbox_min_lon, row.bbox_max_lat],
            [row.bbox_min_lon, row.bbox_min_lat],
          ]],
        },
      }
    })
    mapView.addGeoJSONLayer('coverage', { type: 'FeatureCollection', features }, {
      fillColor: getMarkerColor('primary'),
      fillOpacity: 0.15,
      lineColor: getMarkerColor('primary'),
      lineWidth: 1.5,
      visible: showCoverage,
      popupFn: (p) => {
        const lonSpan = parseFloat(p.bbox.split(',')[0].split('..').reduce((a: string, b: string) => String(parseFloat(b) - parseFloat(a))))
        const isOversized = lonSpan > 100
        return `
        <div class="popup-mono">
          <div class="popup-mono-title">${p.country}</div>
          <div>Addresses: <b>${Number(p.addresses).toLocaleString()}</b></div>
          <div>Tiles: <b>${Number(p.tiles).toLocaleString()}</b></div>
          <div>Cities: <b>${Number(p.cities).toLocaleString()}</b></div>
          <div>Postcodes: <b>${p.postcodes > 0 ? Number(p.postcodes).toLocaleString() : '-'}</b></div>
          <div>Regions: <b>${p.regions > 0 ? p.regions : '-'}</b></div>
          <div>Median/tile: <b>${Number(p.median_addr).toLocaleString()}</b></div>
          <div>Street index: <b>${p.has_street}</b></div>
          <div>Postcode index: <b>${p.has_postcode}</b></div>
          <div>Bbox: <b>${p.bbox}</b></div>
          ${isOversized ? '<div style="color:#eab308;margin-top:4px">Oversized bbox: no region data in Overture, city bboxes merged across overseas territories</div>' : ''}
        </div>
      `},
    })
  }

  function zoomToCountry(row: ManifestRow) {
    mapView?.fitBounds([row.bbox_min_lon, row.bbox_min_lat, row.bbox_max_lon, row.bbox_max_lat])
  }

  $effect(() => {
    if (manifest.length > 0 && mapReady) {
      showBboxes()
      if (showTiles && !tilesLoaded && !tilesLoading) loadTilesOnMap()
    }
  })

  function tileStatsFor(cc: string): TileStatsRow | undefined {
    return tileStats.find(r => r.country === cc)
  }
  function indexFor(cc: string): IndexAvailRow | undefined {
    return indexAvail.find(r => r.country === cc)
  }
</script>

{#if loading}
  <div class="flex justify-center py-16">
    <span class="loading loading-dots loading-lg"></span>
  </div>
{:else if error}
  <div role="alert" class="alert alert-error">{error}</div>
{:else}
  <!-- Hero stats -->
  <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 md:gap-3 mb-4 md:mb-6">
    <div class="stat bg-base-200 rounded-xl p-3 md:p-4">
      <div class="stat-title text-xs">Release</div>
      <div class="stat-value text-primary text-sm md:text-lg">{release}</div>
    </div>
    <div class="stat bg-base-200 rounded-xl p-3 md:p-4">
      <div class="stat-title text-xs">Countries</div>
      <div class="stat-value text-sm md:text-lg">{totalCountries}</div>
    </div>
    <div class="stat bg-base-200 rounded-xl p-3 md:p-4">
      <div class="stat-title text-xs">Total Addresses</div>
      <div class="stat-value text-sm md:text-lg">{fmt(totalAddresses)}</div>
      <div class="stat-desc text-xs">{fmtFull(totalAddresses)}</div>
    </div>
    <div class="stat bg-base-200 rounded-xl p-3 md:p-4">
      <div class="stat-title text-xs">H3 Tiles</div>
      <div class="stat-value text-sm md:text-lg">{fmtFull(totalTiles)}</div>
      <div class="stat-desc text-xs">~{fmt(avgTileSize)} avg/tile</div>
    </div>
    <div class="stat bg-base-200 rounded-xl p-3 md:p-4 col-span-2 sm:col-span-1">
      <div class="stat-title text-xs">Index Files</div>
      <div class="stat-value text-sm md:text-lg">{countriesWithPostcode + countriesWithStreet + countriesWithCity}</div>
      <div class="stat-desc text-xs">{countriesWithCity} city, {countriesWithPostcode} postcode, {countriesWithStreet} street</div>
    </div>
  </div>

  <!-- Tab navigation -->
  <div role="tablist" class="tabs tabs-bordered mb-4 md:mb-6 overflow-x-auto scrollbar-thin">
    <button role="tab" class="tab tab-sm md:tab-md whitespace-nowrap" class:tab-active={selectedTab === 'overview'} onclick={() => selectedTab = 'overview'}>Overview</button>
    <button role="tab" class="tab tab-sm md:tab-md whitespace-nowrap" class:tab-active={selectedTab === 'tiles'} onclick={() => selectedTab = 'tiles'}>Tiles</button>
    <button role="tab" class="tab tab-sm md:tab-md whitespace-nowrap" class:tab-active={selectedTab === 'quality'} onclick={() => selectedTab = 'quality'}>Quality</button>
    <button role="tab" class="tab tab-sm md:tab-md whitespace-nowrap" class:tab-active={selectedTab === 'countries'} onclick={() => selectedTab = 'countries'}>Countries</button>
  </div>

  <!-- Map ,always mounted to avoid WebGL context loss on tab switch -->
  <div class="card bg-base-200 shadow mb-6" class:hidden={selectedTab !== 'overview'}>
    <div class="card-body p-0 overflow-hidden rounded-2xl">
      <div class="flex items-center justify-between px-3 md:px-6 pt-3 md:pt-4 flex-wrap gap-2">
        <h2 class="card-title text-base md:text-lg">Global Coverage</h2>
        <div class="flex gap-2">
          <label class="label cursor-pointer gap-2">
            <span class="label-text text-xs">Bboxes</span>
            <input type="checkbox" class="toggle toggle-xs toggle-primary" checked={showCoverage} onchange={toggleCoverage} />
          </label>
          <label class="label cursor-pointer gap-2">
            <span class="label-text text-xs">H3 Tiles</span>
            <input type="checkbox" class="toggle toggle-xs toggle-secondary" checked={showTiles} onchange={toggleTiles} />
            {#if tilesLoading}
              <span class="loading loading-spinner loading-xs"></span>
            {/if}
          </label>
        </div>
      </div>
      {#if showTiles && tilesLoaded}
        <div class="flex gap-2 md:gap-3 px-3 md:px-6 pb-1 text-xs text-base-content/40 flex-wrap">
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="background:#22c55e;opacity:0.5"></span> &lt;50K</span>
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="background:#eab308;opacity:0.5"></span> 50K</span>
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="background:#f97316;opacity:0.5"></span> 200K</span>
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="background:#ef4444;opacity:0.5"></span> 1M+</span>
          <span class="text-base-content/30 ml-2">Click tile for details</span>
        </div>
      {/if}
      <MapView bind:this={mapView} class="h-56 md:h-96" onMapReady={onMapReady} />
    </div>
  </div>

  <!-- ═══════ OVERVIEW TAB ═══════ -->
  {#if selectedTab === 'overview'}
    <!-- All countries -->
    <div class="card bg-base-200 shadow mb-6">
      <div class="card-body">
        <h2 class="card-title">Countries by Address Count</h2>
        <div class="flex flex-col gap-2 mt-2">
          {#each manifest as row}
            {@const ts = tileStatsFor(row.country)}
            <button class="flex items-center gap-3 hover:bg-base-300 rounded-lg px-2 py-1 transition-colors cursor-pointer" onclick={() => zoomToCountry(row)}>
              <span class="w-8 font-mono text-sm font-bold">{row.country}</span>
              <div class="flex-1 bg-base-300 rounded-full h-6 overflow-hidden">
                <div
                  class="bg-primary h-full rounded-full transition-all"
                  style="width: {(row.address_count / maxCount * 100).toFixed(1)}%"
                ></div>
              </div>
              <span class="text-sm text-base-content/60 w-24 text-right font-mono">{fmt(row.address_count)}</span>
              <span class="text-xs text-base-content/40 w-20 text-right">{row.tile_count} tiles</span>
              {#if ts}
                <span class="text-xs text-base-content/40 w-16 text-right">{ts.regions} reg</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    </div>

    <!-- Tile size distribution -->
    <div class="card bg-base-200 shadow mb-6">
      <div class="card-body">
        <h2 class="card-title">Tile Size Distribution</h2>
        <p class="text-sm text-base-content/50 mb-3">How many addresses per H3 tile ,smaller tiles = faster queries</p>
        <div class="flex flex-col gap-2 mt-2">
          {#each tileBuckets as b}
            <div class="flex items-center gap-3">
              <span class="w-24 font-mono text-xs text-right">{b.bucket}</span>
              <div class="flex-1 bg-base-300 rounded-full h-5 overflow-hidden">
                <div
                  class="h-full rounded-full transition-all"
                  class:bg-success={b.sort_key <= 2}
                  class:bg-info={b.sort_key === 3}
                  class:bg-warning={b.sort_key >= 4 && b.sort_key <= 5}
                  class:bg-error={b.sort_key >= 6}
                  style="width: {(b.tiles / maxBucketTiles * 100).toFixed(1)}%"
                ></div>
              </div>
              <span class="text-xs text-base-content/60 w-20 text-right">{fmtFull(b.tiles)} tiles</span>
              <span class="text-xs text-base-content/40 w-20 text-right">{fmt(b.total_addr)} addr</span>
            </div>
          {/each}
        </div>
        <div class="flex gap-4 mt-3 text-xs text-base-content/40">
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-full bg-success"></span> Fast (&lt;10K)</span>
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-full bg-info"></span> OK (10K-50K)</span>
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-full bg-warning"></span> Slow (50K-500K)</span>
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-full bg-error"></span> Very slow (&gt;500K)</span>
        </div>
      </div>
    </div>

  <!-- ═══════ TILE ANALYTICS TAB ═══════ -->
  {:else if selectedTab === 'tiles'}
    <!-- Per-country tile stats -->
    <div class="card bg-base-200 shadow mb-6">
      <div class="card-body">
        <h2 class="card-title">Per-Country Tile Statistics</h2>
        <p class="text-sm text-base-content/50 mb-2">From the cached tile_index ,median is more representative than average for skewed distributions</p>
        <div class="overflow-x-auto">
          <table class="table table-zebra table-sm">
            <thead>
              <tr>
                <th>Country</th>
                <th class="text-right">Tiles</th>
                <th class="text-right">Total Addr</th>
                <th class="text-right">Median/Tile</th>
                <th class="text-right">Avg/Tile</th>
                <th class="text-right">Max Tile</th>
                <th class="text-right">Min Tile</th>
                <th class="text-right">Skew</th>
                <th class="text-right">Cities</th>
                <th class="text-right">Postcodes</th>
                <th class="text-right">Regions</th>
              </tr>
            </thead>
            <tbody>
              {#each tileStats as row}
                {@const skew = row.median_addr > 0 ? (row.avg_addr / row.median_addr).toFixed(1) : '-'}
                <tr>
                  <td class="font-mono font-bold">{row.country}</td>
                  <td class="text-right font-mono">{fmtFull(row.tiles)}</td>
                  <td class="text-right font-mono">{fmt(row.total_addr)}</td>
                  <td class="text-right font-mono">{fmt(row.median_addr)}</td>
                  <td class="text-right font-mono">{fmt(row.avg_addr)}</td>
                  <td class="text-right font-mono">
                    <span class:text-error={row.max_addr > 500000} class:text-warning={row.max_addr > 100000 && row.max_addr <= 500000}>
                      {fmt(row.max_addr)}
                    </span>
                  </td>
                  <td class="text-right font-mono text-base-content/40">{fmtFull(row.min_addr)}</td>
                  <td class="text-right font-mono" class:text-warning={Number(skew) > 5}>{skew}x</td>
                  <td class="text-right font-mono">{fmt(row.total_cities)}</td>
                  <td class="text-right font-mono">{row.total_postcodes > 0 ? fmt(row.total_postcodes) : '-'}</td>
                  <td class="text-right font-mono">{row.regions > 0 ? row.regions : '-'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Tile density comparison -->
    <div class="card bg-base-200 shadow mb-6">
      <div class="card-body">
        <h2 class="card-title">Tile Density Comparison</h2>
        <p class="text-sm text-base-content/50 mb-3">Median addresses per tile ,lower = faster browser queries</p>
        <div class="flex flex-col gap-1.5">
          {#each tileStats as row}
            <div class="flex items-center gap-2">
              <span class="w-8 font-mono text-xs font-bold">{row.country}</span>
              <div class="flex-1 bg-base-300 rounded-full h-4 overflow-hidden">
                <div
                  class="h-full rounded-full"
                  class:bg-success={row.median_addr < 10000}
                  class:bg-info={row.median_addr >= 10000 && row.median_addr < 50000}
                  class:bg-warning={row.median_addr >= 50000 && row.median_addr < 150000}
                  class:bg-error={row.median_addr >= 150000}
                  style="width: {(row.median_addr / maxMedian * 100).toFixed(1)}%"
                ></div>
              </div>
              <span class="text-xs font-mono text-base-content/50 w-16 text-right">{fmt(row.median_addr)}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- Problem tiles -->
    <div class="card bg-base-200 shadow mb-6">
      <div class="card-body">
        <h2 class="card-title">Oversized Tiles (&gt;500K addresses)</h2>
        <p class="text-sm text-base-content/50 mb-2">These tiles cause slow browser queries (10-60s). Moving to H3 res-5 would ~7x reduce each.</p>
        <div class="overflow-x-auto">
          <table class="table table-zebra table-sm">
            <thead>
              <tr><th>Country</th><th class="text-right">Tiles &gt;500K</th><th class="text-right">Max Tile</th><th class="text-right">Est. Max Size</th></tr>
            </thead>
            <tbody>
              {#each tileStats.filter(r => r.max_addr > 500000) as row}
                {@const estMB = Math.round(row.max_addr * 50 / 1024 / 1024)}
                <tr>
                  <td class="font-mono font-bold">{row.country}</td>
                  <td class="text-right font-mono text-error">{row.max_addr > 1000000 ? '1M+' : '500K+'}</td>
                  <td class="text-right font-mono">{fmtFull(row.max_addr)}</td>
                  <td class="text-right font-mono text-error">~{estMB} MB</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    </div>

  <!-- ═══════ DATA QUALITY TAB ═══════ -->
  {:else if selectedTab === 'quality'}
    <!-- Index availability matrix -->
    <div class="card bg-base-200 shadow mb-6">
      <div class="card-body">
        <h2 class="card-title">Index Availability Matrix</h2>
        <p class="text-sm text-base-content/50 mb-2">Per-country index files on S3 with enriched schema (primary_city, centroid, bbox).</p>
        <div class="overflow-x-auto">
          <table class="table table-zebra table-sm">
            <thead>
              <tr>
                <th>Country</th>
                <th class="text-right">Addresses</th>
                <th class="text-center">City Index</th>
                <th class="text-center">Postcode Index</th>
                <th class="text-center">Street Index</th>
                <th>Autocomplete</th>
              </tr>
            </thead>
            <tbody>
              {#each manifest as row}
                {@const idx = indexFor(row.country)}
                {@const hasCity = idx?.has_city ?? false}
                {@const hasPostcode = idx?.has_postcode ?? false}
                {@const hasStreet = idx?.has_street ?? false}
                {@const readiness = hasStreet && hasPostcode && hasCity ? 'Full' : hasStreet && hasCity ? 'Street + City' : hasCity ? 'City only' : 'Fallback'}
                <tr>
                  <td class="font-mono font-bold">{row.country}</td>
                  <td class="text-right font-mono">{fmt(row.address_count)}</td>
                  <td class="text-center">
                    {#if hasCity}
                      <span class="badge badge-success badge-sm">{fmt(idx?.city_count ?? 0)}</span>
                    {:else}
                      <span class="badge badge-ghost badge-sm">none</span>
                    {/if}
                  </td>
                  <td class="text-center">
                    {#if hasPostcode}
                      <span class="badge badge-success badge-sm">{fmt(idx?.postcode_count ?? 0)}</span>
                    {:else}
                      <span class="badge badge-ghost badge-sm">none</span>
                    {/if}
                  </td>
                  <td class="text-center">
                    {#if hasStreet}
                      <span class="badge badge-success badge-sm">yes</span>
                    {:else}
                      <span class="badge badge-ghost badge-sm">none</span>
                    {/if}
                  </td>
                  <td>
                    <span class="badge badge-sm"
                      class:badge-success={readiness === 'Full'}
                      class:badge-warning={readiness === 'Street + City' || readiness === 'City only'}
                      class:badge-error={readiness === 'Fallback'}
                    >{readiness}</span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Data coverage summary -->
    <div class="card bg-base-200 shadow mb-6">
      <div class="card-body">
        <h2 class="card-title">Coverage Summary</h2>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mt-2">
          <div class="bg-base-300 rounded-xl p-4">
            <div class="text-sm text-base-content/50 mb-1">City Indexes</div>
            <div class="text-2xl font-bold">{countriesWithCity}<span class="text-base font-normal text-base-content/40">/{totalCountries}</span></div>
            <progress class="progress progress-success w-full mt-1" value={countriesWithCity} max={totalCountries}></progress>
            <div class="text-xs text-base-content/40 mt-1">Per-country with bbox for map zoom</div>
          </div>
          <div class="bg-base-300 rounded-xl p-4">
            <div class="text-sm text-base-content/50 mb-1">Postcode Indexes</div>
            <div class="text-2xl font-bold">{countriesWithPostcode}<span class="text-base font-normal text-base-content/40">/{totalCountries}</span></div>
            <progress class="progress progress-success w-full mt-1" value={countriesWithPostcode} max={totalCountries}></progress>
            <div class="text-xs text-base-content/40 mt-1">Missing: {manifest.filter(r => !indexFor(r.country)?.has_postcode).map(r => r.country).join(', ') || 'none'}</div>
          </div>
          <div class="bg-base-300 rounded-xl p-4">
            <div class="text-sm text-base-content/50 mb-1">Street Indexes</div>
            <div class="text-2xl font-bold">{countriesWithStreet}<span class="text-base font-normal text-base-content/40">/{totalCountries}</span></div>
            <progress class="progress progress-success w-full mt-1" value={countriesWithStreet} max={totalCountries}></progress>
            <div class="text-xs text-base-content/40 mt-1">With primary_city + centroid for autocomplete</div>
          </div>
          <div class="bg-base-300 rounded-xl p-4">
            <div class="text-sm text-base-content/50 mb-1">Autocomplete Ready</div>
            <div class="text-2xl font-bold text-success">{countriesFullAutocomplete}<span class="text-base font-normal text-base-content/40">/{totalCountries}</span></div>
            <progress class="progress progress-success w-full mt-1" value={countriesFullAutocomplete} max={totalCountries}></progress>
            <div class="text-xs text-base-content/40 mt-1">JS array search: city + street + postcode</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Known data gaps -->
    <div class="card bg-base-200 shadow mb-6">
      <div class="card-body">
        <h2 class="card-title">Known Data Gaps</h2>
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead><tr><th>Issue</th><th>Countries</th><th>Impact</th><th>Status</th></tr></thead>
            <tbody>
              <tr>
                <td>No postcode data in Overture</td>
                <td class="font-mono text-sm">JP, IT, HK, NZ, CL, CO, EE, RS, TW</td>
                <td>Postcode search unavailable</td>
                <td><span class="badge badge-warning badge-sm">upstream</span></td>
              </tr>
              <tr>
                <td>US city missing for 4.4% of addresses</td>
                <td class="font-mono text-sm">US</td>
                <td>5.5M addresses use state code as city fallback</td>
                <td><a href="https://github.com/OvertureMaps/data/issues/509" class="link link-primary text-sm" target="_blank">#509</a></td>
              </tr>
              <tr>
                <td>Variable address_levels depth</td>
                <td class="font-mono text-sm">LV, SK, EE</td>
                <td>Fixed with COALESCE cascade (was 62% LV, 55% SK missing)</td>
                <td><span class="badge badge-success badge-sm">fixed</span></td>
              </tr>
              <tr>
                <td>No region data, merged city bboxes</td>
                <td class="font-mono text-sm">{manifest.filter(r => { const ts = tileStatsFor(r.country); return ts && ts.regions === 0 }).map(r => r.country).join(', ')}</td>
                <td>Overture gives only city (no region). Same-name cities across territories merge into one row with planet-spanning bboxes (e.g. FR bbox spans -151..167 lon)</td>
                <td><span class="badge badge-warning badge-sm whitespace-nowrap">fix ready</span></td>
              </tr>
              <tr>
                <td>Oversized H3 res-4 tiles</td>
                <td class="font-mono text-sm">TW, BR, CA, US, BE, AU</td>
                <td>Tiles &gt;1M addresses (48+ MB, 30-60s query)</td>
                <td><span class="badge badge-info badge-sm whitespace-nowrap">planned</span></td>
              </tr>
              <tr>
                <td>Enriched index schema</td>
                <td class="font-mono text-sm">all 39 countries</td>
                <td>street: +primary_city, +centroid; postcode: +centroid; city: +bbox, per-country</td>
                <td><span class="badge badge-success badge-sm">deployed</span></td>
              </tr>
              <tr>
                <td>In-memory SQL autocomplete</td>
                <td class="font-mono text-sm">all countries</td>
                <td>DuckDB SQL on prefetched in-memory tables for city, street, and postcode search</td>
                <td><span class="badge badge-success badge-sm">deployed</span></td>
              </tr>
              <tr>
                <td>Mixed ß/ss street names</td>
                <td class="font-mono text-sm">DE, AT, CH</td>
                <td>DE/AT use ß (108K streets), CH uses ss (17.5K streets), 29 DE entries inconsistently use ss. JS normalizer handles both, SQL path does not yet.</td>
                <td><a href="https://github.com/walkthru-earth/geocoding-playground/issues/4" class="link link-primary text-sm" target="_blank">#4</a></td>
              </tr>
              <tr>
                <td>Accent-insensitive search</td>
                <td class="font-mono text-sm">DE, FR, BR, PL, Nordic, Balkans</td>
                <td>Users typing without accents (munchen, sao paulo, lodz) need normalization to match accented data. JS normalizer deployed, SQL path pending.</td>
                <td><a href="https://github.com/walkthru-earth/geocoding-playground/issues/5" class="link link-primary text-sm" target="_blank">#5</a></td>
              </tr>
              <tr>
                <td>DuckDB LIKE ignores NOACCENT collation</td>
                <td class="font-mono text-sm">all countries</td>
                <td>LIKE/ILIKE queries cannot use NOACCENT collation natively. Tracked upstream at duckdb/duckdb#604.</td>
                <td><a href="https://github.com/walkthru-earth/geocoding-playground/issues/6" class="link link-primary text-sm" target="_blank">#6</a></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

  <!-- ═══════ ALL COUNTRIES TAB ═══════ -->
  {:else if selectedTab === 'countries'}
    <div class="card bg-base-200 shadow mb-6">
      <div class="card-body">
        <h2 class="card-title">All {totalCountries} Countries</h2>
        <div class="overflow-x-auto mt-2">
          <table class="table table-zebra table-sm">
            <thead>
              <tr>
                <th>#</th>
                <th>Country</th>
                <th class="text-right">Addresses</th>
                <th class="text-right">Tiles</th>
                <th class="text-right">Avg/Tile</th>
                <th class="text-right">Max Tile</th>
                <th class="text-right">Cities</th>
                <th class="text-right">Postcodes</th>
                <th class="text-right">Streets</th>
                <th class="text-right">Regions</th>
                <th>Bbox</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each manifest as row, i}
                {@const ts = tileStatsFor(row.country)}
                {@const idx = indexFor(row.country)}
                <tr class="hover:bg-base-300 cursor-pointer" onclick={() => zoomToCountry(row)}>
                  <td class="text-base-content/40">{i + 1}</td>
                  <td class="font-mono font-bold">
                    {row.country}
                    {#if hasNoRegion(row.country) && hasOversizedBbox(row)}
                      <span class="badge badge-warning badge-sm ml-1" title="No region data, merged city bboxes">bbox</span>
                    {:else if hasNoRegion(row.country)}
                      <span class="badge badge-ghost badge-sm ml-1" title="No region in Overture (depth-1 address_levels)">no-reg</span>
                    {/if}
                  </td>
                  <td class="text-right font-mono">{fmtFull(row.address_count)}</td>
                  <td class="text-right font-mono">{fmtFull(row.tile_count)}</td>
                  <td class="text-right font-mono">{fmt(Math.round(row.address_count / row.tile_count))}</td>
                  <td class="text-right font-mono">
                    {#if ts}
                      <span class:text-error={ts.max_addr > 500000} class:text-warning={ts.max_addr > 100000 && ts.max_addr <= 500000}>
                        {fmt(ts.max_addr)}
                      </span>
                    {/if}
                  </td>
                  <td class="text-right font-mono">{ts ? fmt(ts.total_cities) : '-'}</td>
                  <td class="text-right font-mono">{idx?.has_postcode ? fmt(idx.postcode_count) : '-'}</td>
                  <td class="text-right font-mono">{idx?.has_street ? fmt(idx.street_count) : '-'}</td>
                  <td class="text-right font-mono">{ts && ts.regions > 1 ? ts.regions : '-'}</td>
                  <td class="text-xs {hasOversizedBbox(row) ? 'text-warning' : 'text-base-content/50'}">
                    {row.bbox_min_lon.toFixed(1)}..{row.bbox_max_lon.toFixed(1)}, {row.bbox_min_lat.toFixed(1)}..{row.bbox_max_lat.toFixed(1)}
                  </td>
                  <td><span class="text-xs opacity-40">zoom</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  {/if}
{/if}

<!-- ═══════ TILE INVESTIGATE MODAL ═══════ -->
{#if inspectTile}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" role="button" tabindex="-1" aria-label="Close modal" onclick={closeInspect} onkeydown={(e) => e.key === 'Escape' && closeInspect()}>
    <div class="bg-base-100 rounded-2xl shadow-2xl w-[95vw] max-w-3xl max-h-[85vh] overflow-hidden flex flex-col" role="dialog" tabindex="-1" aria-modal="true" onclick={(e) => e.stopPropagation()}>
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-3 border-b border-base-content/10">
        <div>
          <h3 class="font-bold text-lg">{inspectTile.country} / {inspectTile.h3_parent}</h3>
          <p class="text-sm text-base-content/50">
            {inspectTile.address_count.toLocaleString()} addresses, {inspectTile.unique_cities} cities, {inspectTile.unique_postcodes} postcodes
            {#if inspectTile.primary_region !== '-'}, region: {inspectTile.primary_region}{/if}
          </p>
        </div>
        <button class="btn btn-ghost btn-sm btn-square" aria-label="Close" onclick={closeInspect}>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto p-5 scrollbar-thin">
        {#if inspectLoading}
          <div class="flex flex-col items-center justify-center py-12 gap-3">
            <span class="loading loading-dots loading-lg text-primary"></span>
            <p class="text-sm text-base-content/40">Querying tile Parquet file...</p>
          </div>
        {:else if inspectError}
          <div role="alert" class="alert alert-error">{inspectError}</div>
        {:else if inspectDetail}
          <div class="text-xs text-base-content/40 mb-4">
            {inspectDetail.totalRows.toLocaleString()} rows queried in {inspectDetail.fetchMs}ms
          </div>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <!-- Top Streets -->
            <div>
              <h4 class="font-bold text-sm mb-2">Top Streets</h4>
              <div class="flex flex-col gap-1">
                {#each inspectDetail.topStreets as s}
                  <div class="flex items-center justify-between text-sm">
                    <span class="truncate mr-2">{s.street}</span>
                    <span class="font-mono text-base-content/50 shrink-0">{s.count.toLocaleString()}</span>
                  </div>
                {/each}
                {#if inspectDetail.topStreets.length === 0}
                  <span class="text-sm text-base-content/30">No street data</span>
                {/if}
              </div>
            </div>

            <!-- Top Cities -->
            <div>
              <h4 class="font-bold text-sm mb-2">Top Cities</h4>
              <div class="flex flex-col gap-1">
                {#each inspectDetail.topCities as c}
                  <div class="flex items-center justify-between text-sm">
                    <span class="truncate mr-2">{c.city}</span>
                    <span class="font-mono text-base-content/50 shrink-0">{c.count.toLocaleString()}</span>
                  </div>
                {/each}
                {#if inspectDetail.topCities.length === 0}
                  <span class="text-sm text-base-content/30">No city data</span>
                {/if}
              </div>
            </div>

            <!-- Top Postcodes -->
            <div>
              <h4 class="font-bold text-sm mb-2">Top Postcodes</h4>
              <div class="flex flex-col gap-1">
                {#each inspectDetail.topPostcodes as p}
                  <div class="flex items-center justify-between text-sm">
                    <span class="truncate mr-2">{p.postcode}</span>
                    <span class="font-mono text-base-content/50 shrink-0">{p.count.toLocaleString()}</span>
                  </div>
                {/each}
                {#if inspectDetail.topPostcodes.length === 0}
                  <span class="text-sm text-base-content/30">No postcode data</span>
                {/if}
              </div>
            </div>
          </div>

          <!-- Sample Addresses -->
          <h4 class="font-bold text-sm mb-2">Sample Addresses (random 10)</h4>
          <div class="overflow-x-auto">
            <table class="table table-sm">
              <thead>
                <tr class="text-base-content/40">
                  <th>Address</th>
                  <th>Street</th>
                  <th>#</th>
                  <th>Unit</th>
                  <th>City</th>
                  <th>Region</th>
                  <th>Postcode</th>
                  <th>Lat</th>
                  <th>Lon</th>
                </tr>
              </thead>
              <tbody>
                {#each inspectDetail.sampleAddresses as a}
                  <tr>
                    <td class="max-w-[200px] truncate">{a.full_address}</td>
                    <td>{a.street}</td>
                    <td>{a.number}</td>
                    <td>{a.unit ?? ''}</td>
                    <td>{a.city}</td>
                    <td>{a.region ?? ''}</td>
                    <td class="font-mono">{a.postcode}</td>
                    <td class="font-mono">{a.lat?.toFixed(5)}</td>
                    <td class="font-mono">{a.lon?.toFixed(5)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>

          <!-- Parquet URL -->
          <div class="mt-4 text-xs text-base-content/30 break-all">
            Source: {inspectDetail.fileUrl}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
