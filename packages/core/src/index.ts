// ── Types ────────────────────────────────────────────────────
export type {
  StepEntry,
  AddressRow,
  CityRow,
  SuggestRow,
  ManifestRow,
  TileStatsRow,
  TileBucket,
  IndexAvailRow,
  CityRecord,
  PostcodeRecord,
  StreetRecord,
} from './types'

// ── Utilities ────────────────────────────────────────────────
export { fmt, fmtFull, formatSize, ms, esc, toArr, addStep, updateLastStep } from './utils'

// ── DuckDB ───────────────────────────────────────────────────
export {
  initDuckDB,
  getConnection,
  getRelease,
  availableReleases,
  switchRelease,
  onReleaseChange,
  dataPath,
  tilePath,
  query,
  queryObjects,
  queryObjectsWithRetry,
  getTileSource,
  isTileCached,
  prefetchCountry,
  isCountryCached,
  markCountryCached,
  onCacheLog,
  clearHttpCache,
} from './duckdb'
export type { QueryResult, PrefetchOptions } from './duckdb'

// ── Search ───────────────────────────────────────────────────
export { SearchCache, jaccardSimilarity, rankBySimilarity, searchStreets, searchPostcodes, searchCities } from './search'

// ── Address parser ───────────────────────────────────────────
export { getParser, buildDefaultWhere, POSTCODE_RE, NUMBER_FIRST } from './address-parser'
export type { ParsedAddress, CountryParser } from './address-parser'
