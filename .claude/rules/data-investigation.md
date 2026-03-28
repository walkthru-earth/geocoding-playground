# Data Investigation Rules

When investigating data issues, always query live S3 parquet files. Never guess schemas or row counts.

## S3 base URL
```
https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/walkthru-earth/indices/addresses-index/v1/release=2026-03-18.0/
```

## Query tools (in preference order)
1. MotherDuck MCP: `mcp__motherduck__execute_query` (fastest, no setup)
2. DuckDB CLI via Bash

## Common investigation patterns

**Check schema**: `DESCRIBE SELECT * FROM read_parquet('...url...') LIMIT 1;`

**Check duplicates**: `SELECT col1, col2, count(*) FROM ... GROUP BY col1, col2 HAVING count(*) > 1`

**Check tile overlap with city**: Use `list_has_any(tiles, [city_tiles_array])`

**Simulate fixes**: Create temp table, run proposed query, verify single-row output

## File paths
- Flat files: `city_index/XX.parquet`, `street_index/XX.parquet`, `postcode_index/XX.parquet`
- Hive paths (not yet flattened): `number_index/country=XX/data_0.parquet`
- Tiles: `geocoder/country=XX/h3/HEXHASH.parquet`

## Known data gaps (verified 2026-03-28)
- IT, JP, TW, CO: no postcode_index (Overture has no postcode data)
- FR: no region (depth-1 only). LEFT(postcode, 3) separates overseas territories
- number_index uses Hive paths (flatten not yet run for this index)

## Cross-country validation
After fixing one country, always check 2-3 other countries for the same pattern.
