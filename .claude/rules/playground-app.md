---
paths:
  - "apps/playground/**/*.svelte"
  - "apps/playground/**/*.ts"
---
# Playground App Rules

Svelte 5 app with reactive variables ($state, $derived, $effect). Uses Tailwind 4 + DaisyUI 5 + MapLibre GL.

## Pages
- `GeocodePage.svelte` - Forward geocoding (country -> city -> address search with autocomplete)
- `ReversePage.svelte` - Reverse geocoding (click map -> nearest addresses via H3 grid)
- `StatusPage.svelte` - Data coverage overview, cache info, release switcher
- `BenchmarkPage.svelte` - Performance testing

## Components
- `MapView.svelte` - MapLibre GL wrapper, light/dark basemaps (CartoDB), auto-resize
- `ResultsTable.svelte` - Tabular result display
- `SplitPane.svelte` - Draggable split pane
- `StepLog.svelte` - Execution step log for transparency

## Conventions
- All geocoding logic lives in core, not in Svelte components
- The app injects query functions into the autocomplete engine via `AutocompleteQueryFns`
- Debounced autocomplete (150ms)
- Async search flows use generation counters (`searchGen`, `autoGen`) + `cancelPendingQuery()` to cancel in-flight DuckDB queries before new searches
- City search uses sub-ms JS `searchCities()` from core (not DuckDB SQL). City records loaded into `allCityRecords` array after prefetch
- Use `$state.raw` (not `$state`) for immutable DuckDB result arrays: `results`, `cities`, `suggestions`, `countries`. These are never mutated in place, so deep reactivity proxy is wasted overhead
- Map popup HTML uses `htmlEsc()` from core for all user-facing data
- Theme switching persists to localStorage
- PostHog analytics is optional, gated by env vars
- Release list accessed via `getAvailableReleases()` getter (not the old `availableReleases` export)

## Analytics (PostHog)
- Config: `src/lib/analytics.ts`. Gated by `VITE_POSTHOG_KEY` env var. EU instance (`eu.i.posthog.com`), project ID `103270`.
- Privacy-first: cookieless (memory persistence), no autocapture, manual pageview on hash change.
- Use `track(event, props)` for all custom events. It no-ops when PostHog is not initialized.
- Event naming: `snake_case`. Always include `country` on geocode events, `duration_ms` + `result_count` on search completions.
- Tracked events: `country_selected`, `city_selected`, `suggestion_selected`, `preset_clicked`, `forward_geocode_search`, `forward_geocode_error`, `autocomplete_error`, `map_clicked`, `reverse_geocode_search`, `reverse_geocode_error`.
- Do not track PII, full search queries, or raw high-precision coordinates. Lat/lon are rounded to 4 decimal places (~11m).
- Querying PostHog: `POST https://eu.posthog.com/api/projects/103270/query/` with HogQL. The legacy `/insights/trend/` endpoint is blocked for the current API key.

## Build
- Must build core first: `pnpm --filter @walkthru-earth/geocoding-core build`
- svelte-check depends on core's dist/index.d.ts existing
