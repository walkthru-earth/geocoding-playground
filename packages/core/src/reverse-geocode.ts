// Reverse geocode SQL builders and utilities.
// Framework-agnostic, no UI dependencies.

import { validateCC, validateFiniteNumber, validateSourceExpr } from './utils'

export interface Bbox {
  minLon: number
  maxLon: number
  minLat: number
  maxLat: number
}

/** Convert radius in meters to a lat/lon bounding box. Minimum 1km for adequate coverage. */
export function radiusToBbox(lat: number, lon: number, radiusM: number): Bbox {
  const radiusDeg = Math.max(radiusM, 1000) / 111000
  const lonScale = Math.cos((lat * Math.PI) / 180)
  return {
    minLon: +(lon - radiusDeg / lonScale).toFixed(6),
    maxLon: +(lon + radiusDeg / lonScale).toFixed(6),
    minLat: +(lat - radiusDeg).toFixed(6),
    maxLat: +(lat + radiusDeg).toFixed(6),
  }
}

/** Compute H3 grid_disk k value for a given search radius. */
export function gridKForRadius(radiusM: number): number {
  return radiusM <= 5000 ? 0 : radiusM <= 10000 ? 1 : 2
}

export interface TileBucketRow {
  country: string
  region: string
  h3_res4: string
  bucket: string
  address_count: number
}

/**
 * Build SQL to find tile buckets covering a lat/lon point via _tile_index.
 * Uses H3 grid_disk for large radii to cover adjacent tiles.
 */
export function buildTileLookupSQL(lat: number, lon: number, gridK: number): string {
  validateFiniteNumber(lat, 'lat')
  validateFiniteNumber(lon, 'lon')
  if (!Number.isInteger(gridK) || gridK < 0 || gridK > 10) throw new Error(`Invalid gridK: ${gridK}`)
  if (gridK > 0) {
    return `
      WITH disk AS (
        SELECT UNNEST(h3_grid_disk(h3_latlng_to_cell(${lat}, ${lon}, 5), ${gridK})) AS cell
      ),
      cells AS (
        SELECT cell, h3_h3_to_string(h3_cell_to_parent(cell, 4)) AS h3_res4
        FROM disk
      )
      SELECT DISTINCT t.country, COALESCE(t.primary_region, '') AS region,
             t.h3_res4, t.bucket, t.address_count
      FROM cells c
      JOIN _tile_index t ON t.h3_res4 = c.h3_res4
        AND t.h3_index_min <= c.cell AND t.h3_index_max >= c.cell`
  }
  return `
    WITH point AS (
      SELECT h3_latlng_to_cell(${lat}, ${lon}, 5) AS h3_index,
             h3_h3_to_string(h3_cell_to_parent(h3_latlng_to_cell(${lat}, ${lon}, 5), 4)) AS h3_res4
    )
    SELECT t.country, COALESCE(t.primary_region, '') AS region,
           t.h3_res4, t.bucket, t.address_count
    FROM point p
    JOIN _tile_index t ON t.h3_res4 = p.h3_res4
      AND t.h3_index_min <= p.h3_index AND t.h3_index_max >= p.h3_index`
}

/**
 * Build the distance-based reverse geocode SELECT for a tile source.
 * Uses numeric ST_Y/ST_X BETWEEN for bbox pre-filtering (faster than
 * ST_Intersects on DuckDB-WASM 1.3.x). Haversine formula for distance.
 */
export function buildReverseQuerySQL(
  src: string,
  country: string,
  lat: number,
  lon: number,
  bbox: Bbox,
  limit: number,
): string {
  validateSourceExpr(src)
  validateCC(country)
  validateFiniteNumber(lat, 'lat')
  validateFiniteNumber(lon, 'lon')
  validateFiniteNumber(bbox.minLat, 'bbox.minLat')
  validateFiniteNumber(bbox.maxLat, 'bbox.maxLat')
  validateFiniteNumber(bbox.minLon, 'bbox.minLon')
  validateFiniteNumber(bbox.maxLon, 'bbox.maxLon')
  if (!Number.isInteger(limit) || limit <= 0 || limit > 10000) throw new Error(`Invalid limit: ${limit}`)
  return `
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
    WHERE ST_Y(geometry) BETWEEN ${bbox.minLat} AND ${bbox.maxLat}
      AND ST_X(geometry) BETWEEN ${bbox.minLon} AND ${bbox.maxLon}
    ORDER BY distance_m
    LIMIT ${limit}`
}
