# Walkthru Earth Geocoding Playground

## Commands
```
pnpm dev              # Start Svelte dev server (playground)
pnpm build            # Build core THEN playground (order matters)
pnpm check            # svelte-check + tsc
pnpm lint             # Biome check
pnpm lint:fix         # Biome check --write
pnpm format           # Biome format --write
pnpm test             # Run core unit tests (Vitest)
pnpm test:coverage    # Unit tests with coverage report
pnpm test:e2e         # Run Playwright e2e tests (builds + serves playground)
```

Core only: `pnpm --filter @walkthru-earth/geocoding-core build`

### Testing

- **Unit tests** (`packages/core/`): Vitest. Run with `pnpm test`. Config at `packages/core/vitest.config.ts`.
- **E2E tests** (`apps/playground/e2e/`): Playwright (Chromium). Run with `pnpm test:e2e`. Config at `apps/playground/playwright.config.ts`. Tests hit live S3 data, so they need network access and can be slow on first run.
- **Data validation** (`pnpm test:validate`): Queries live S3 parquet files via DuckDB CLI to verify parsed addresses exist in the real data. Generates `test-output/validation/parser-validation.md`.
- **Pre-commit hook**: Runs lint-staged + type-check + build. Unit and e2e tests run in CI only.
- **Test output**: All test artifacts go to `test-output/` (gitignored). Unit coverage HTML at `test-output/unit/coverage/`, Playwright report at `test-output/e2e/report/`.

**This project uses pnpm exclusively. Never use npm or npx.** Use `pnpm` and `pnpx` instead. A PreToolUse hook will block npm/npx commands automatically.

## Architecture

pnpm monorepo with two packages:

- `packages/core/` - `@walkthru-earth/geocoding-core`. Framework-agnostic TS library. DuckDB-WASM wrapper, address parsing, autocomplete engine, search/ranking. Built with Vite + vite-plugin-dts.
- `apps/playground/` - Svelte 5 UI. Tailwind 4 + DaisyUI 5 + MapLibre GL. Consumes core as `workspace:*` dependency.

The core package is designed to work with React, Vue, Next.js, or any framework.

## Upstream Pipeline

The data pipeline lives in a separate repo: `walkthru-earth/walkthru-overture-index`.
Key files: `sql/addresses.sql` (DuckDB 1.5 SQL) + `main.py` (orchestration + s5cmd parallel S3 upload).
Pipeline processes 469M Overture Maps addresses into partitioned GeoParquet tiles on S3.

## Data on S3

Base URL: `https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/walkthru-earth/indices/addresses-index/v4/release=2026-03-18.0/`

Key files (all Hive-partitioned by country):
- `manifest.parquet` - 39 countries (3 KB)
- `tile_index.parquet` - 17,499 tiles (561 KB)
- `city_index/country=XX/data_0.parquet` - per-country cities
- `postcode_index/country=XX/data_0.parquet` - per-country postcodes
- `street_index/country=XX/data_0.parquet` - per-country streets
- `number_index/country=XX/data_0.parquet` - per-country house numbers
- `geocoder/country=XX/h3_parent=YYY/data_0.parquet` - address tiles (0.5-48 MB)

## Key Conventions

- **Build order**: Always build core before playground (`pnpm build` handles this)
- **HTTPS, not s3://**: DuckDB-WASM uses plain HTTPS for all data access (s3:// fails with 416 on large files)
- **h3_index as BIGINT**: Not VARCHAR hex. 46% smaller, enables row-group pushdown
- **Per-country index files**: Not global. Avoids 73 MB footer overhead in WASM
- **NUMBER_FIRST countries**: US, CA, AU, NZ, BR, MX, CL, CO, UY, SG, HK, TW, GB, IE (house number before street)
- **Street-first countries**: NL, DE, FR, IT, AT, CH, ES, PT, BE + Nordic + Baltic + Balkans
- **Parquet optimization**: All files use ZSTD compression, Parquet v2 data pages. Geocoder tiles have bloom filters on `street` for row-group skipping. number_index uses ROW_GROUP_SIZE 2000 + bloom filters on `street_lower` for HTTP range-request pushdown (~150 KB per query vs full file)
- **`$state.raw` for query results**: Use `$state.raw` (not `$state`) for arrays of immutable DuckDB results (`results`, `cities`, `suggestions`, `countries`) to avoid Svelte 5 deep-proxy overhead
- **JS array search over DuckDB for cached data**: City search uses `searchCities()` from core (sub-ms JS) instead of DuckDB SQL round-trips. Street/postcode autocomplete queries DuckDB in-memory tables
- **`getAvailableReleases()` not `availableReleases`**: Release list is exposed via a getter function, not an exported mutable variable

## Investigating Data Issues

Use MotherDuck MCP (`mcp__motherduck__execute_query`) or DuckDB CLI to query live S3 parquet files.
Never guess data shapes. Always verify against real data.

Example: check a country's city index:
```sql
SELECT city, region, addr_count, len(tiles) AS tile_count
FROM read_parquet('...BASE_URL.../city_index/country=NL/data_0.parquet')
ORDER BY addr_count DESC LIMIT 10;
```

See `_study/` for detailed architecture docs, data profiles, and issue history.

## Code Safety Rules

### SQL interpolation
- All user-facing string values MUST go through `esc()` before interpolation into SQL
- Country codes MUST be validated with `validateCC(cc)` at every SQL builder entry point. Never interpolate `cc` into table names or URLs without it
- Tile IDs MUST be validated against `/^[0-9a-f]+$/i` before interpolation into parquet URLs
- Array values from query results (like `cityTiles`) MUST be escaped individually: `tiles.map(t => esc(t))`, not joined raw

### HTML in map popups
- All address data inserted into popup HTML MUST use `htmlEsc()`. Address strings from Overture can contain `&`, `<`, `>`, or quotes

### Hot-path allocations
- Never allocate `Set`, `Map`, `RegExp`, or large objects inside `parseAddress()` or `classifyInput()`. These run on every keystroke. Hoist to module scope as constants
- The `PARTIAL_POSTCODE_RE` map in autocomplete.ts is already hoisted for this reason

### Async race conditions
- Any async function triggered by user interaction (search, autocomplete, map click) MUST use a generation counter pattern: `const gen = ++searchGen` at the top, `if (gen !== searchGen) return` after each `await`
- Use separate counters for independent flows (e.g., `searchGen` for search, `autoGen` for autocomplete)
- `cancelPendingQuery()` is called before new searches to cancel in-flight DuckDB queries (stops network + WASM compute, not just result discard)

### Defaults and constants
- When the same default value exists in multiple files (e.g., default page), keep them in sync. Grep for the value after changing it

## Watch Out For

- `_study/` is gitignored. It contains design docs, not code.
- DuckDB-WASM caches HTTP metadata, Parquet footers, and file pages. After S3 file updates, stale cache causes 416 errors. The core handles this with `clearHttpCache()` + retry.
- FR has no region in Overture (depth-1 only). `LEFT(postcode, 3)` grouping separates overseas territories.
- IT, JP, TW, CO have no postcode index (Overture has no postcode data for these).
- JP numbers in Overture are "banchi-coordZone" (e.g., "362-9"). The pipeline strips the zone suffix. The parser uses split_part for matching.
