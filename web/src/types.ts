// The shapes of the published assets. These mirror the pipeline's output contracts;
// a temperature is `number | null`, and a null is never filled in downstream.

export interface Manifest {
  schema_version: number;
  build_id: string;
  generated_at: string;
  retrieved_at: string;
  provider: string;
  geography_version: string;
  grid_fingerprint: string;
  timezone: string;
  temperature_unit: string;
  band_breaks_f: number[];
  forecast_reference_times: string[];
  forecast_times: string[];
  complete_24h: boolean;
  coverage_note: string;
  display: {
    bands: BandClass[];
    no_data_color: string;
    label_places: string[];
  };
  assets: Record<string, string>;
  frames: FrameEntry[];
}

export interface BandClass {
  band_id: number;
  lower_f: number | null;
  upper_f: number | null;
  color: string;
  label: string;
}

export interface FrameEntry {
  valid_time: string;
  local_label: string;
  path: string;
  bytes: number;
  band_ids: number[];
  feature_count: number;
}

export interface Place {
  slug: string;
  name: string;
  region: string;
  source_type: string;
  city: string | null;
  area_sqmi: number;
  reference_point: {
    longitude: number;
    latitude: number;
    method: string;
    reviewed: boolean;
    review_note: string | null;
  };
  aliases: string[];
}

export interface PlaceIndex {
  geography_version: string;
  place_count: number;
  places: Place[];
}

export interface PlaceCellEntry {
  reference_point: [number, number];
  reference_method: string;
  reviewed: boolean;
  cell_id: string | null;
  unsupported_reason?: string;
}

export interface PlaceCells {
  grid_fingerprint: string;
  geography_version: string;
  mapping_version: string;
  places: Record<string, PlaceCellEntry>;
}

export interface CellForecast {
  cell_id: string;
  longitude: number;
  latitude: number;
  temperature_f: (number | null)[];
  apparent_temperature_f: (number | null)[];
  quality_flags?: { missing_values: number };
}

export interface CellForecasts {
  grid_fingerprint: string;
  temperature_unit: string;
  forecast_times: string[];
  cell_count: number;
  cells: CellForecast[];
}

export interface Grid {
  grid_fingerprint: string;
  proj4: string;
  source_grid: { width: number; height: number };
  window: { col_off: number; row_off: number; width: number; height: number };
  window_transform: [number, number, number, number, number, number];
  cell_size_m: number;
}

/** Everything the interface needs before it can draw a forecast. */
export interface Bundle {
  base: string;
  manifest: Manifest;
  places: Map<string, Place>;
  ordered: Place[];
  placeCells: PlaceCells;
  cells: Map<string, CellForecast>;
  grid: Grid;
}

/** A resolved subject: a place, or an exact coordinate wearing a place's name. */
export interface Selection {
  cellId: string;
  label: string;
  /** Present when the reader picked a named place rather than their own coordinate. */
  slug: string | null;
  /** True when the cell came from the reader's own coordinate. */
  exact: boolean;
  /** Set when a coordinate resolved to a cell but sits outside every place polygon. */
  note?: string;
}
