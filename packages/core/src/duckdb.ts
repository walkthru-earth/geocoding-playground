import * as duckdb from '@duckdb/duckdb-wasm'
import { validateBucket, validateCC, validateH3 } from './utils'

// Public HTTPS URL for all data access. S3 protocol is slower in WASM
// and glob support is experimental. Pipeline ensures one file per partition.
const DATA_ROOT =
  'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/walkthru-earth/indices/addresses-index/v4'
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

// ── Helpers for country-scoped table names (v4) ──────────────

/**
 * Build a DuckDB-safe quoted identifier for a country-scoped in-memory table.
 * v4 indexes are per-country (not per-region), so only cc is needed.
 */
function countryTable(prefix: string, cc: string): string {
  return `"${prefix}_${cc}"`
}

/**
 * Switch to a different Overture release.
 * Drops all cached tables, re-loads global indexes from the new release.
 */
export async function switchRelease(release: string): Promise<void> {
  if (release === currentRelease) return
  const c = await getConnection()

  // Drop all cached country tables
  for (const cc of cachedCountries) {
    try {
      await c.query(`DROP TABLE IF EXISTS ${countryTable('_cities', cc)}`)
    } catch {}
    try {
      await c.query(`DROP TABLE IF EXISTS ${countryTable('_postcodes', cc)}`)
    } catch {}
    try {
      await c.query(`DROP TABLE IF EXISTS ${countryTable('_streets', cc)}`)
    } catch {}
  }
  cachedCountries.clear()

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
  // Files < 2 MB: download whole file upfront instead of multiple range requests.
  // Small index files (number_index row groups, postcode_index) benefit from this.
  await conn.query(`SET force_download_threshold = 2000000`)
  // S3 files are immutable (versioned by release tag), skip revalidation HEAD requests.
  // Saves ~100ms per file on repeat queries within the same session.
  await conn.query(`SET validate_external_file_cache = 'NO_VALIDATION'`)
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
 * Build a full HTTPS URL for a country-scoped index file (v4).
 * v4 indexes are partitioned by country only (not region).
 */
export function indexPath(type: string, cc: string): string {
  return `${DATA_BASE}/${type}/country=${cc}/data_0.parquet`
}

/**
 * Build a full HTTPS URL for a geocoder tile (v4).
 * v4 tiles use country/h3_res4/bucket partitioning.
 * Normal tiles have bucket='_', mega-tiles have bucket='01','02',...
 */
export function tilePath(country: string, h3Res4: string, bucket: string): string {
  validateCC(country)
  validateH3(h3Res4)
  validateBucket(bucket)
  return `${DATA_BASE}/geocoder/country=${country}/h3_res4=${h3Res4}/bucket=${bucket}/data_0.parquet`
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

/** When true, every query is preceded by EXPLAIN to show the query plan in the console. */
let _explainEnabled = false

/** Toggle EXPLAIN logging for all queries. Call from browser console: toggleExplain() */
export function toggleExplain(on?: boolean): boolean {
  _explainEnabled = on ?? !_explainEnabled
  console.log(`[explain] ${_explainEnabled ? 'ON' : 'OFF'}`)
  return _explainEnabled
}

// Expose on globalThis so you can call toggleExplain() from the browser console
if (typeof globalThis !== 'undefined') {
  ;(globalThis as any).toggleExplain = toggleExplain
}

/**
 * Run EXPLAIN on a SQL statement and log the plan to the console.
 * Only runs for SELECT/WITH statements (skips CREATE/DROP/SET/INSTALL).
 */
async function maybeExplain(c: duckdb.AsyncDuckDBConnection, sql: string): Promise<void> {
  if (!_explainEnabled) return
  const trimmed = sql.trim().toUpperCase()
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) return
  try {
    const result = await c.query(`EXPLAIN ${sql}`)
    const plan: string[] = []
    for (let i = 0; i < result.numRows; i++) {
      const val = result.getChildAt(1)?.get(i)
      if (val) plan.push(String(val))
    }
    console.groupCollapsed(`[explain] ${sql.slice(0, 120).replace(/\s+/g, ' ')}`)
    console.log(plan.join('\n'))
    console.groupEnd()
  } catch {
    // EXPLAIN can fail on some statements, just skip
  }
}

export async function query(sql: string): Promise<QueryResult> {
  const c = await getConnection()
  await maybeExplain(c, sql)
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
  key: string // "CC\0h3Res4\0bucket"
  tableName: string // quoted identifier
  addrCount: number // estimated row count for memory budgeting
  lastUsed: number // timestamp for LRU eviction
}

const tileCache = new Map<string, CachedTile>()
const TILE_CACHE_MAX_ADDR = 4_000_000 // ~200 MB at ~50 bytes/row
let tileCacheAddrTotal = 0

function tileCacheKey(country: string, h3Res4: string, bucket: string): string {
  return `${country}\0${h3Res4}\0${bucket}`
}

function tileCacheTableName(country: string, h3Res4: string, bucket: string): string {
  const safeH3 = h3Res4.replace(/[^a-z0-9]/gi, '')
  const safeBucket = bucket.replace(/[^a-z0-9_]/gi, '')
  return `"_tile_${country}_${safeH3}_${safeBucket}"`
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
 * Query a geocoder tile bucket, using cached in-memory table if available.
 * Returns the table name to SELECT FROM (either cached or remote URL).
 * v4: tiles are identified by (country, h3Res4, bucket).
 */
export async function getTileSource(country: string, h3Res4: string, bucket: string): Promise<string> {
  validateCC(country)
  validateH3(h3Res4)
  validateBucket(bucket)
  const key = tileCacheKey(country, h3Res4, bucket)
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
      WHERE country = '${country}' AND h3_res4 = '${h3Res4}' AND bucket = '${bucket}'
      LIMIT 1
    `)
    if (rows.length > 0) addrCount = rows[0].address_count
  } catch {
    /* use default */
  }

  // Evict if needed
  await evictTiles(addrCount)

  // Fetch and cache
  const tableName = tileCacheTableName(country, h3Res4, bucket)
  const url = tilePath(country, h3Res4, bucket)
  try {
    await queryRemoteWithRetry(`CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_parquet('${url}')`)
    const entry: CachedTile = { key, tableName, addrCount, lastUsed: Date.now() }
    tileCache.set(key, entry)
    tileCacheAddrTotal += addrCount
    cacheLog(
      `tile cached: ${country}/${h3Res4}/${bucket} (${addrCount.toLocaleString()} addr, total: ${tileCacheAddrTotal.toLocaleString()})`,
    )
    return tableName
  } catch (_e) {
    // If caching fails, fall back to direct URL read
    return `read_parquet('${url}')`
  }
}

/** Check if a tile bucket is already cached in memory. */
export function isTileCached(country: string, h3Res4: string, bucket: string): boolean {
  validateCC(country)
  validateH3(h3Res4)
  validateBucket(bucket)
  return tileCache.has(tileCacheKey(country, h3Res4, bucket))
}

/**
 * Expand h3_res4 tile IDs to grouped bucket info via tile_index.
 * Returns one entry per h3_res4 with all its bucket IDs.
 * Normal tiles have one bucket ('_'), mega-tiles have multiple ('01','02',...).
 *
 * Used by forward geocoding to construct `read_parquet([...all bucket URLs...])`
 * per h3_res4 tile, so DuckDB applies pushdown across all buckets in a single query
 * instead of querying each bucket sequentially.
 */
export async function expandTilesToBucketGroups(
  country: string,
  h3Res4s: string[],
): Promise<{ h3Res4: string; buckets: string[]; totalAddresses: number }[]> {
  if (h3Res4s.length === 0) return []
  validateCC(country)
  for (const t of h3Res4s) validateH3(t)
  const tileList = h3Res4s.map((t) => `'${t}'`).join(',')
  return queryObjects<{ h3Res4: string; buckets: string[]; totalAddresses: number }>(`
    SELECT h3_res4 AS "h3Res4",
           list(bucket ORDER BY bucket) AS buckets,
           sum(address_count)::INTEGER AS "totalAddresses"
    FROM _tile_index
    WHERE country = '${country}' AND h3_res4 IN (${tileList})
    GROUP BY h3_res4
    ORDER BY "totalAddresses" DESC
  `)
}

/**
 * Build a read_parquet source expression for all buckets of an h3_res4 tile.
 * For normal tiles (1 bucket), returns a single-file read.
 * For mega-tiles, returns read_parquet([url1, url2, ...]) covering all buckets
 * in a single query, so DuckDB applies per-file pushdown internally.
 */
export function tileSourceExpr(country: string, h3Res4: string, buckets: string[]): string {
  if (buckets.length === 1) {
    return `read_parquet('${tilePath(country, h3Res4, buckets[0])}')`
  }
  const urls = buckets.map((b) => `'${tilePath(country, h3Res4, b)}'`).join(',')
  return `read_parquet([${urls}])`
}

// ── Country cache (v4) ────────────────────────────────────
// When a country is selected, we prefetch ALL its index data
// into DuckDB in-memory tables. All autocomplete queries hit
// these cached tables, zero network latency.
// v4 changed from per-region to per-country indexing.

const cachedCountries = new Set<string>()
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

export function isCountryCached(cc: string): boolean {
  return cachedCountries.has(cc)
}

export function markCountryCached(cc: string): void {
  cachedCountries.add(cc)
}

/**
 * Get the DuckDB quoted table name for a country-scoped index.
 * Exported so the playground can query these tables directly (e.g. for presets).
 */
export function getCountryTable(prefix: string, cc: string): string {
  return countryTable(prefix, cc)
}

export interface PrefetchOptions {
  /** Called after cities are loaded but before postcodes/streets, enabling progressive UI unlock. */
  onCitiesReady?: (cityCount: number) => void
}

/**
 * Prefetch all indexes for a country into DuckDB in-memory tables.
 * Called once when user selects a country.
 *
 * v4: indexes are per-country (not per-region). Creates:
 *   "_cities_{CC}", "_postcodes_{CC}", "_streets_{CC}"
 * All autocomplete queries hit these tables, zero network latency.
 */
export async function prefetchCountry(
  cc: string,
  opts?: PrefetchOptions,
): Promise<{ cities: number; postcodes: number; streets: number }> {
  if (cachedCountries.has(cc)) {
    cacheLog(`${cc} already cached`)
    opts?.onCitiesReady?.(0)
    return { cities: 0, postcodes: 0, streets: 0 }
  }

  const t0 = performance.now()
  const citiesT = countryTable('_cities', cc)
  const postcodesT = countryTable('_postcodes', cc)
  const streetsT = countryTable('_streets', cc)

  // Phase 1: Cities (fast, unlocks city search immediately)
  cacheLog(`${cc}: loading cities...`)
  try {
    await queryRemoteWithRetry(`
      CREATE OR REPLACE TABLE ${citiesT} AS
      SELECT CASE
                 WHEN city LIKE 'Paris % Arrondissement' THEN 'Paris'
                 WHEN city LIKE 'Lyon % Arrondissement' THEN 'Lyon'
                 WHEN city LIKE 'Marseille % Arrondissement' THEN 'Marseille'
                 ELSE city
             END AS city,
             region,
             list_distinct(flatten(list(tiles))) AS tiles,
             sum(addr_count)::INTEGER AS addr_count,
             COALESCE(min(bbox_min_lon_e6), 0) AS bbox_min_lon_e6,
             COALESCE(max(bbox_max_lon_e6), 0) AS bbox_max_lon_e6,
             COALESCE(min(bbox_min_lat_e6), 0) AS bbox_min_lat_e6,
             COALESCE(max(bbox_max_lat_e6), 0) AS bbox_max_lat_e6
      FROM read_parquet('${indexPath('city_index', cc)}')
      GROUP BY CASE
                   WHEN city LIKE 'Paris % Arrondissement' THEN 'Paris'
                   WHEN city LIKE 'Lyon % Arrondissement' THEN 'Lyon'
                   WHEN city LIKE 'Marseille % Arrondissement' THEN 'Marseille'
                   ELSE city
               END,
               region
    `)
  } catch {
    await queryObjects(
      `CREATE OR REPLACE TABLE ${citiesT}(city VARCHAR, region VARCHAR, tiles VARCHAR[], addr_count INTEGER, bbox_min_lon_e6 INTEGER, bbox_max_lon_e6 INTEGER, bbox_min_lat_e6 INTEGER, bbox_max_lat_e6 INTEGER)`,
    )
    cacheLog(`${cc}: no city index available`)
  }
  const cRows = await queryObjects<{ c: number }>(`SELECT count(*)::INTEGER AS c FROM ${citiesT}`)
  const cities = cRows[0]?.c ?? 0
  cacheLog(`${cc}: ${cities} cities cached`)
  opts?.onCitiesReady?.(cities)

  // Phase 2: Postcodes + Streets (loaded after cities to keep city search responsive)
  let postcodes = 0
  try {
    cacheLog(`${cc}: loading postcodes...`)
    await queryRemoteWithRetry(`
      CREATE OR REPLACE TABLE ${postcodesT} AS
      SELECT postcode, tiles, addr_count,
             COALESCE(centroid_lon_e6, 0) AS centroid_lon_e6,
             COALESCE(centroid_lat_e6, 0) AS centroid_lat_e6
      FROM read_parquet('${indexPath('postcode_index', cc)}')
    `)
    const pRows = await queryObjects<{ c: number }>(`SELECT count(*)::INTEGER AS c FROM ${postcodesT}`)
    postcodes = pRows[0]?.c ?? 0
    cacheLog(`${cc}: ${postcodes} postcodes cached`)
  } catch {
    await queryObjects(
      `CREATE OR REPLACE TABLE ${postcodesT}(postcode VARCHAR, tiles VARCHAR[], addr_count INTEGER, centroid_lon_e6 INTEGER, centroid_lat_e6 INTEGER)`,
    )
    cacheLog(`${cc}: no postcode index available`)
  }

  let streets = 0
  try {
    cacheLog(`${cc}: loading streets...`)
    await queryRemoteWithRetry(`
      CREATE OR REPLACE TABLE ${streetsT} AS
      SELECT street_lower, tiles, addr_count,
             COALESCE(primary_city, '') AS primary_city,
             COALESCE(centroid_lon_e6, 0) AS centroid_lon_e6,
             COALESCE(centroid_lat_e6, 0) AS centroid_lat_e6
      FROM read_parquet('${indexPath('street_index', cc)}')
    `)
    const sRows = await queryObjects<{ c: number }>(`SELECT count(*)::INTEGER AS c FROM ${streetsT}`)
    streets = sRows[0]?.c ?? 0
    cacheLog(`${cc}: ${streets} streets cached`)
  } catch {
    await queryObjects(
      `CREATE OR REPLACE TABLE ${streetsT}(street_lower VARCHAR, tiles VARCHAR[], addr_count INTEGER, primary_city VARCHAR, centroid_lon_e6 INTEGER, centroid_lat_e6 INTEGER)`,
    )
    cacheLog(`${cc}: street_index not available yet`)
  }

  cachedCountries.add(cc)
  cacheLog(
    `${cc}: all indexes cached in ${((performance.now() - t0) / 1000).toFixed(2)}s (${cities} cities, ${postcodes} postcodes, ${streets} streets)`,
  )
  return { cities, postcodes, streets }
}
