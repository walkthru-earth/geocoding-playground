import * as duckdb from '@duckdb/duckdb-wasm'

// Public HTTPS URL ,works reliably for all file sizes in DuckDB-WASM.
// S3 protocol fails on large files (416 Range Not Satisfiable) in WASM httpfs.
const DATA_ROOT = 'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/walkthru-earth/indices/addresses-index/v1'
const DEFAULT_RELEASE = '2026-03-18.0'

let currentRelease = DEFAULT_RELEASE
let DATA_BASE = `${DATA_ROOT}/release=${currentRelease}`
let db: duckdb.AsyncDuckDB | null = null
let conn: duckdb.AsyncDuckDBConnection | null = null

/** Get the currently active Overture release tag. */
export function getRelease(): string {
  return currentRelease
}

/** List of known releases ,discovered from _manifest after init. */
export let availableReleases: string[] = [DEFAULT_RELEASE]

type ReleaseChangeCallback = (release: string) => void
let releaseChangeCallbacks: ReleaseChangeCallback[] = []

export function onReleaseChange(cb: ReleaseChangeCallback): () => void {
  releaseChangeCallbacks.push(cb)
  return () => { releaseChangeCallbacks = releaseChangeCallbacks.filter(c => c !== cb) }
}

/**
 * Switch to a different Overture release.
 * Drops all cached tables, re-loads global indexes from the new release.
 */
export async function switchRelease(release: string): Promise<void> {
  if (release === currentRelease) return
  const c = await getConnection()

  // Drop all cached country tables + tile tables
  for (const cc of cachedCountries) {
    try { await c.query(`DROP TABLE IF EXISTS _cities_${cc}`) } catch {}
    try { await c.query(`DROP TABLE IF EXISTS _postcodes_${cc}`) } catch {}
    try { await c.query(`DROP TABLE IF EXISTS _streets_${cc}`) } catch {}
  }
  cachedCountries.clear()

  for (const tile of tileCache.values()) {
    try { await c.query(`DROP TABLE IF EXISTS ${tile.tableName}`) } catch {}
  }
  tileCache.clear()
  tileCacheAddrTotal = 0

  // Switch release
  currentRelease = release
  DATA_BASE = `${DATA_ROOT}/release=${release}`

  // Re-load global indexes
  await c.query(`DROP TABLE IF EXISTS _tile_index`)
  await c.query(`DROP TABLE IF EXISTS _manifest`)
  await c.query(`CREATE TABLE _tile_index AS SELECT * FROM read_parquet('${DATA_BASE}/tile_index.parquet')`)
  await c.query(`CREATE TABLE _manifest AS SELECT * FROM read_parquet('${DATA_BASE}/manifest.parquet')`)
  console.log(`[duckdb] Switched to release ${release}`)

  releaseChangeCallbacks.forEach(cb => cb(release))
}

export async function initDuckDB(): Promise<duckdb.AsyncDuckDBConnection> {
  if (conn) return conn

  console.log('[duckdb] Fetching bundles...')
  const bundles = duckdb.getJsDelivrBundles()
  const bundle = await duckdb.selectBundle(bundles)
  console.log('[duckdb] Bundle selected:', bundle.mainModule)

  console.log('[duckdb] Creating worker...')
  const worker = await duckdb.createWorker(bundle.mainWorker!)
  const logger = new duckdb.ConsoleLogger()
  db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  console.log('[duckdb] Instance created')

  conn = await db.connect()
  console.log('[duckdb] Connected')

  console.log('[duckdb] Installing extensions...')
  await conn.query(`INSTALL httpfs; LOAD httpfs`)
  console.log('[duckdb] httpfs loaded')
  await conn.query(`INSTALL spatial; LOAD spatial`)
  console.log('[duckdb] spatial loaded')
  await conn.query(`INSTALL h3 FROM community; LOAD h3`)
  console.log('[duckdb] h3 loaded')

  // Enable caching for remote Parquet files:
  // - HTTP metadata cache: avoids repeated HEAD requests for the same URL
  // - Parquet metadata cache: avoids re-downloading footers on repeated reads
  await conn.query(`SET enable_http_metadata_cache = true`)
  await conn.query(`SET parquet_metadata_cache = true`)
  console.log('[duckdb] HTTP + Parquet metadata caching enabled')

  // Cache tile_index + manifest at startup via HTTPS (~17K + 39 rows)
  console.log('[duckdb] Caching tile_index + manifest...')
  await conn.query(`CREATE TABLE _tile_index AS SELECT * FROM read_parquet('${DATA_BASE}/tile_index.parquet')`)
  await conn.query(`CREATE TABLE _manifest AS SELECT * FROM read_parquet('${DATA_BASE}/manifest.parquet')`)
  console.log('[duckdb] Global indexes cached, ready!')

  // Discover available releases from manifest
  try {
    const rows = await queryObjects<{ overture_release: string }>(`SELECT DISTINCT overture_release FROM _manifest ORDER BY overture_release DESC`)
    if (rows.length > 0) {
      availableReleases = rows.map(r => r.overture_release)
    }
  } catch { /* keep default */ }

  return conn
}

export async function getConnection(): Promise<duckdb.AsyncDuckDBConnection> {
  if (!conn) return initDuckDB()
  return conn
}

export function dataPath(suffix: string): string {
  return `${DATA_BASE}/${suffix}`
}

export function tilePath(country: string, h3Parent: string): string {
  return `${DATA_BASE}/geocoder/country=${country}/h3/${h3Parent}.parquet`
}

/** Convert Arrow values (lists, structs, bigints) to plain JS */
function toJS(val: any): any {
  if (val === null || val === undefined) return null
  if (val.toArray) return Array.from(val.toArray()).map(toJS)
  if (val.toJSON) return val.toJSON()
  if (typeof val === 'bigint') return Number(val)
  return val
}

export interface QueryResult {
  columns: string[]
  rows: any[][]
}

export async function query(sql: string): Promise<QueryResult> {
  const c = await getConnection()
  const t0 = performance.now()
  console.log('[query]', sql.slice(0, 200).replace(/\s+/g, ' '))
  const result = await c.query(sql)
  const elapsed = (performance.now() - t0).toFixed(0)
  console.log(`[query] ${result.numRows} rows in ${elapsed}ms`)

  const columns = result.schema.fields.map(f => f.name)
  const rows: any[][] = []
  for (let i = 0; i < result.numRows; i++) {
    const row: any[] = []
    for (let j = 0; j < columns.length; j++) {
      row.push(toJS(result.getChildAt(j)?.get(i)))
    }
    rows.push(row)
  }
  return { columns, rows }
}

export async function queryObjects<T = Record<string, any>>(sql: string): Promise<T[]> {
  const { columns, rows } = await query(sql)
  return rows.map(row => {
    const obj: any = {}
    columns.forEach((col, i) => { obj[col] = row[i] })
    return obj as T
  })
}

// ── Tile cache ───────────────────────────────────────────
// After fetching a geocoder tile, keep it as an in-memory table.
// Subsequent queries in the same area skip the network entirely.

interface CachedTile {
  key: string          // "CC_h3parent"
  tableName: string    // "_tile_CC_h3parent"
  addrCount: number    // estimated row count for memory budgeting
  lastUsed: number     // timestamp for LRU eviction
}

const tileCache = new Map<string, CachedTile>()
const TILE_CACHE_MAX_ADDR = 4_000_000 // ~200 MB at ~50 bytes/row
let tileCacheAddrTotal = 0

function tileCacheKey(country: string, h3Parent: string): string {
  return `${country}_${h3Parent}`
}

function tileCacheTableName(country: string, h3Parent: string): string {
  return `_tile_${country}_${h3Parent.replace(/[^a-z0-9]/gi, '')}`
}

async function evictTiles(neededAddr: number): Promise<void> {
  while (tileCacheAddrTotal + neededAddr > TILE_CACHE_MAX_ADDR && tileCache.size > 0) {
    // Find LRU tile
    let oldest: CachedTile | null = null
    for (const t of tileCache.values()) {
      if (!oldest || t.lastUsed < oldest.lastUsed) oldest = t
    }
    if (!oldest) break
    try {
      const c = await getConnection()
      await c.query(`DROP TABLE IF EXISTS ${oldest.tableName}`)
    } catch { /* ignore */ }
    tileCacheAddrTotal -= oldest.addrCount
    tileCache.delete(oldest.key)
    cacheLog(`tile evicted: ${oldest.key} (${oldest.addrCount.toLocaleString()} addr)`)
  }
}

/**
 * Query a geocoder tile, using cached in-memory table if available.
 * Returns the table name to SELECT FROM (either cached or remote URL).
 */
export async function getTileSource(country: string, h3Parent: string): Promise<string> {
  const key = tileCacheKey(country, h3Parent)
  const cached = tileCache.get(key)
  if (cached) {
    cached.lastUsed = Date.now()
    return cached.tableName
  }

  // Estimate row count from tile_index
  let addrCount = 50000 // default estimate
  try {
    const rows = await queryObjects<{ address_count: number }>(`
      SELECT address_count FROM _tile_index
      WHERE country = '${country}' AND h3_parent = '${h3Parent}'
      LIMIT 1
    `)
    if (rows.length > 0) addrCount = rows[0].address_count
  } catch { /* use default */ }

  // Evict if needed
  await evictTiles(addrCount)

  // Fetch and cache
  const tableName = tileCacheTableName(country, h3Parent)
  const url = tilePath(country, h3Parent)
  try {
    const c = await getConnection()
    await c.query(`CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_parquet('${url}')`)
    const entry: CachedTile = { key, tableName, addrCount, lastUsed: Date.now() }
    tileCache.set(key, entry)
    tileCacheAddrTotal += addrCount
    cacheLog(`tile cached: ${key} (${addrCount.toLocaleString()} addr, total: ${tileCacheAddrTotal.toLocaleString()})`)
    return tableName
  } catch (e) {
    // If caching fails, fall back to direct URL read
    return `read_parquet('${url}')`
  }
}

/** Check if a tile is already cached in memory. */
export function isTileCached(country: string, h3Parent: string): boolean {
  return tileCache.has(tileCacheKey(country, h3Parent))
}

// ── Country cache ──────────────────────────────────────────
// When a country is selected, we prefetch ALL its index data
// into DuckDB in-memory tables. All autocomplete queries hit
// these cached tables ,zero network latency.

const cachedCountries = new Set<string>()
let cacheCallbacks: ((msg: string) => void)[] = []

export function onCacheLog(cb: (msg: string) => void): () => void {
  cacheCallbacks.push(cb)
  return () => { cacheCallbacks = cacheCallbacks.filter(c => c !== cb) }
}
function cacheLog(msg: string) {
  console.log('[cache]', msg)
  cacheCallbacks.forEach(cb => cb(msg))
}

export function isCountryCached(cc: string): boolean {
  return cachedCountries.has(cc)
}

export function markCountryCached(cc: string): void {
  cachedCountries.add(cc)
}

export interface PrefetchOptions {
  /** Called after cities are loaded but before postcodes/streets, enabling progressive UI unlock. */
  onCitiesReady?: (cityCount: number) => void
}

/**
 * Prefetch all indexes for a country into DuckDB in-memory tables.
 * Called once when user selects a country. ~1-3s total.
 *
 * Creates: _cities_{CC}, _postcodes_{CC}, _streets_{CC}
 * All autocomplete queries hit these tables ,zero network latency.
 * Enriched columns: primary_city, centroid, bbox available for UX.
 */
export async function prefetchCountry(cc: string, opts?: PrefetchOptions): Promise<{ cities: number; postcodes: number; streets: number }> {
  if (cachedCountries.has(cc)) {
    cacheLog(`${cc} already cached`)
    opts?.onCitiesReady?.(0)
    return { cities: 0, postcodes: 0, streets: 0 }
  }

  const t0 = performance.now()

  // Phase 1: Cities ,fast, unlocks city search immediately
  cacheLog(`${cc}: loading cities...`)
  try {
    await queryObjects(`
      CREATE OR REPLACE TABLE _cities_${cc} AS
      SELECT region, city, tiles, addr_count,
             bbox_min_lon_e6, bbox_max_lon_e6, bbox_min_lat_e6, bbox_max_lat_e6
      FROM read_parquet('${dataPath(`city_index/${cc}.parquet`)}')
    `)
  } catch {
    await queryObjects(`
      CREATE OR REPLACE TABLE _cities_${cc} AS
      SELECT region, city, tiles, addr_count,
             0 AS bbox_min_lon_e6, 0 AS bbox_max_lon_e6,
             0 AS bbox_min_lat_e6, 0 AS bbox_max_lat_e6
      FROM read_parquet('${dataPath('city_index.parquet')}')
      WHERE country = '${cc}'
    `)
  }
  const cRows = await queryObjects<{c: number}>(`SELECT count(*)::INTEGER AS c FROM _cities_${cc}`)
  const cities = cRows[0]?.c ?? 0
  cacheLog(`${cc}: ${cities} cities cached`)
  opts?.onCitiesReady?.(cities)

  // Phase 2: Postcodes + Streets ,loaded after cities to keep city search responsive
  let postcodes = 0
  try {
    cacheLog(`${cc}: loading postcodes...`)
    await queryObjects(`
      CREATE OR REPLACE TABLE _postcodes_${cc} AS
      SELECT postcode, tiles, addr_count,
             COALESCE(centroid_lon_e6, 0) AS centroid_lon_e6,
             COALESCE(centroid_lat_e6, 0) AS centroid_lat_e6
      FROM read_parquet('${dataPath(`postcode_index/${cc}.parquet`)}')
    `)
    const pRows = await queryObjects<{c: number}>(`SELECT count(*)::INTEGER AS c FROM _postcodes_${cc}`)
    postcodes = pRows[0]?.c ?? 0
    cacheLog(`${cc}: ${postcodes} postcodes cached`)
  } catch {
    await queryObjects(`CREATE OR REPLACE TABLE _postcodes_${cc}(postcode VARCHAR, tiles VARCHAR[], addr_count INTEGER, centroid_lon_e6 INTEGER, centroid_lat_e6 INTEGER)`)
    cacheLog(`${cc}: no postcode index available`)
  }

  let streets = 0
  try {
    cacheLog(`${cc}: loading streets...`)
    await queryObjects(`
      CREATE OR REPLACE TABLE _streets_${cc} AS
      SELECT street_lower, tiles, addr_count,
             COALESCE(primary_city, '') AS primary_city,
             COALESCE(centroid_lon_e6, 0) AS centroid_lon_e6,
             COALESCE(centroid_lat_e6, 0) AS centroid_lat_e6
      FROM read_parquet('${dataPath(`street_index/${cc}.parquet`)}')
    `)
    const sRows = await queryObjects<{c: number}>(`SELECT count(*)::INTEGER AS c FROM _streets_${cc}`)
    streets = sRows[0]?.c ?? 0
    cacheLog(`${cc}: ${streets} streets cached`)
  } catch {
    await queryObjects(`CREATE OR REPLACE TABLE _streets_${cc}(street_lower VARCHAR, tiles VARCHAR[], addr_count INTEGER, primary_city VARCHAR, centroid_lon_e6 INTEGER, centroid_lat_e6 INTEGER)`)
    cacheLog(`${cc}: street_index not available yet`)
  }

  cachedCountries.add(cc)
  cacheLog(`${cc}: all indexes cached in ${((performance.now() - t0) / 1000).toFixed(2)}s (${cities} cities, ${postcodes} postcodes, ${streets} streets)`)
  return { cities, postcodes, streets }
}
