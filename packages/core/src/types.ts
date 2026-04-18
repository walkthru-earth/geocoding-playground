// ── Step log ────────────────────────────────────────────────

export interface StepEntry {
  text: string
  status?: 'done' | 'loading' | 'error'
}

// ── Geocoding results ───────────────────────────────────────

export interface AddressRow {
  full_address: string
  street: string
  number: string
  /**
   * Apartment/suite/unit, when the address sits inside a multi-unit building.
   * Overture provides this per-unit (e.g. 328 distinct units at 195 Clearview
   * AVE, Ottawa), but the pipeline's `full_address` does not embed it, so the
   * playground renders it alongside the address.
   */
  unit?: string | null
  city: string
  region: string | null
  postcode: string
  country?: string
  lat: number
  lon: number
  h3_index: string
  distance_m?: number
}

export interface CityRow {
  region: string | null
  city: string
  tiles: string[]
  addr_count: number
  bbox_min_lon_e6?: number
  bbox_max_lon_e6?: number
  bbox_min_lat_e6?: number
  bbox_max_lat_e6?: number
}

export interface SuggestRow {
  type: 'postcode' | 'street' | 'address'
  label: string
  tiles: string[]
  addr_count: number
  primary_city?: string | null
}

// ── Status / manifest ───────────────────────────────────────

export interface ManifestRow {
  country: string
  address_count: number
  tile_count: number
  bucket_count: number
  h3_res4_count: number
  bbox_min_lon: number
  bbox_max_lon: number
  bbox_min_lat: number
  bbox_max_lat: number
  overture_release: string
}

export interface RegionRow {
  country: string
  region: string
  tiles: string[]
  addr_count: number
  bbox_min_lon: number
  bbox_max_lon: number
  bbox_min_lat: number
  bbox_max_lat: number
}

export interface TileStatsRow {
  country: string
  tiles: number
  total_addr: number
  avg_addr: number
  median_addr: number
  max_addr: number
  min_addr: number
  total_postcodes: number
  total_cities: number
  regions: number
}

export interface TileBucket {
  bucket: string
  tiles: number
  total_addr: number
  sort_key: number
}

export interface IndexAvailRow {
  country: string
  has_postcode: boolean
  has_street: boolean
  has_city: boolean
  postcode_count: number
  street_count: number
  city_count: number
}

// ── Search index records (used by search.ts) ────────────────

export interface CityRecord {
  city: string
  region?: string
  tiles: string[]
  addr_count: number
}

export interface PostcodeRecord {
  postcode: string
  tiles: string[]
  addr_count: number
}

export interface StreetRecord {
  street_lower: string
  tiles: string[]
  addr_count: number
  primary_city?: string
}
