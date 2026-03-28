---
name: investigate-data
description: >
  Investigates geocoder data quality issues by querying live S3 parquet files via MotherDuck MCP.
  Use this skill when the user reports a bug in autocomplete results, duplicate entries, missing data,
  wrong city/street/postcode results, or asks to check data for a specific country. Also use when
  the user says 'check the data', 'investigate', 'query S3', 'what does the index look like',
  'how many streets/cities/postcodes', or 'verify the data'. Do NOT use for frontend UI bugs,
  build issues, or code refactoring.
allowed-tools: Read, Grep, Glob, mcp__motherduck__execute_query
---

# Data Investigation Skill

Investigate geocoder data issues by querying live parquet files on S3.

## S3 Base URL
```
https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/walkthru-earth/indices/addresses-index/v1/release=2026-03-18.0/
```

## Workflow

1. **Understand the issue**: What country, what index, what unexpected behavior?

2. **Check the schema first** if unsure about columns:
   ```sql
   DESCRIBE SELECT * FROM read_parquet('...BASE_URL.../city_index/XX.parquet') LIMIT 1;
   ```

3. **Query the relevant index** using MotherDuck MCP (`mcp__motherduck__execute_query`):
   - City issues: `city_index/XX.parquet`
   - Street issues: `street_index/XX.parquet`
   - Postcode issues: `postcode_index/XX.parquet`
   - Number issues: `number_index/country=XX/data_0.parquet` (Hive path!)
   - Tile data: `geocoder/country=XX/h3/HEXHASH.parquet`
   - Global stats: `manifest.parquet`, `tile_index.parquet`

4. **Diagnose the root cause** using these patterns:
   - Duplicates: `GROUP BY key_cols HAVING count(*) > 1`
   - Missing data: `SELECT count(*) FILTER (col IS NULL)`
   - Tile overlap: `list_has_any(tiles, [expected_tiles])`
   - Merged rows: Check bbox span `(bbox_max - bbox_min)` for unreasonably large values
   - Ambiguity: Check `len(tiles)` distribution for a street name

5. **Simulate the fix** by running the corrected query and verifying output.

6. **Cross-validate** by checking 2-3 other countries for the same pattern.

7. **Report** with:
   - Root cause (which pipeline step or data source)
   - SQL evidence (the queries and results)
   - Recommended fix (upstream pipeline SQL or frontend query-time dedup)

## Known Gotchas
- IT, JP, TW, CO have no postcode_index (404)
- FR has no region (depth-1 address_levels only)
- number_index uses Hive path: `country=XX/data_0.parquet`
- City index uses per-country flat files, not global
