---
paths:
  - "packages/core/**/*.ts"
---
# Core Library Rules

This is `@walkthru-earth/geocoding-core`, a framework-agnostic library. Zero UI dependencies allowed.

## Module responsibilities
- `duckdb.ts` - DB init, tile cache (LRU ~4M addr budget), HTTP cache busting, prefetch
- `autocomplete.ts` - classifyInput() -> suggest() -> rankSuggestions(), SQL builders
- `search.ts` - SearchCache<T> (LRU+TTL), jaccardSimilarity(), array search (sub-ms)
- `address-parser.ts` - 10 country parsers + GenericParser, POSTCODE_RE, NUMBER_FIRST
- `types.ts` - AddressRow, CityRow, SuggestRow, ManifestRow, index types
- `utils.ts` - fmt(), esc(), htmlEsc(), validateCC(), toArr(), step logging

## Key patterns
- All SQL uses HTTPS URLs, never s3://
- SQL strings use `esc()` for single-quote escaping (prevent injection)
- `validateCC(cc)` asserts `/^[A-Z]{2}$/` at every SQL builder entry point (prevents table name injection)
- Tile IDs validated against `/^[0-9a-f]+$/i` before interpolation into URLs
- `htmlEsc()` used in all map popup HTML templates (prevents XSS from address data)
- Autocomplete never fetches remote data. Only queries what is already cached in WASM memory
- Country prefetch is progressive: cities first (Phase 1, unlocks UI), then postcodes, then streets
- Tile cache uses LRU eviction at ~4M address budget
- `queryRemoteWithRetry()` wraps all remote reads with cache-bust retry on failure

## Parser system
- `getParser(cc)` returns country-specific parser or GenericParser
- NUMBER_FIRST set must match exactly between parser and pipeline SQL (addresses.sql line 143)
- Each parser implements: parseAddress(input), extractPostcode(input), buildWhereClause(parsed)
- buildDefaultWhere() generates structured SQL: street LIKE 'prefix%' AND number = 'exact'
- Fallback: ILIKE on full_address for each token

## Ranking
- suggestionScore(): 100=exact, 80=word boundary, 60=prefix, 40=substring, 0-30=Jaccard
- rankSuggestions(): partition city-local vs non-local first, then score within each group
