// Forward geocode SQL builders.
// Framework-agnostic, no UI dependencies.

import { getTileSource, isTileCached, tilePath, tileSourceExpr } from './duckdb'
import { validateCC, validateH3, validateSourceExpr } from './utils'

/**
 * Resolve a safe `FROM` source expression for a single h3_res4 tile.
 *
 * The returned string is always either a cached tile identifier
 * (`"_tile_XX_..."`) or a `read_parquet('...')` / `read_parquet([...])`
 * expression with validated HTTPS URLs. Callers can pass it directly
 * into `FROM ${src}` after a `validateSourceExpr()` check.
 *
 * Keeps all tile source string construction inside core so the Svelte
 * playground never builds raw SQL or parquet URL expressions.
 */
export async function resolveTileSource(
  country: string,
  h3Res4: string,
  buckets: string[],
  opts: { preferCache?: boolean } = {},
): Promise<string> {
  validateCC(country)
  validateH3(h3Res4)
  if (buckets.length === 0) throw new Error('resolveTileSource: buckets is empty')
  const preferCache = opts.preferCache ?? true
  // Multi-bucket tiles always use a direct parquet read so DuckDB can apply
  // per-file filter pushdown across all buckets in one query.
  if (buckets.length > 1) return tileSourceExpr(country, h3Res4, buckets)
  // Single-bucket tile: prefer the in-memory cache unless the caller opts out
  // (e.g. when pushdown on the parquet file beats a cached scan).
  if (preferCache) return getTileSource(country, h3Res4, buckets[0])
  if (isTileCached(country, h3Res4, buckets[0])) {
    return getTileSource(country, h3Res4, buckets[0])
  }
  return tileSourceExpr(country, h3Res4, buckets)
}

/**
 * Build a `read_parquet([...])` expression that spans every bucket of
 * several h3_res4 tiles. Used for the batch forward-geocode path where
 * DuckDB applies filter pushdown across all parquet files in one query.
 */
export function batchTilesSourceExpr(country: string, tiles: { h3Res4: string; buckets: string[] }[]): string {
  validateCC(country)
  if (tiles.length === 0) throw new Error('batchTilesSourceExpr: no tiles')
  const urls: string[] = []
  for (const { h3Res4, buckets } of tiles) {
    validateH3(h3Res4)
    for (const b of buckets) urls.push(`'${tilePath(country, h3Res4, b)}'`)
  }
  return `read_parquet([${urls.join(',')}])`
}

/**
 * Build the SELECT used by the forward geocode per-tile query. Validates
 * the `src` expression against the safe-source whitelist and bounds the
 * `limit` to reject non-integers and unreasonable values.
 *
 * `where` is the output of a parser's `buildWhereClause(parsed)` and is
 * trusted to contain properly escaped values (the parsers use `esc()`).
 */
export function buildForwardTileQuerySQL(src: string, where: string, limit: number): string {
  validateSourceExpr(src)
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100000) {
    throw new Error(`Invalid limit: ${limit}`)
  }
  return `
    SELECT full_address, street, number, unit, city, region, postcode,
           ST_Y(geometry) AS lat, ST_X(geometry) AS lon,
           h3_h3_to_string(h3_index) AS h3_index
    FROM ${src}
    WHERE ${where}
    LIMIT ${limit}`
}
