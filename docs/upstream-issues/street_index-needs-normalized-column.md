# Upstream issue draft: add `street_norm` (accent-stripped) column to `street_index`

Target repo: `walkthru-earth/walkthru-overture-index`
Files touched: `sql/addresses.sql` (street_index build), `main.py` (Parquet writer options)

## Problem

Autocomplete needs to match user input that drops accents or uses alternate
forms. A user typing `munchen` must find `München`, `hauptstrasse` must find
`hauptstraße`, `lodz` must find `łódź`. These are the cases tracked in
#4 (ß↔ss), #5 (general accents), and #6 (DuckDB-WASM missing
`strip_accents`).

The playground receives `street_lower` (Overture's case-folded street name) in
`street_index` but **nothing accent-stripped**. All accent-insensitive matching
has to happen client-side.

## Why we cannot fix this client-side

We tried two approaches in the playground, both failed:

1. **SQL `LIKE` on `street_lower`** (current default). Exact byte match, so
   `munchen` never finds `münchen`. Known gap, tracked in #4/#5/#6.

2. **Pull `_streets_{CC}` into a JS array + `preNormalize` (NFKD + ligature
   map) at prefetch time, then `searchStreets` on every keystroke.** This
   works for small countries but is unusable at scale:
   - DE has 387K streets, US has ~2M+. Pulling the full table through
     DuckDB-WASM's Arrow decode (including the `tiles VARCHAR[]` column per
     row) is heavy.
   - The synchronous `preNormalize` loop (NFKD + 7 regex replacements + lower
     over every row) blocks the main thread for hundreds of ms on DE and
     seconds on US. On constrained devices the tab crashes outright.
   - JS heap balloons by tens of MB per country just to hold the normalized
     prefix cache.

   Commit history: we shipped this in a prior revision and had to revert,
   see the revert commit linked in #4/#5/#6. The playground is back on the
   SQL path and is therefore still accent-blind.

The right fix is to produce the normalized form once, in the pipeline,
and ship it to consumers.

## Proposal

Add a pre-computed `street_norm` column to `street_index/country=XX/data_0.parquet`.
`street_norm` is `street_lower` with Unicode NFKD decomposition, combining marks
stripped, and ligatures mapped the same way `normalizeForSearch` does it today
(`ß→ss, ø→o, æ→ae, œ→oe, đ→d, ł→l`). See
`packages/core/src/search.ts` `normalizeForSearch()` for the exact transform.

Schema after change:

```
street_index/country=XX/data_0.parquet
  street_lower     VARCHAR   -- display form, already present
  street_norm      VARCHAR   -- NEW: accent-stripped lowercase form
  tiles            VARCHAR[]
  addr_count       INTEGER
  primary_city     VARCHAR
  centroid_lon_e6  INTEGER
  centroid_lat_e6  INTEGER
```

### DuckDB feasibility

DuckDB 1.5 has `strip_accents()` which covers combining-mark accents and is
enough for #5 in most cases. Ligatures (`ß`, `ø`, `æ`, `œ`, `đ`, `ł`) need
explicit string replacement. Sketch:

```sql
-- Inside sql/addresses.sql, where street_index is built
SELECT
  street_lower,
  lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                strip_accents(street_lower),
                'ß', 'ss', 'g'),
              'ø', 'o', 'g'),
            'æ', 'ae', 'g'),
          'œ', 'oe', 'g'),
        'đ', 'd', 'g'),
      'ł', 'l', 'g')
  ) AS street_norm,
  ...
```

Worth validating the DuckDB 1.5 `strip_accents` behaviour on:
- DE umlauts (`ä ö ü`), expect `a o u`
- PL acutes + ogonek (`ą ę ć ń ś ź ż`)
- Slavic hacek (`č š ž`)
- Romance tilde + acute (`á é í ó ú ñ ã õ`)

### Playground side once column exists

`buildStreetSQL` (in `packages/core/src/autocomplete.ts`) can switch from
`WHERE street_lower LIKE ?` to `WHERE street_norm LIKE ?`, feeding it the
query run through the same normalizer. Row-group min/max stats + bloom
filters on `street_norm` keep the query fast (we already pay ~150 KB per
street query on `number_index` thanks to the bloom filter).

No JS-side loading needed. No browser memory pressure. Issues #4/#5/#6
close by swapping one column name.

## Alternatives considered

- **DuckDB-WASM `strip_accents` shim.** Register a JS UDF that implements
  NFKD + ligature map. DuckDB-WASM does not yet support JS scalar UDFs in a
  usable form (issue #6 explores this, no solution). Even if available,
  calling into JS from SQL row-by-row is slow.

- **Keep `street_lower` and generate `street_norm` on the fly in SQL.**
  `WHERE strip_accents(street_lower) LIKE ?` would work but defeats
  row-group skipping, bloom filters, and min/max stats. Full-file scans
  per keystroke.

- **Bloom filter on a virtual column.** Not supported in Parquet.

Materializing the column once, at pipeline time, is cheapest for every
consumer.

## Scope of change

- `sql/addresses.sql`: one SELECT expression and COPY/CREATE TABLE schema
  update in the `street_index` block.
- `main.py`: Parquet writer options (bloom filter on `street_norm` if we
  decide to mirror the `number_index` pattern).
- Backfill: next full pipeline run regenerates all 39 countries.
- Playground: change `buildStreetSQL` to use `street_norm`, run query
  through `normalizeForSearch` first. Close #4/#5/#6.
