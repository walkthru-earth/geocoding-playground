/**
 * Country code -> language list.
 *
 * Covers every CC in the live manifest (39 countries as of the 2026-04-15
 * release) plus a handful of likely-soon additions (GB, IE). Multi-language
 * countries list all primary languages, in priority order, so dictionary
 * expansion hits the most common form first.
 *
 * Default when a CC isn't in the map: ["en"]. Never throw, callers already
 * validate CC with `validateCC` at the SQL layer.
 */
export const COUNTRY_LANGUAGES: Record<string, readonly string[]> = {
  // Single-language, English-speaking
  US: ['en'],
  GB: ['en'],
  AU: ['en'],
  NZ: ['en'],
  IE: ['en'],
  SG: ['en'],
  HK: ['en'],
  // Taiwan, Overture ja/zh street_types are sparse, default to en until
  // we port Chinese dictionaries.
  TW: ['en'],

  // Multi-language
  CA: ['en', 'fr'],
  CH: ['de', 'fr', 'it'],
  BE: ['nl', 'fr'],
  LU: ['fr', 'de'],
  FI: ['fi', 'sv'],

  // Iceland, Greenland, Faroe Islands use Icelandic / Danish respectively
  IS: ['is'],
  GL: ['da'],
  FO: ['da'],

  // European Romance
  FR: ['fr'],
  IT: ['it'],
  ES: ['es'],
  PT: ['pt'],
  RO: ['ro'],

  // European Germanic
  DE: ['de'],
  AT: ['de'],
  LI: ['de'],
  NL: ['nl'],

  // Nordic
  DK: ['da'],
  NO: ['nb'],
  SE: ['sv'],

  // Baltic
  EE: ['et'],
  LT: ['lt'],
  LV: ['lv'],

  // Balkan
  HR: ['hr'],
  SI: ['sl'],
  RS: ['sr'],

  // Central Europe
  PL: ['pl'],
  CZ: ['cs'],
  SK: ['sk'],
  HU: ['hu'],

  // Latin America
  BR: ['pt'],
  MX: ['es'],
  CL: ['es'],
  CO: ['es'],
  UY: ['es'],

  // Japan
  JP: ['ja'],
}

/**
 * Look up the language list for a CC. Returns `['en']` as a safe default
 * for any CC not in the map. Callers should `validateCC` before calling.
 */
export function languagesForCC(cc: string): readonly string[] {
  return COUNTRY_LANGUAGES[cc] ?? ['en']
}
