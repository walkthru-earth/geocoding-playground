---
paths:
  - "packages/core/**/*.ts"
---
# Core Library Rules

This is `@walkthru-earth/geocoding-core`, a framework-agnostic library. Zero UI dependencies allowed.

## Module responsibilities
- `duckdb.ts` - DB init, tile cache (LRU ~4M addr budget), HTTP cache busting, prefetch, cancelPendingQuery(), getAvailableReleases()
- `autocomplete.ts` - classifyInput() -> suggest() -> rankSuggestions(), SQL builders. `buildStreetNarrowSQL` also routes through `buildStreetPrefixClause` so libpostal expansion fires on the narrow step too
- `search.ts` - SearchCache<T> (LRU+TTL), jaccardSimilarity(), preNormalize(), array search (sub-ms with optional pre-normalization)
- `address-parser.ts` - parser factory + `buildDefaultWhere` + `buildStreetPrefixClause`. Country parsers live in `parsers/<cc>.ts` (US, CA, NL, DE, FR, IT, ES, BR, AU, JP) and share `GenericParser` as a fallback
- `parsers/jp.ts` - Japanese native-input parser. Tokenizes no-space Japanese (`茨城県土浦市本郷1208`), strips prefecture/city/parcel prefixes, canonicalizes chome (`一丁目 ↔ 1-`). Exports `canonicalizeChome` + `stripJPCoordZone`
- `dictionaries/` - libpostal-derived synonym tables, 27 languages. `index.ts` exposes `expandStreetVariants`, `expandDirectional`, `getCountryLanguages`; `countries.ts` maps ISO country → ISO 639 languages. Regenerate via `pnpm tsx scripts/fetch-libpostal-dicts.ts`
- `types.ts` - AddressRow (includes `unit?: string | null`), CityRow, SuggestRow, ManifestRow, index types
- `utils.ts` - fmt(), esc(), htmlEsc(), validateCC(), validateH3(), validateBucket(), validateFiniteNumber(), validateSourceExpr(), toArr(), step logging
- `forward-geocode.ts` - resolveTileSource(), batchTilesSourceExpr(), buildForwardTileQuerySQL(). Keeps all tile source string building + the per-tile SELECT out of the Svelte app. SELECT now pulls `unit`
- `reverse-geocode.ts` - buildReverseQuerySQL(), buildTileLookupSQL(), radiusToBbox(), gridKForRadius(). All builders validate inputs at entry. SELECT now pulls `unit`

## Key patterns
- All SQL uses HTTPS URLs, never s3://
- SQL strings use `esc()` for single-quote escaping (prevent injection)
- `validateCC(cc)` asserts `/^[A-Z]{2}$/` at every SQL builder entry point (prevents table name injection)
- `validateH3(h)` asserts `H3_RE = /^[0-9a-f]+$/i` before tile ids are interpolated into URLs or SQL
- `validateBucket(b)` asserts `/^[0-9a-z_]+$/i` before bucket ids are interpolated into URLs, SQL, or cached table names
- `validateFiniteNumber(n, label)` guards all numeric SQL parameters (lat, lon, bbox, limit, gridK). Integer-only params also use `Number.isInteger()` with explicit bounds
- `validateSourceExpr(src)` whitelists the `FROM` position: only cached tile identifiers (`"_tile_XX_..."`) or `read_parquet('https://...parquet')` / `read_parquet([...])` expressions are accepted. Build src strings via `resolveTileSource` / `batchTilesSourceExpr` / `tileSourceExpr`, never concatenate them in app code
- `htmlEsc()` used in all map popup HTML templates (prevents XSS from address data)
- Autocomplete never fetches remote data. Only queries what is already cached in WASM memory
- Country prefetch is progressive: cities first (Phase 1, unlocks UI), then postcodes, then streets. City records also loaded into a JS array for sub-ms search
- Tile cache uses LRU eviction at ~4M address budget
- `queryRemoteWithRetry()` wraps all remote reads with cache-bust retry on failure
- `cancelPendingQuery()` cancels in-flight DuckDB queries before starting new searches
- `getAvailableReleases()` returns `readonly string[]` (getter, not exported mutable variable)
- `preNormalize()` pre-computes NFKD-normalized names at prefetch time for sub-ms search on large indexes (avoids per-keystroke normalization of 200K-400K records)

## Parser system
- `getParser(cc)` returns country-specific parser or GenericParser
- NUMBER_FIRST set must match exactly between parser and pipeline SQL (addresses.sql line 143)
- Each parser implements: parseAddress(input), extractPostcode(input), buildWhereClause(parsed)
- `ParsedAddress.cc` carries the country code through to `buildStreetPrefixClause` so libpostal expansion fires. Every parser's `buildWhereClause` must set `cc` on the parsed object (e.g. `{...parsed, cc: parsed.cc ?? this.cc}`), otherwise `buildDefaultWhere` short-circuits to the single-prefix branch
- buildDefaultWhere() generates structured SQL: street LIKE 'prefix%' AND number = 'exact'. When `cc` is set, the street condition expands to an OR of libpostal variants (`'clearview ave%' OR 'clearview avenue%' ...`)
- Fallback: ILIKE on full_address for each token

## Parser tests
- E2E tests MUST exercise `getParser(cc).buildWhereClause(parser.parseAddress(input))`, not `buildDefaultWhere({...raw, cc})` directly. Hard-coding `cc` in the raw parsed object hides cases where `parseAddress` forgets to propagate it. See `__tests__/address-parser.test.ts` for the CA "195 clearview avenue" and IT "via roma 12" E2E cases

## Ranking
- suggestionScore(): 100=exact, 80=word boundary, 60=prefix, 40=substring, 0-30=Jaccard
- rankSuggestions(): partition city-local vs non-local first, then score within each group
