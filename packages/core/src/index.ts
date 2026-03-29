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
  cancelPendingQuery,
  clearHttpCache,
  dataPath,
  getAvailableReleases,
  getConnection,
  getRegionTable,
  getRelease,
  getTileSource,
  indexPath,
  initDuckDB,
  isRegionCached,
  isTileCached,
  markRegionCached,
  onCacheLog,
  onReleaseChange,
  prefetchRegion,
  query,
  queryObjects,
  queryObjectsWithRetry,
  switchRelease,
  tilePath,
} from './duckdb'
export { stripJPCoordZone } from './parsers/jp'

// ── Search ───────────────────────────────────────────────────
export {
  jaccardSimilarity,
  normalizeForSearch,
  preNormalize,
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
  RegionRow,
  StepEntry,
  StreetRecord,
  SuggestRow,
  TileBucket,
  TileStatsRow,
} from './types'
// ── Utilities ────────────────────────────────────────────────
export {
  addStep,
  esc,
  fmt,
  fmtFull,
  formatSize,
  htmlEsc,
  ms,
  toArr,
  updateLastStep,
  validateCC,
  validateRegion,
} from './utils'
