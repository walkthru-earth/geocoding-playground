# Geocoding Playground

A browser-based geocoder powered by [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) and [Overture Maps](https://overturemaps.org/) address data. No backend required — all 469M+ addresses are queried directly from Parquet files via HTTP range requests.

## Features

- **Forward Geocoding** — search by street, postcode, or address across 39 countries
- **Reverse Geocoding** — find nearest addresses by clicking the map or entering coordinates
- **Country-aware parsing** — dedicated address parsers for NL, US, DE, FR, IT, ES, BR, AU, CA, JP with format-specific logic
- **Three-tier caching** — WASM init → country prefetch → tile LRU for sub-second queries
- **Overture release selector** — switch between available Overture Maps releases from the navbar
- **Interactive map** — MapLibre GL with H3 tile overlays and result markers

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Svelte 5 + TypeScript |
| Build | Vite |
| Database | DuckDB-WASM (in-browser) |
| Styling | Tailwind CSS + DaisyUI |
| Map | MapLibre GL |
| Geo indexing | H3 (Uber) |
| Data | Overture Maps addresses (Parquet on S3) |

## Getting Started

```bash
pnpm install
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173).

## How It Works

1. **WASM Init** (~2-4s) — loads DuckDB + extensions (httpfs, spatial, h3), caches global tile index and manifest
2. **Country Prefetch** (~3-8s) — when a country is selected, loads city/postcode/street indexes into in-memory tables
3. **Query** — parses input using country-specific parser, narrows to relevant H3 tiles, queries Parquet files with filter pushdown
4. **Tile Cache** — fetched tiles are kept in-memory (LRU, 4M address budget) for instant repeat queries

## Data Source

Address data is sourced from [Overture Maps](https://overturemaps.org/) and served as optimized Parquet files via [Source Cooperative](https://source.coop/). The release version is selectable from the navbar.

## License

This project is licensed under [CC-BY 4.0](./LICENSE) — Walkthru.Earth.

Overture Maps address data is available under [CDLA-Permissive 2.0](https://cdla.dev/permissive-2-0/) or [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) where derived from OpenStreetMap. See [Overture Maps Attribution](https://docs.overturemaps.org/attribution/) for country-specific requirements.
