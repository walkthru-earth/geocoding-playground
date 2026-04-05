# Data Investigation Rules

When investigating data issues, always query live S3 parquet files. Never guess schemas or row counts.

## S3 base URL
```
https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/walkthru-earth/indices/addresses-index/v4/release=2026-03-18.0/
```

## Query tools (in preference order)
1. MotherDuck MCP: `mcp__motherduck__execute_query` (fastest, no setup)
2. DuckDB CLI via Bash

## Common investigation patterns

**Check schema**: `DESCRIBE SELECT * FROM read_parquet('...url...') LIMIT 1;`

**Check duplicates**: `SELECT col1, col2, count(*) FROM ... GROUP BY col1, col2 HAVING count(*) > 1`

**Check tile overlap with city**: Use `list_has_any(tiles, [city_tiles_array])`

**Simulate fixes**: Create temp table, run proposed query, verify single-row output

## File paths (all Hive-partitioned by country)
- `city_index/country=XX/data_0.parquet` - per-country cities
- `street_index/country=XX/data_0.parquet` - per-country streets
- `postcode_index/country=XX/data_0.parquet` - per-country postcodes
- `number_index/country=XX/data_0.parquet` - per-country house numbers
- `geocoder/country=XX/h3_parent=HEXHASH/data_0.parquet` - address tiles

## Parquet features to verify after pipeline runs
- **number_index**: Should have ~68 row groups for NL (ROW_GROUP_SIZE 2000), bloom filters on `street_lower`, sorting metadata. Check with `parquet_file_metadata()` and `parquet_metadata()`
- **geocoder tiles**: Should have bloom filters on `street` column. Check `bloom_filter_offset IS NOT NULL`
- **All files**: ZSTD compression, Parquet v2 (`format_version = 2`), page indexes (`write_page_index=True`)

## Known data gaps (verified 2026-03-28)
- IT, JP, TW, CO: no postcode_index (Overture has no postcode data)
- FR: no region (depth-1 only). LEFT(postcode, 3) separates overseas territories
- JP numbers in raw Overture are "banchi-coordZone" (e.g., "362-9"). Pipeline strips the zone suffix

## Cross-country validation
After fixing one country, always check 2-3 other countries for the same pattern.
