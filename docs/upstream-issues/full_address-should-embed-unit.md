# Upstream issue draft: embed `unit` in `full_address` when present

Target repo: `walkthru-earth/walkthru-overture-index`
Files touched: `sql/addresses.sql`

## Problem

Multi-unit buildings in Overture have one row per apartment/suite, each with a
distinct `unit` value (e.g. 1008, 1009, 1010, ...). The pipeline stores `unit`
in the geocoder tile, which is good, but it does **not** embed it in
`full_address`. Every row for a given building therefore collapses to the same
display string.

Example: `195 Clearview AVE, Ottawa, ON` has **328 apartment units** in Overture
(release 2026-04-15.0), all producing identical rows from the consumer's
perspective because `full_address` ignores `unit`.

```sql
-- Raw Overture has 328 distinct ids, each with its own unit
SELECT count(*) AS raw_count,
       count(DISTINCT id) AS distinct_ids,
       count(DISTINCT unit) AS distinct_units
FROM read_parquet('s3://overturemaps-us-west-2/release/2026-04-15.0/theme=addresses/type=address/*', hive_partitioning=1)
WHERE country = 'CA'
  AND lower(street) = 'clearview ave'
  AND number = '195'
  AND postcode = 'K1Z6S1';
-- → 328, 328, 328

-- Pipeline output: same full_address for all 328 rows
SELECT full_address, count(*) AS n
FROM read_parquet('.../release=2026-04-15.0/geocoder/country=CA/h3_res4=842b83bffffffff/bucket=01/data_0.parquet')
WHERE street_lower = 'clearview ave' AND number = '195'
GROUP BY full_address;
-- → "195 Clearview AVE, OTTAWA, ON, K1Z6S1", 328
```

Impact across the index (bucket 01 of Ottawa alone):

| distinct addresses | total rows | addresses with dups | max dup count | dup fraction |
|---|---|---|---|---|
| 34,452 | 48,571 | 1,191 | 349 | 3.5% |

Roughly 3.5% of addresses in that tile are multi-unit buildings. Downstream
geocoders cannot distinguish unit 1008 from unit 2320 without reading `unit`
separately.

## Proposed fix

In `sql/addresses.sql`, include `unit` in the `full_address` synthesis when
present, using a locale-appropriate separator. Two reasonable options:

### Option A, append "Unit {unit}" universally

```sql
concat_ws(', ',
  concat_ws(' ', number, street)                                        -- "195 Clearview AVE"
    || CASE WHEN unit IS NOT NULL THEN ', Unit ' || unit ELSE '' END,    -- ", Unit 1008"
  city,
  region,
  postcode
)
-- → "195 Clearview AVE, Unit 1008, OTTAWA, ON, K1Z6S1"
```

### Option B, locale-aware separator

Use `#` for US/CA (`Apt 1008`), `/` for DE (`1008/`), etc. More faithful to
local convention but adds branching to the pipeline. Probably overkill.

### Recommendation

Option A. Downstream consumers (forward/reverse geocoders) can render `unit`
however they want, but a single fallback string that uniquely identifies each
Overture row is the minimum contract.

## Downstream coordination

The `geocoding-playground` already ships `unit?: string | null` on `AddressRow`
and renders a "Unit X" badge when present. Once the pipeline embeds unit in
`full_address`, the playground can drop the badge and rely on the string
directly. Until then both layers coexist safely.
