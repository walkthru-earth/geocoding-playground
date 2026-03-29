import * as duckdb from '@duckdb/duckdb-wasm'

// Public HTTPS URL for all data access. S3 protocol is slower in WASM
// and glob support is experimental. Pipeline ensures one file per partition.
const DATA_ROOT =
  'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/walkthru-earth/indices/addresses-index/v3'
const DEFAULT_RELEASE = '2026-03-18.0'

let currentRelease = DEFAULT_RELEASE
let DATA_BASE = `${DATA_ROOT}/release=${currentRelease}`
let db: duckdb.AsyncDuckDB | null = null
let conn: duckdb.AsyncDuckDBConnection | null = null

/** Get the currently active Overture release tag. */
export function getRelease(): string {
  return currentRelease
}

let _availableReleases: string[] = [DEFAULT_RELEASE]

/** List of known releases, discovered from _manifest after init. */
export function getAvailableReleases(): readonly string[] {
  return _availableReleases
}

type ReleaseChangeCallback = (release: string) => void
let releaseChangeCallbacks: ReleaseChangeCallback[] = []

export function onReleaseChange(cb: ReleaseChangeCallback): () => void {
  releaseChangeCallbacks.push(cb)
  return () => {
    releaseChangeCallbacks = releaseChangeCallbacks.filter((c) => c !== cb)
  }
}

// ── Helpers for region-scoped table names ────────────────────

/**
 * Build a DuckDB-safe quoted identifier for a region-scoped in-memory table.
 * Uses double-quoted identifiers to handle any Unicode/spaces in region names.
 */
function regionTable(prefix: string, cc: string, region: string): string {
  const safe = region.replace(/"/g, '""')
  return `"${prefix}_${cc}_${safe}"`
}

/** Unique key for region in JavaScript collections (null byte separator). */
function regionKey(cc: string, region: string): string {
  return `${cc}\0${region}`
}

/**
 * Switch to a different Overture release.
 * Drops all cached tables, re-loads global indexes from the new release.
 */
export async function switchRelease(release: string): Promise<void> {
  if (release === currentRelease) return
  const c = await getConnection()

  // Drop all cached region tables
  for (const rk of cachedRegions) {
    const [cc, reg] = rk.split('\0')
    try {
      await c.query(`DROP TABLE IF EXISTS ${regionTable('_cities', cc, reg)}`)
    } catch {}
    try {
      await c.query(`DROP TABLE IF EXISTS ${regionTable('_postcodes', cc, reg)}`)
    } catch {}
    try {
      await c.query(`DROP TABLE IF EXISTS ${regionTable('_streets', cc, reg)}`)
    } catch {}
  }
  cachedRegions.clear()

  for (const tile of tileCache.values()) {
    try {
      await c.query(`DROP TABLE IF EXISTS ${tile.tableName}`)
    } catch {}
  }
  tileCache.clear()
  tileCacheAddrTotal = 0

  // Switch release
  currentRelease = release
  DATA_BASE = `${DATA_ROOT}/release=${release}`

  // Re-load global indexes (with retry for stale cache after release change)
  await c.query(`DROP TABLE IF EXISTS _tile_index`)
  await c.query(`DROP TABLE IF EXISTS _region_index`)
  await c.query(`DROP TABLE IF EXISTS _manifest`)
  await queryRemoteWithRetry(
    `CREATE TABLE _tile_index AS SELECT * FROM read_parquet('${DATA_BASE}/tile_index.parquet')`,
  )
  await queryRemoteWithRetry(
    `CREATE TABLE _region_index AS SELECT * FROM read_parquet('${DATA_BASE}/region_index.parquet')`,
  )
  await queryRemoteWithRetry(`CREATE TABLE _manifest AS SELECT * FROM read_parquet('${DATA_BASE}/manifest.parquet')`)
  console.log(`[duckdb] Switched to release ${release}`)

  releaseChangeCallbacks.forEach((cb) => cb(release))
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

  // Cache tile_index + region_index + manifest at startup via HTTPS
  console.log('[duckdb] Caching tile_index + region_index + manifest...')
  await queryRemoteWithRetry(
    `CREATE TABLE _tile_index AS SELECT * FROM read_parquet('${DATA_BASE}/tile_index.parquet')`,
  )
  await queryRemoteWithRetry(
    `CREATE TABLE _region_index AS SELECT * FROM read_parquet('${DATA_BASE}/region_index.parquet')`,
  )
  await queryRemoteWithRetry(`CREATE TABLE _manifest AS SELECT * FROM read_parquet('${DATA_BASE}/manifest.parquet')`)
  console.log('[duckdb] Global indexes cached, ready!')

  // Discover available releases from manifest
  try {
    const rows = await queryObjects<{ overture_release: string }>(
      `SELECT DISTINCT overture_release FROM _manifest ORDER BY overture_release DESC`,
    )
    if (rows.length > 0) {
      _availableReleases = rows.map((r) => r.overture_release)
    }
  } catch {
    /* keep default */
  }

  return conn
}

export async function getConnection(): Promise<duckdb.AsyncDuckDBConnection> {
  if (!conn) return initDuckDB()
  return conn
}

/**
 * Cancel any in-flight query on the current connection.
 * Uses DuckDB-WASM's low-level cancelPendingQuery API which takes
 * the internal connection handle (number), not the connection object.
 */
export async function cancelPendingQuery(): Promise<boolean> {
  if (!db || !conn) return false
  try {
    // AsyncDuckDBConnection stores the handle as a private numeric ID.
    // Access it via the internal property to pass to the cancel API.
    const handle = (conn as any)._conn as number
    if (typeof handle !== 'number') return false
    return await db.cancelPendingQuery(handle)
  } catch {
    return false
  }
}

export function dataPath(suffix: string): string {
  return `${DATA_BASE}/${suffix}`
}

/**
 * Build a full HTTPS URL for a region-scoped index file.
 * Region values are always URL-safe: either short ASCII codes (US/CA, DE/NW)
 * or H3 hex strings (822e67fffffffff). encodeURIComponent is a no-op for these.
 */
export function indexPath(type: string, cc: string, region: string): string {
  return `${DATA_BASE}/${type}/country=${cc}/region=${encodeURIComponent(region)}/data_0.parquet`
}

export function tilePath(country: string, region: string, h3Parent: string): string {
  return `${DATA_BASE}/geocoder/country=${country}/region=${encodeURIComponent(region)}/h3_parent=${h3Parent}/data_0.parquet`
}

/** Convert Arrow values (lists, structs, bigints) to plain JS */
function toJS(val: any): any {
  if (val === null || val === undefined) return null
  if (val.toArray) return Array.from(val.toArray()).map(toJS)
  if (val.toJSON) return val.toJSON()
  if (typeof val === 'bigint') return Number(val)
  return val
}

/**
 * Flush DuckDB's HTTP metadata, Parquet metadata, and external file caches.
 *
 * When S3 parquet files are replaced, the browser and DuckDB-WASM keep
 * stale cached headers (ETag, content-length) and parquet footers. This
 * causes "TProtocolException: Invalid data", "416 Range Not Satisfiable",
 * or "Snappy decompression failure" on the next read.
 * See: duckdb/duckdb-wasm#1658, duckdb/duckdb#20167
 *
 * DuckDB has no explicit cache-clear API. Toggling the settings off/on
 * is the best available method to flush in-memory metadata.
 */
export async function clearHttpCache(): Promise<void> {
  const c = await getConnection()
  // Flush HTTP metadata cache (HEAD request results: ETag, content-length)
  await c.query(`SET enable_http_metadata_cache = false`)
  await c.query(`SET enable_http_metadata_cache = true`)
  // Flush Parquet metadata cache (footer, row group offsets)
  await c.query(`SET parquet_metadata_cache = false`)
  await c.query(`SET parquet_metadata_cache = true`)
  // Flush external file cache (in-memory cached file pages)
  await c.query(`SET enable_external_file_cache = false`)
  await c.query(`SET enable_external_file_cache = true`)

  // Also purge the browser's HTTP cache for our S3 parquet URLs.
  // DuckDB-WASM uses fetch() internally, and the browser may cache
  // stale responses (wrong content-length, old ETag) even after
  // DuckDB's in-memory caches are flushed.
  if (typeof caches !== 'undefined') {
    try {
      const cacheNames = await caches.keys()
      for (const name of cacheNames) {
        const cache = await caches.open(name)
        const keys = await cache.keys()
        for (const req of keys) {
          if (req.url.includes('opendata.source.coop') && req.url.endsWith('.parquet')) {
            await cache.delete(req)
          }
        }
      }
      console.log('[duckdb] Browser Cache API entries purged')
    } catch {
      /* Cache API not available or permission denied */
    }
  }

  console.log('[duckdb] HTTP + Parquet + external file caches cleared')
}

/**
 * Append a cache-busting query parameter to all URLs in a SQL string.
 * DuckDB-WASM uses fetch() internally, and the browser HTTP cache may
 * serve stale responses even after DuckDB's in-memory caches are cleared.
 * Adding ?_cb=<timestamp> forces the browser to make a fresh request.
 */
function bustUrlCache(sql: string): string {
  const cb = `_cb=${Date.now()}`
  return sql.replace(/(read_parquet\(['"])([^'"]+)(['"]\))/g, (_match, pre, url, post) => {
    const sep = url.includes('?') ? '&' : '?'
    return `${pre}${url}${sep}${cb}${post}`
  })
}

/**
 * Run a SQL statement that reads remote parquet files.
 * On failure, clears all HTTP/parquet caches and retries once
 * with cache-busted URLs to bypass stale browser HTTP cache.
 */
async function queryRemoteWithRetry(sql: string): Promise<void> {
  const c = await getConnection()
  try {
    await c.query(sql)
  } catch (e) {
    console.warn('[duckdb] Remote query failed, clearing caches and retrying:', (e as Error).message?.slice(0, 120))
    await clearHttpCache()
    await c.query(bustUrlCache(sql))
  }
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

  const columns = result.schema.fields.map((f) => f.name)
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
  return rows.map((row) => {
    const obj: any = {}
    columns.forEach((col, i) => {
      obj[col] = row[i]
    })
    return obj as T
  })
}

/**
 * Like queryObjects, but clears HTTP/parquet caches and retries once on failure.
 * Retries with cache-busted URLs to bypass stale browser HTTP cache.
 * Use this for queries that read remote parquet files directly (not cached tables).
 */
export async function queryObjectsWithRetry<T = Record<string, any>>(sql: string): Promise<T[]> {
  try {
    return await queryObjects<T>(sql)
  } catch (e) {
    console.warn('[duckdb] Remote query failed, clearing caches and retrying:', (e as Error).message?.slice(0, 120))
    await clearHttpCache()
    return await queryObjects<T>(bustUrlCache(sql))
  }
}

// ── Tile cache ───────────────────────────────────────────
// After fetching a geocoder tile, keep it as an in-memory table.
// Subsequent queries in the same area skip the network entirely.

interface CachedTile {
  key: string // "CC\0region\0h3parent"
  tableName: string // quoted identifier
  addrCount: number // estimated row count for memory budgeting
  lastUsed: number // timestamp for LRU eviction
}

const tileCache = new Map<string, CachedTile>()
const TILE_CACHE_MAX_ADDR = 4_000_000 // ~200 MB at ~50 bytes/row
let tileCacheAddrTotal = 0

function tileCacheKey(country: string, region: string, h3Parent: string): string {
  return `${country}\0${region}\0${h3Parent}`
}

function tileCacheTableName(country: string, region: string, h3Parent: string): string {
  const safeRegion = region.replace(/"/g, '""')
  return `"_tile_${country}_${safeRegion}_${h3Parent.replace(/[^a-z0-9]/gi, '')}"`
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
    } catch {
      /* ignore */
    }
    tileCacheAddrTotal -= oldest.addrCount
    tileCache.delete(oldest.key)
    cacheLog(`tile evicted: ${oldest.key} (${oldest.addrCount.toLocaleString()} addr)`)
  }
}

/**
 * Query a geocoder tile, using cached in-memory table if available.
 * Returns the table name to SELECT FROM (either cached or remote URL).
 */
export async function getTileSource(country: string, region: string, h3Parent: string): Promise<string> {
  const key = tileCacheKey(country, region, h3Parent)
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
      WHERE country = '${country}' AND region = '${region.replace(/'/g, "''")}' AND h3_parent = '${h3Parent}'
      LIMIT 1
    `)
    if (rows.length > 0) addrCount = rows[0].address_count
  } catch {
    /* use default */
  }

  // Evict if needed
  await evictTiles(addrCount)

  // Fetch and cache
  const tableName = tileCacheTableName(country, region, h3Parent)
  const url = tilePath(country, region, h3Parent)
  try {
    await queryRemoteWithRetry(`CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_parquet('${url}')`)
    const entry: CachedTile = { key, tableName, addrCount, lastUsed: Date.now() }
    tileCache.set(key, entry)
    tileCacheAddrTotal += addrCount
    cacheLog(
      `tile cached: ${country}/${region}/${h3Parent} (${addrCount.toLocaleString()} addr, total: ${tileCacheAddrTotal.toLocaleString()})`,
    )
    return tableName
  } catch (_e) {
    // If caching fails, fall back to direct URL read
    return `read_parquet('${url}')`
  }
}

/** Check if a tile is already cached in memory. */
export function isTileCached(country: string, region: string, h3Parent: string): boolean {
  return tileCache.has(tileCacheKey(country, region, h3Parent))
}

// ── Region cache ──────────────────────────────────────────
// When a region is selected, we prefetch ALL its index data
// into DuckDB in-memory tables. All autocomplete queries hit
// these cached tables, zero network latency.

const cachedRegions = new Set<string>()
let cacheCallbacks: ((msg: string) => void)[] = []

export function onCacheLog(cb: (msg: string) => void): () => void {
  cacheCallbacks.push(cb)
  return () => {
    cacheCallbacks = cacheCallbacks.filter((c) => c !== cb)
  }
}
function cacheLog(msg: string) {
  console.log('[cache]', msg)
  cacheCallbacks.forEach((cb) => cb(msg))
}

export function isRegionCached(cc: string, region: string): boolean {
  return cachedRegions.has(regionKey(cc, region))
}

export function markRegionCached(cc: string, region: string): void {
  cachedRegions.add(regionKey(cc, region))
}

/**
 * Get the DuckDB quoted table name for a region-scoped index.
 * Exported so the playground can query these tables directly (e.g. for presets).
 */
export function getRegionTable(prefix: string, cc: string, region: string): string {
  return regionTable(prefix, cc, region)
}

export interface PrefetchOptions {
  /** Called after cities are loaded but before postcodes/streets, enabling progressive UI unlock. */
  onCitiesReady?: (cityCount: number) => void
}

/**
 * Prefetch all indexes for a region into DuckDB in-memory tables.
 * Called once when user selects a region. ~0.5-1.5s total (much faster than full country).
 *
 * Creates: "_cities_{CC}_{region}", "_postcodes_{CC}_{region}", "_streets_{CC}_{region}"
 * All autocomplete queries hit these tables, zero network latency.
 */
export async function prefetchRegion(
  cc: string,
  region: string,
  opts?: PrefetchOptions,
): Promise<{ cities: number; postcodes: number; streets: number }> {
  const rk = regionKey(cc, region)
  if (cachedRegions.has(rk)) {
    cacheLog(`${cc}/${region} already cached`)
    opts?.onCitiesReady?.(0)
    return { cities: 0, postcodes: 0, streets: 0 }
  }

  const t0 = performance.now()
  const citiesT = regionTable('_cities', cc, region)
  const postcodesT = regionTable('_postcodes', cc, region)
  const streetsT = regionTable('_streets', cc, region)

  // Phase 1: Cities, fast, unlocks city search immediately
  cacheLog(`${cc}/${region}: loading cities...`)
  try {
    await queryRemoteWithRetry(`
      CREATE OR REPLACE TABLE ${citiesT} AS
      SELECT CASE
                 WHEN city LIKE 'Paris % Arrondissement' THEN 'Paris'
                 WHEN city LIKE 'Lyon % Arrondissement' THEN 'Lyon'
                 WHEN city LIKE 'Marseille % Arrondissement' THEN 'Marseille'
                 ELSE city
             END AS city,
             list_distinct(flatten(list(tiles))) AS tiles,
             sum(addr_count)::INTEGER AS addr_count,
             COALESCE(min(bbox_min_lon_e6), 0) AS bbox_min_lon_e6,
             COALESCE(max(bbox_max_lon_e6), 0) AS bbox_max_lon_e6,
             COALESCE(min(bbox_min_lat_e6), 0) AS bbox_min_lat_e6,
             COALESCE(max(bbox_max_lat_e6), 0) AS bbox_max_lat_e6
      FROM read_parquet('${indexPath('city_index', cc, region)}')
      GROUP BY CASE
                   WHEN city LIKE 'Paris % Arrondissement' THEN 'Paris'
                   WHEN city LIKE 'Lyon % Arrondissement' THEN 'Lyon'
                   WHEN city LIKE 'Marseille % Arrondissement' THEN 'Marseille'
                   ELSE city
               END
    `)
  } catch {
    // Fallback: create empty table
    await queryObjects(
      `CREATE OR REPLACE TABLE ${citiesT}(city VARCHAR, tiles VARCHAR[], addr_count INTEGER, bbox_min_lon_e6 INTEGER, bbox_max_lon_e6 INTEGER, bbox_min_lat_e6 INTEGER, bbox_max_lat_e6 INTEGER)`,
    )
    cacheLog(`${cc}/${region}: no city index available`)
  }
  const cRows = await queryObjects<{ c: number }>(`SELECT count(*)::INTEGER AS c FROM ${citiesT}`)
  const cities = cRows[0]?.c ?? 0
  cacheLog(`${cc}/${region}: ${cities} cities cached`)
  opts?.onCitiesReady?.(cities)

  // Phase 2: Postcodes + Streets, loaded after cities to keep city search responsive
  let postcodes = 0
  try {
    cacheLog(`${cc}/${region}: loading postcodes...`)
    await queryRemoteWithRetry(`
      CREATE OR REPLACE TABLE ${postcodesT} AS
      SELECT postcode, tiles, addr_count,
             COALESCE(centroid_lon_e6, 0) AS centroid_lon_e6,
             COALESCE(centroid_lat_e6, 0) AS centroid_lat_e6
      FROM read_parquet('${indexPath('postcode_index', cc, region)}')
    `)
    const pRows = await queryObjects<{ c: number }>(`SELECT count(*)::INTEGER AS c FROM ${postcodesT}`)
    postcodes = pRows[0]?.c ?? 0
    cacheLog(`${cc}/${region}: ${postcodes} postcodes cached`)
  } catch {
    await queryObjects(
      `CREATE OR REPLACE TABLE ${postcodesT}(postcode VARCHAR, tiles VARCHAR[], addr_count INTEGER, centroid_lon_e6 INTEGER, centroid_lat_e6 INTEGER)`,
    )
    cacheLog(`${cc}/${region}: no postcode index available`)
  }

  let streets = 0
  try {
    cacheLog(`${cc}/${region}: loading streets...`)
    await queryRemoteWithRetry(`
      CREATE OR REPLACE TABLE ${streetsT} AS
      SELECT street_lower, tiles, addr_count,
             COALESCE(primary_city, '') AS primary_city,
             COALESCE(centroid_lon_e6, 0) AS centroid_lon_e6,
             COALESCE(centroid_lat_e6, 0) AS centroid_lat_e6
      FROM read_parquet('${indexPath('street_index', cc, region)}')
    `)
    const sRows = await queryObjects<{ c: number }>(`SELECT count(*)::INTEGER AS c FROM ${streetsT}`)
    streets = sRows[0]?.c ?? 0
    cacheLog(`${cc}/${region}: ${streets} streets cached`)
  } catch {
    await queryObjects(
      `CREATE OR REPLACE TABLE ${streetsT}(street_lower VARCHAR, tiles VARCHAR[], addr_count INTEGER, primary_city VARCHAR, centroid_lon_e6 INTEGER, centroid_lat_e6 INTEGER)`,
    )
    cacheLog(`${cc}/${region}: street_index not available yet`)
  }

  cachedRegions.add(rk)
  cacheLog(
    `${cc}/${region}: all indexes cached in ${((performance.now() - t0) / 1000).toFixed(2)}s (${cities} cities, ${postcodes} postcodes, ${streets} streets)`,
  )
  return { cities, postcodes, streets }
}
