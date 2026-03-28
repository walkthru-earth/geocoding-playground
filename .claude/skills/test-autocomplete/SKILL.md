---
name: test-autocomplete
description: >
  Tests the smart autocomplete engine against known test scenarios from the study docs.
  Use this skill when the user asks to 'test autocomplete', 'verify search works',
  'check the parser', 'test address parsing', 'run autocomplete tests', or wants to
  validate that a specific country's input classification and ranking works correctly.
  Also use after making changes to autocomplete.ts, address-parser.ts, or search.ts.
  Do NOT use for data investigation (use investigate-data instead) or UI testing.
allowed-tools: Read, Grep, Glob
---

# Autocomplete Testing Skill

Validate the smart autocomplete engine against documented test scenarios.

## Workflow

1. **Read the test scenarios** from `_study/AUTOCOMPLETE.md` (Test Scenarios section).

2. **Read the relevant source files**:
   - `packages/core/src/autocomplete.ts` - classifyInput(), suggest(), rankSuggestions()
   - `packages/core/src/address-parser.ts` - getParser(), POSTCODE_RE, NUMBER_FIRST
   - `packages/core/src/search.ts` - suggestionScore(), SearchCache

3. **Trace the flow** for the user's test case:
   - What does `classifyInput(input, cc)` return? (street/postcode/mixed/ready)
   - What parser does `getParser(cc)` return?
   - What does `parseAddress(input)` extract? (street, number, postcode, unit)
   - What SQL would `buildStreetSQL()` or `buildPostcodeSQL()` generate?
   - How would `rankSuggestions()` order the results with the given city?

4. **Check for regressions** against the 3 known issues:
   - Issue 1: Duplicate cities (GROUP BY region, city dedup)
   - Issue 2: City boost in ORDER BY (list_has_any tile overlap)
   - Issue 3: Word match > prefix match (suggestionScore tiers)

5. **Report** whether the code correctly handles the test case, with the exact
   classification, SQL, and ranking that would be produced.

## Key Constants to Check
- `NUMBER_FIRST` set in address-parser.ts must match pipeline SQL (addresses.sql line 143)
- `POSTCODE_RE` patterns per country
- `suggestionScore` tiers: 100=exact, 80=word, 60=prefix, 40=substring, 0-30=Jaccard
