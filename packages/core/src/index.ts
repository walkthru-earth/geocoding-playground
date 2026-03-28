// ── Types ────────────────────────────────────────────────────

export type { CountryParser, ParsedAddress } from './address-parser'
// ── Address parser ───────────────────────────────────────────
export { buildDefaultWhere, getParser, NUMBER_FIRST, POSTCODE_RE } from './address-parser'
// ── Autocomplete ────────────────────────────────────────────
export type { AutocompleteQueryFns, InputClassification, TileResolutionResult } from './autocomplete'
export {
  buildAddressSQL,
  buildNumberIndexSQL,
  buildPostcodeNarrowSQL,
  buildPostcodeSQL,
  buildStreetNarrowSQL,
  buildStreetSQL,
  classifyInput,
  extractStreetQuery,
  rankSuggestions,
  resolveTiles,
  suggest,
  suggestionScore,
} from './autocomplete'
export type { PrefetchOptions, QueryResult } from './duckdb'
// ── DuckDB ───────────────────────────────────────────────────
export {
  availableReleases,
  clearHttpCache,
  dataPath,
  getConnection,
  getRelease,
  getTileSource,
  initDuckDB,
  isCountryCached,
  isTileCached,
  markCountryCached,
  onCacheLog,
  onReleaseChange,
  prefetchCountry,
  query,
  queryObjects,
  queryObjectsWithRetry,
  switchRelease,
  tilePath,
} from './duckdb'

// ── Search ───────────────────────────────────────────────────
export {
  jaccardSimilarity,
  rankBySimilarity,
  SearchCache,
  searchCities,
  searchPostcodes,
  searchStreets,
} from './search'
export type {
  AddressRow,
  CityRecord,
  CityRow,
  IndexAvailRow,
  ManifestRow,
  PostcodeRecord,
  StepEntry,
  StreetRecord,
  SuggestRow,
  TileBucket,
  TileStatsRow,
} from './types'
// ── Utilities ────────────────────────────────────────────────
export { addStep, esc, fmt, fmtFull, formatSize, ms, toArr, updateLastStep } from './utils'
