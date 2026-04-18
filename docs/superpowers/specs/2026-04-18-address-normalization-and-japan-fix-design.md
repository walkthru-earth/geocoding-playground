# Address Normalization and Japan Parser Fix

Date: 2026-04-18
Related: geocoding-playground#11
Live data reference: `release=2026-04-15.0`

## Problem

Two bugs, same root cause: the playground assumes input and stored data agree on spelling.

1. Issue #11: typing `195 clearview avenue` in Ottawa returns 0 matches because the stored value is `clearview ave`. Measured on live S3 data, CA alone has 2.25M ave-suffixed and 2.86M st-suffixed addresses that 0-match when the user types the full word. US, AU, DE, FR show the same pattern with different suffixes.
2. Japan hunch: raw Overture JP data is shaped correctly and the pipeline's banchi-zone strip is sound, but the playground parser requires whitespace tokens that native Japanese input doesn't have. Typing `土浦市本郷1208` produces `street="土浦市本郷1208"`, `number=undefined`. Tests in `parser-matrix.test.ts` only cover space-separated kanji input, so the failure is silent.

## Goals

- Accept both full and abbreviated street type and directional forms across all 39 supported countries.
- Accept Japanese address input without whitespace, handle kanji vs Arabic chome, strip kanji parcel prefixes.
- Keep all SQL safety rules from `CLAUDE.md` intact: `esc()`, `validateCC`, hot-path allocation discipline, async generation counters.
- Do not require a pipeline rebuild to fix issue #11.

## Non-goals

- Romaji-to-kanji transliteration for Japan. Out of scope.
- Full libpostal parser port. We only port the dictionaries.
- Fixing upstream `addresses.sql` issues in this PR. Those get separate issues against `walkthru-overture-index`.

## Architecture

```
packages/core/src/
  dictionaries/                    # generated, committed
    <lang>/street_types.json
    <lang>/directionals.json
    <lang>/unit_types.json
    <lang>/ambiguous.json
    countries.ts                   # cc -> language[]
    index.ts                       # expandStreetVariants(cc, token), etc.
  parsers/
    ja.ts                          # renamed from jp.ts, rewritten
    ca.ts, us.ts, de.ts, ...       # unchanged, consume expansion via buildDefaultWhere
  address-parser.ts                # buildDefaultWhere OR-expands variants
  search.ts                        # searchStreets expands before prefix match
scripts/
  fetch-libpostal-dicts.ts         # one-shot fetch + codegen, committed output
```

## Component A, libpostal dictionary pipeline

### A1. Fetch script

- File: `scripts/fetch-libpostal-dicts.ts`
- Pinned libpostal commit SHA stored at top of the file, bumped by hand when refreshed.
- For each of the 12 target languages, fetch 4 files: `street_types.txt`, `directionals.txt`, `unit_types_standalone.txt`, `ambiguous_expansions.txt`.
- Skip any file that returns 404, record in the generated output which languages have which files.
- Transform each line `canonical|var1|var2|...` into `{ canonical, variants: [var1, var2, ...] }`. All entries lowercased and NFKD-normalized on write so they match `normalizeForSearch` at query time.
- Write to `packages/core/src/dictionaries/<lang>/<kind>.json`, generate header comment with upstream SHA and MIT license attribution.
- Invocation: `pnpm dict:fetch`.

### A2. Countries map

- File: `packages/core/src/dictionaries/countries.ts`
- `export const COUNTRY_LANGUAGES: Record<string, readonly string[]>` covering all 39 CCs from the manifest.
- Multi-language countries: CA `["en","fr"]`, CH `["de","fr","it"]`, BE `["nl","fr"]`, LU `["fr","de"]`. Singapore + HK `["en"]`.

### A3. Runtime index

- File: `packages/core/src/dictionaries/index.ts`
- Loads all JSON at module init into two `Map<string, string[]>` per language: one `canonical -> variants`, one `variant -> canonical`.
- Exports:
  - `expandStreetVariants(cc: string, token: string): string[]` returns `[input, ...all known variants]` de-duplicated. Guarded by `ambiguous.json`: if the input is in the ambiguous set, returns `[input]` only.
  - `expandDirectional(cc: string, token: string): string[]` same shape, for directionals.
  - `getCountryLanguages(cc: string): readonly string[]`.
- No dynamic regex construction from user input. No `Function()`. Lookups are pure `Map.get`.

### A4. Safety

- `validateCC(cc)` at every entry point.
- Input token lowercased and `normalizeForSearch`-normalized before lookup.
- Output of `expandStreetVariants` is always lowercase ASCII where possible, still requires `esc()` at the SQL boundary (callers' responsibility, documented in JSDoc).

## Component B, query expansion

### B1. `buildDefaultWhere` in `packages/core/src/address-parser.ts`

- Detect when the last token of `parsed.street` is a known street type or directional.
- When detected, build `(street_lower LIKE 'prefix_v1%' OR street_lower LIKE 'prefix_v2%' ...)`.
- Prefix is `head + ' ' + variant` where `head` is the street minus the detected type/directional.
- Also handle leading directional for NUMBER_FIRST countries (`N Main St`, `S Clearview Ave`).
- Every variant individually escaped with `esc()`. No `JOIN` on array, explicit loop.
- If ambiguous, emit the single untransformed prefix, same as today.

### B2. `searchStreets` in `packages/core/src/search.ts`

- Before the existing prefix loop, expand the user query into a small variant set via `expandStreetVariants`.
- Do the `startsWith` scan for each variant, union results, dedupe by `street_lower`.
- Keep the existing `rankBySimilarity` tail so ordering is stable.
- `preNormed` input unchanged. Variants are compared against already-normalized strings, so no extra NFKD work per record.

### B3. Tests

- `packages/core/src/__tests__/dictionaries/expansion.test.ts`: one case per language, asserts both directions round-trip.
- `packages/core/src/__tests__/address-parser.test.ts`: add CA case `195 clearview avenue` produces WHERE containing both `clearview ave%` and `clearview avenue%`. Add DE case for `strasse`. Add US directional case.
- `packages/core/src/__tests__/autocomplete/sql-builders.test.ts`: confirm `esc()` is still applied to every variant.

## Component C, Japan parser rewrite

### C1. File rename

- `packages/core/src/parsers/jp.ts` stays named by its ISO 3166 country code, matching the rest of the parser folder (`us.ts`, `ca.ts`, `it.ts`, etc.). Overture's partition key is also `JP`.
- The libpostal dictionary lives at `packages/core/src/dictionaries/ja/` (ISO 639 language code). Country-to-language resolution is done through `COUNTRY_LANGUAGES` (`JP → ja`), never by filename coincidence.

### C2. Tokenization

- Parse via one pre-compiled regex hoisted at module scope: `/[一-龯ぁ-んァ-ヶー々]+|[0-9０-９]+(?:[-−‐]?[0-9０-９]+)*/g`.
- Emit a token list of `{text, kind}` where kind is `kanji` or `digits`.
- Full-width digits already normalized by `normalizeForSearch` at the caller, but the parser also handles them defensively.

### C3. Segmentation

Greedy longest-prefix match using the hoisted suffix sets.

- Strip prefecture prefix: first kanji token ending in `都|道|府|県` drops from remaining.
- Strip city prefix: next kanji token ending in `市|区|町|村` drops.
- Number is the last `digits` token, if present.
- Remaining joined kanji tokens become the street.
- If no prefecture or city detected, fall back to the whole kanji span as street.

### C4. Chome handling

- Pre-built map `KANJI_TO_ARABIC: Record<string, string>` covering 一..二十 (1..20).
- Pre-built map `ARABIC_TO_KANJI` built by inversion.
- `canonicalizeChome(street: string): string[]` returns the set of spellings: kanji-chome, arabic-chome, and bare-number forms. Example: `並木一丁目` → `["並木一丁目", "並木1丁目"]`. Example: `並木 1` → `["並木一丁目", "並木1丁目", "並木1", "並木一"]`.
- Used by `buildWhereClause` to OR the variants.

### C5. Banchi parcel prefix

- Pre-built regex for leading kanji parcel labels: `/^[甲乙丙丁](\d+)$/`.
- If the parsed number matches, emit two SQL variants: with and without the kanji prefix. Stored data has the kanji prefix, user often types just digits.

### C6. Placeholder suppression

- `searchStreets` (component B) drops entries whose `street_lower` equals `（大字なし）` from autocomplete results unless the user explicitly types that string.

### C7. Tests

New cases in `packages/core/src/__tests__/parsers/parser-matrix.test.ts`:

| Input | Expected street | Expected number |
|---|---|---|
| `本郷 1208` | `本郷` | `1208` |
| `土浦市本郷1208` | `本郷` | `1208` |
| `茨城県土浦市本郷1208` | `本郷` | `1208` |
| `並木一丁目 4233` | `並木一丁目` (variant-aware) | `4233` |
| `並木1丁目 4233` | `並木一丁目` (variant-aware) | `4233` |
| `乙24` | no street | variants `["24","乙24"]` |

Keep the existing `本郷 1-2-3` and `100-0001` tests.

## Component D, upstream recommendations, filed as issues

Filed as GitHub issues against `walkthru-earth/walkthru-overture-index`, not implemented here.

1. `full_address` for JP should be `region||city||street||number` (no delimiter, no space), not the Western `CONCAT_WS(', ', ...)`. Addresses.sql line 244.
2. Replace `street = '（大字なし）'` with `NULL` (or with `city`) during enrichment. 24,681 rows affected.

## Build order

Implementation can parallelize:

1. Track A (independent): fetch script, generated JSON, runtime index, expansion tests.
2. Track C (independent): JP parser rewrite, parser tests.
3. Track B (depends on A): `buildDefaultWhere` and `searchStreets` wiring, integration tests.

A and C run in parallel first, B runs after A publishes its `expandStreetVariants` signature.

## Verification before merge

- `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm build`, `pnpm test:e2e` all green.
- Manual playground check: query `195 clearview avenue` in CA returns 195 Clearview Ave, Ottawa. Query `土浦市本郷1208` in JP returns the Ibaraki address. Query `並木1丁目 4233` in JP returns 並木一丁目 4233.
- Data-level validation script extended to assert at least one full-word variant matches at least one abbreviated stored street, per country that has the issue.

## Attribution

libpostal by Al Barrentine, MIT License. Dictionaries imported from `openvenues/libpostal` at the pinned commit, with the MIT notice reproduced in each generated JSON header.

## Out of scope

- Romaji to kanji transliteration.
- OSM/Nominatim fallback.
- Cities/postcode expansions (only street types and directionals).
- Pipeline rebuild.
