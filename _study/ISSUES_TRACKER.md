# Issues Tracker

Tracks bugs reported by users, root cause analysis, and fixes applied across both repos.

---

## How we investigate issues

Every issue follows the same pattern: understand the query flow in the code, then use DuckDB CLI to query the actual parquet files on S3 and see what the data looks like. This avoids guessing and lets us reproduce the exact behavior the browser sees.

### Data URL pattern

All parquet files live at:
```
https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/walkthru-earth/indices/addresses-index/v1/release=2026-03-18.0/
```

Key files:
- `manifest.parquet` - per-country stats (39 rows)
- `tile_index.parquet` - per-tile stats (~17K rows)
- `city_index/{CC}.parquet` - city names, tiles, addr_count, bbox
- `postcode_index/{CC}.parquet` - postcodes, tiles, addr_count
- `street_index/{CC}.parquet` - street names, tiles, addr_count, primary_city
- `geocoder/country={CC}/h3/{tile}.parquet` - actual address records

### Investigation queries

All queries run with `duckdb` CLI against the remote S3 parquet files.

**1. Check the schema of any index file**

When you don't know what columns exist:

```sql
DESCRIBE SELECT * FROM read_parquet('.../city_index/CA.parquet') LIMIT 1;
```

**2. Find duplicate rows in a city index**

This was the first query to confirm the Ottawa bug. It groups by city+region and counts how many rows each combo has. Anything above 1 is a duplicate.

```sql
SELECT city, region, count(*) as dup_count
FROM read_parquet('.../city_index/CA.parquet')
GROUP BY city, region
HAVING count(*) > 5
ORDER BY dup_count DESC LIMIT 10;
```

**What we're looking for:** If dup_count > 1, the city_index has fragmented rows for the same city. The numbers tell us severity (Ottawa=25, Montreal=95).

**3. Inspect the actual duplicate rows**

Once we know a city is duplicated, look at all its rows to understand WHY they're different:

```sql
SELECT city, region, addr_count, tiles,
       bbox_min_lon_e6, bbox_max_lon_e6, bbox_min_lat_e6, bbox_max_lat_e6
FROM read_parquet('.../city_index/CA.parquet')
WHERE lower(city) = 'ottawa' AND region = 'ON'
ORDER BY addr_count DESC;
```

**What we're looking for:** Do the rows have different tiles? Different bboxes? Same tile but different bboxes means the grouping split one tile's city data into multiple rows. That pointed us to `LEFT(postcode, 3)` in the GROUP BY.

**4. Aggregate to see what the correct single row should look like**

This simulates the fix. If the aggregated result looks correct (single row, merged tiles, proper total), the fix is valid.

```sql
SELECT region, city,
       list_distinct(flatten(list(tiles))) AS tiles,
       sum(addr_count)::INTEGER AS addr_count,
       COALESCE(min(bbox_min_lon_e6), 0) AS bbox_min_lon_e6,
       COALESCE(max(bbox_max_lon_e6), 0) AS bbox_max_lon_e6,
       COALESCE(min(bbox_min_lat_e6), 0) AS bbox_min_lat_e6,
       COALESCE(max(bbox_max_lat_e6), 0) AS bbox_max_lat_e6
FROM read_parquet('.../city_index/CA.parquet')
WHERE lower(city) LIKE '%ottawa%'
GROUP BY region, city
ORDER BY addr_count DESC;
```

**What we're looking for:** Single row per city+region. Total addr_count = sum of all fragments. Tiles = union of all fragment tiles. Bbox = envelope of all fragment bboxes.

**5. Check which streets overlap with a city's tiles**

This was key for the "via cave in Roma" issue. First get Roma's tiles, then check which streets have tile overlap.

```sql
-- Step 1: Get the city's tiles
SELECT list_distinct(flatten(list(tiles))) AS tiles
FROM read_parquet('.../city_index/IT.parquet')
WHERE lower(city) = 'roma';
-- Result: [841e80dffffffff, 841e863ffffffff, 841e805ffffffff, 841e801ffffffff]

-- Step 2: Check which streets matching the prefix are in those tiles
WITH roma_tiles AS (
    SELECT unnest(list_distinct(flatten(list(tiles)))) AS tile
    FROM read_parquet('.../city_index/IT.parquet')
    WHERE lower(city) = 'roma'
)
SELECT s.street_lower, s.primary_city, s.addr_count,
       list_has_any(s.tiles, (SELECT list(tile) FROM roma_tiles)) AS in_roma_tiles
FROM read_parquet('.../street_index/IT.parquet') s
WHERE s.street_lower LIKE 'via cave%'
ORDER BY in_roma_tiles DESC, s.addr_count DESC
LIMIT 20;
```

**What we're looking for:** How many streets matching the prefix actually overlap with the selected city's tiles? If the SQL LIMIT cuts them off before they appear, the autocomplete will miss them. This told us that only 1 of 3 Roma streets was making the top 15.

**6. Simulate the fixed SQL query**

Before changing frontend code, test the exact query we plan to use:

```sql
-- Load into a table to simulate WASM behavior
CREATE TABLE _streets_IT AS SELECT * FROM read_parquet('.../street_index/IT.parquet');

-- The fixed query with city tile boost
SELECT street_lower, primary_city, addr_count
FROM _streets_IT
WHERE street_lower LIKE 'via cave%'
ORDER BY list_has_any(tiles,
  ['841e80dffffffff','841e863ffffffff','841e805ffffffff','841e801ffffffff']::VARCHAR[]) DESC,
  addr_count DESC
LIMIT 15;
```

**What we're looking for:** Do city-local streets now appear at the top? Are non-city streets still included as fallback? Does the query perform well on the in-memory table?

**7. Cross-country validation**

After fixing one country, check if the same problem exists in other countries to confirm the fix is general:

```sql
-- Check multiple countries for the same duplicate pattern
SELECT city, region, count(*) as dup_count
FROM read_parquet('.../city_index/US.parquet')
GROUP BY city, region
HAVING count(*) > 5
ORDER BY dup_count DESC LIMIT 10;
```

**What we're looking for:** If the pattern repeats across countries, the fix needs to be dynamic (GROUP BY at query time) rather than country-specific.

---

## Issue 1: Duplicate city entries in autocomplete

**Reported by:** Diego Ripley via [LinkedIn comment](https://www.linkedin.com/feed/update/urn:li:activity:7443381120324329472?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7443381120324329472%2C7443400143715926016%29&dashCommentUrn=urn%3Ali%3Afsd_comment%3A%287443400143715926016%2Curn%3Ali%3Aactivity%3A7443381120324329472%29)
**GitHub:** [geocoding-playground#1](https://github.com/walkthru-earth/geocoding-playground/issues/1), [walkthru-overture-index#1](https://github.com/walkthru-earth/walkthru-overture-index/issues/1), [geocoding-playground#2](https://github.com/walkthru-earth/geocoding-playground/issues/2)
**Status:** Fixed

### Symptom

Typing "Ottawa" in the city field with country CA shows 25 identical-looking "OTTAWA ON" entries with different address counts (19,126 / 18,181 / 17,102 / ...). Affects all countries. Montreal QC had 95 duplicates, US TX had 220.

### Investigation

Used DuckDB CLI to query the city_index parquet file directly:

```sql
SELECT city, region, count(*) as dup_count
FROM read_parquet('.../city_index/CA.parquet')
GROUP BY city, region
HAVING count(*) > 5
ORDER BY dup_count DESC;
```

Each "OTTAWA ON" row had the same tile (`842b83bffffffff`) but different bboxes and addr_counts. The rows represent different postcode prefix areas within the same city.

### Root cause

In `walkthru-overture-index/sql/addresses.sql` Step 9 (city index build), commit `db87e3b` added:

```sql
GROUP BY country, region, city, LEFT(postcode, 3)
```

This was meant to fix a real problem: FR has no `region` in Overture data, so same-name cities in different territories (mainland vs overseas) would merge into one row with a planet-spanning bbox.

But `LEFT(postcode, 3)` applied to ALL countries, fragmenting cities that already have regions (CA, US, AU, etc.) into one row per 3-char postcode prefix.

### Fix

**Upstream (walkthru-overture-index):** `bdae7ea` - Only apply postcode grouping when region is NULL:

```sql
GROUP BY country, region, city,
  CASE WHEN region IS NULL THEN LEFT(postcode, 3) ELSE NULL END
```

**Frontend (geocoding-playground):** `899a4e9` - Deduplicate at query time (works immediately without index rebuild):

```sql
SELECT region, city,
       list_distinct(flatten(list(tiles))) AS tiles,
       sum(addr_count)::INTEGER AS addr_count,
       COALESCE(min(bbox_min_lon_e6), 0) AS bbox_min_lon_e6,
       COALESCE(max(bbox_max_lon_e6), 0) AS bbox_max_lon_e6,
       COALESCE(min(bbox_min_lat_e6), 0) AS bbox_min_lat_e6,
       COALESCE(max(bbox_max_lat_e6), 0) AS bbox_max_lat_e6
FROM _cities_CA
WHERE lower(city) LIKE '%ottawa%'
GROUP BY region, city
ORDER BY addr_count DESC LIMIT 20
```

---

## Issue 2: Street autocomplete ignores selected city

**Reported by:** User testing IT/Roma with "Via cave"
**GitHub:** [geocoding-playground#3](https://github.com/walkthru-earth/geocoding-playground/issues/3)
**Status:** Fixed

### Symptom

With Roma selected as city and "Via cave" typed, the autocomplete dropdown shows streets from Bagnolo Piemonte, Giussano, Castegnato, etc. instead of prioritizing streets that exist in Roma.

### Investigation

The street autocomplete SQL query sorts globally by `addr_count DESC LIMIT 15`:

```sql
SELECT street_lower, tiles, addr_count, primary_city
FROM _streets_IT
WHERE street_lower LIKE 'via cave%'
ORDER BY addr_count DESC LIMIT 15
```

Verified with DuckDB CLI that only 1 of 3 Roma-area streets made the top 15 because "via cave" in Bagnolo Piemonte has 1,935 addresses vs Roma's "via cave di peperino" with 171.

```sql
-- Streets matching "via cave%" that overlap with Roma tiles
SELECT street_lower, primary_city, addr_count,
       list_has_any(tiles, ['841e80dffffffff','841e863ffffffff','841e805ffffffff','841e801ffffffff']::VARCHAR[]) AS in_roma
FROM _streets_IT
WHERE street_lower LIKE 'via cave%'
ORDER BY in_roma DESC, addr_count DESC;
```

Three Roma streets exist: "via cave di peperino" (171), "via cavento" (29), "via cavernago" (28). Only the first made the original top 15.

### Root cause

The SQL query had no awareness of the selected city. The JS-side `rankSuggestions()` reordered by tile overlap after the fact, but if city-local streets didn't make the SQL's top 15, they were invisible.

### Fix

**Commit `1680446`:** Added `list_has_any(tiles, [city_tiles]) DESC` to the SQL ORDER BY when a city is selected. City-local streets now always appear in the result set. Applied to both street and postcode autocomplete queries.

```javascript
const cityBoost = cityTilesArr.length > 0
  ? `list_has_any(tiles, ['${cityTilesArr.join("','")}']::VARCHAR[]) DESC, `
  : ''
// ORDER BY ${cityBoost}addr_count DESC LIMIT 15
```

---

## Issue 3: Autocomplete ranking penalizes word matches in longer strings

**Reported by:** Follow-up from Issue 2 testing
**GitHub:** [geocoding-playground#3](https://github.com/walkthru-earth/geocoding-playground/issues/3) (same issue, follow-up)
**Status:** Fixed

### Symptom

After the city boost fix, Roma streets appear first, but within the Roma group: "via cavento" (prefix-only match) ranked above "via cave di peperino" (contains "cave" as an exact word).

### Investigation

The ranking used Jaccard bigram similarity, which penalizes longer strings:

| Street | Jaccard score | Problem |
|--------|-------------|---------|
| via cavento | 0.700 | Short string, most bigrams overlap |
| via cavernago | 0.583 | |
| via cave di peperino | **0.389** | "di peperino" adds bigrams, diluting the score |

Jaccard measures `|intersection| / |union|` of character bigrams. A longer string that contains the query as a substring gets punished because the extra characters grow the union without increasing the intersection.

### Root cause

`rankBySimilarity()` uses Jaccard bigram similarity, which is good for fuzzy matching of similar-length strings but wrong for autocomplete where "query appears as a word" should beat "query is a prefix of a shorter string".

### Fix

**Commit `8d13cf7`:** Replaced Jaccard-only ranking with tiered `suggestionScore()`:

| Score | Condition | Example |
|-------|-----------|---------|
| 100 | Exact match | "via cave" = "via cave" |
| 80 | Query as whole words | "via **cave** di peperino" |
| 60 | Prefix match | "via cave**nto**" |
| 40 | Substring | |
| 0-30 | Jaccard fallback | |

Applied within each city/non-city partition. Jaccard is still used as the final fallback for strings that don't match any of the above patterns.

---

## Issue 4: Stale S3 parquet cache causes errors after file updates

**Reported by:** Internal testing
**GitHub:** No dedicated issue (fix included in core)
**Status:** Fixed

### Symptom

After updating parquet files on S3, users see "TProtocolException: Invalid data", "416 Range Not Satisfiable", or "Snappy decompression failure". Only fix was manually clearing browser cache/cookies.

### Investigation

DuckDB-WASM caches three layers of metadata:
1. **HTTP metadata cache** (`enable_http_metadata_cache`) - HEAD request results (ETag, content-length)
2. **Parquet metadata cache** (`parquet_metadata_cache`) - Footer, row group offsets
3. **External file cache** (`enable_external_file_cache`) - In-memory cached file pages

When S3 files are replaced, the cached content-length and footer offsets become stale. The next range request uses wrong byte offsets, returning garbage data that fails to decompress.

Searched DuckDB issues:
- [duckdb/duckdb-wasm#1658](https://github.com/duckdb/duckdb-wasm/issues/1658) - Same error on browser reload
- [duckdb/duckdb-wasm#1957](https://github.com/duckdb/duckdb-wasm/issues/1957) - Corrupt cache reads over HTTP
- [duckdb/duckdb#20167](https://github.com/duckdb/duckdb/issues/20167) - Invalid data after clearing cache_httpfs

DuckDB has **no explicit cache-clear API**. The community extension `cache_httpfs_clear_cache()` actually causes more issues. Toggling settings off/on is the best available method.

### Fix

**Commit `dc75284`:** Added `clearHttpCache()` and `queryRemoteWithRetry()` to `packages/core/src/duckdb.ts`.

All remote parquet reads (`initDuckDB`, `switchRelease`, `prefetchCountry`, `getTileSource`) now use `queryRemoteWithRetry()` which catches failures, flushes all three cache layers by toggling settings off/on, then retries once.

```typescript
export async function clearHttpCache(): Promise<void> {
  const c = await getConnection()
  await c.query(`SET enable_http_metadata_cache = false`)
  await c.query(`SET enable_http_metadata_cache = true`)
  await c.query(`SET parquet_metadata_cache = false`)
  await c.query(`SET parquet_metadata_cache = true`)
  await c.query(`SET enable_external_file_cache = false`)
  await c.query(`SET enable_external_file_cache = true`)
}
```
