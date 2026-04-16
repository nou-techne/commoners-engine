/**
 * Commoners Engine — M1: Substrate
 * The world layer. Every parcel (M2) lives in a Substrate cell.
 * Every Basin (M4) is a contiguous cluster of Substrate cells sharing a watershed.
 *
 * Uses H3 hexagonal grid at resolution 7 (~5.16 km² per cell).
 * Sprint: P459
 */

import { cellToLatLng, gridDisk, getResolution, latLngToCell, isPentagon } from 'h3-js';
import type {
  BiomeType,
  ConstraintParams,
  ConstraintDelta,
  HexCell,
  SubstrateState,
  CellSnapshot,
  SubstrateSnapshot,
} from '../types.js';
import { BiomeType as Biome } from '../types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_RESOLUTION = 7;

/** Natural decay rate per hour for each constraint dimension (fraction of current value). */
const DECAY_RATES: ConstraintParams = {
  thermodynamic: 0.001,   // slow — solar/heat cycles are relatively stable
  hydrological:  0.004,   // moderate — water is dynamic
  pedological:   0.0005,  // very slow — soil health changes over seasons
  ecological:    0.002,   // moderate — biodiversity responds to conditions
  demographic:   0.008,   // fastest — population pressure shifts quickly
  temporal:      0.003,   // moderate — seasonal drift
};

/** Base constraint values for each biome type. */
const BIOME_DEFAULTS: Record<BiomeType, ConstraintParams> = {
  [Biome.Forest]: {
    thermodynamic: 0.7,
    hydrological:  0.75,
    pedological:   0.8,
    ecological:    0.85,
    demographic:   0.3,
    temporal:      0.7,
  },
  [Biome.Grassland]: {
    thermodynamic: 0.75,
    hydrological:  0.55,
    pedological:   0.65,
    ecological:    0.7,
    demographic:   0.5,
    temporal:      0.65,
  },
  [Biome.Wetland]: {
    thermodynamic: 0.6,
    hydrological:  0.9,
    pedological:   0.7,
    ecological:    0.9,
    demographic:   0.2,
    temporal:      0.8,
  },
  [Biome.Arid]: {
    thermodynamic: 0.85,
    hydrological:  0.25,
    pedological:   0.35,
    ecological:    0.4,
    demographic:   0.2,
    temporal:      0.5,
  },
  [Biome.Riparian]: {
    thermodynamic: 0.65,
    hydrological:  0.88,
    pedological:   0.75,
    ecological:    0.88,
    demographic:   0.4,
    temporal:      0.85,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Clamp a value to [0, 1]. */
function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Apply a ConstraintDelta to ConstraintParams. Returns a new object. */
function applyDelta(params: ConstraintParams, delta: ConstraintDelta): ConstraintParams {
  return {
    thermodynamic: clamp(params.thermodynamic + (delta.thermodynamic ?? 0)),
    hydrological:  clamp(params.hydrological  + (delta.hydrological  ?? 0)),
    pedological:   clamp(params.pedological   + (delta.pedological   ?? 0)),
    ecological:    clamp(params.ecological    + (delta.ecological    ?? 0)),
    demographic:   clamp(params.demographic   + (delta.demographic   ?? 0)),
    temporal:      clamp(params.temporal      + (delta.temporal      ?? 0)),
  };
}

/** Compute aggregate health: weighted mean of constraint values. */
function computeHealth(c: ConstraintParams): number {
  const weights = {
    thermodynamic: 0.1,
    hydrological:  0.25,  // water is most critical in most biomes
    pedological:   0.2,
    ecological:    0.25,
    demographic:   0.1,
    temporal:      0.1,
  };
  return (
    c.thermodynamic * weights.thermodynamic +
    c.hydrological  * weights.hydrological  +
    c.pedological   * weights.pedological   +
    c.ecological    * weights.ecological    +
    c.demographic   * weights.demographic   +
    c.temporal      * weights.temporal
  );
}

/** Infer a biome type from lat/lng (stub — real impl would use land-cover data). */
function inferBiome(lat: number, lng: number): BiomeType {
  // Stub heuristic for South Boulder Creek watershed:
  // elevation proxy via latitude offset; replace with actual land-cover API
  const absLat = Math.abs(lat);
  if (absLat > 45) return Biome.Arid;
  if (lng < -110 && absLat > 38) return Biome.Forest;
  if (lng > -90) return Biome.Wetland;
  return Biome.Grassland;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export interface SubstrateInitOptions {
  resolution?: number;
  seedCells?:  Array<{ cellId: string; biomeType?: BiomeType; constraints?: Partial<ConstraintParams> }>;
  now?:        number;  // unix ms, for testing
}

/**
 * Create a new SubstrateState.
 * If seedCells are provided, initializes exactly those cells.
 * Otherwise returns an empty substrate ready to receive cells via addCell().
 */
export function initSubstrate(opts: SubstrateInitOptions = {}): SubstrateState {
  const resolution = opts.resolution ?? DEFAULT_RESOLUTION;
  const now = opts.now ?? Date.now();
  const cells = new Map<string, HexCell>();

  for (const seed of opts.seedCells ?? []) {
    if (getResolution(seed.cellId) !== resolution) {
      throw new Error(`Cell ${seed.cellId} resolution mismatch (expected ${resolution})`);
    }
    const [lat, lng] = cellToLatLng(seed.cellId);
    const biomeType = seed.biomeType ?? inferBiome(lat, lng);
    const base = BIOME_DEFAULTS[biomeType];
    const constraints: ConstraintParams = seed.constraints
      ? applyDelta(base, seed.constraints)
      : { ...base };

    cells.set(seed.cellId, { cellId: seed.cellId, biomeType, constraints, lastUpdated: now });
  }

  return { resolution, cells, createdAt: now, updatedAt: now };
}

// ─── Cell CRUD ────────────────────────────────────────────────────────────────

/**
 * Add a single cell to the substrate (e.g., when an agent claims a parcel).
 * Throws if the cell already exists.
 */
export function addCell(
  state: SubstrateState,
  cellId: string,
  biomeType?: BiomeType,
  overrides?: Partial<ConstraintParams>,
  now?: number,
): SubstrateState {
  if (state.cells.has(cellId)) {
    throw new Error(`Cell ${cellId} already exists in substrate`);
  }
  if (getResolution(cellId) !== state.resolution) {
    throw new Error(`Cell ${cellId} resolution mismatch (expected ${state.resolution})`);
  }
  const [lat, lng] = cellToLatLng(cellId);
  const resolvedBiome = biomeType ?? inferBiome(lat, lng);
  const base = BIOME_DEFAULTS[resolvedBiome];
  const constraints = overrides ? applyDelta(base, overrides) : { ...base };
  const ts = now ?? Date.now();

  const updated = new Map(state.cells);
  updated.set(cellId, { cellId, biomeType: resolvedBiome, constraints, lastUpdated: ts });
  return { ...state, cells: updated, updatedAt: ts };
}

/** Read a cell. Returns undefined if not found. */
export function getCell(state: SubstrateState, cellId: string): HexCell | undefined {
  return state.cells.get(cellId);
}

/** List all cell IDs. */
export function listCells(state: SubstrateState): string[] {
  return Array.from(state.cells.keys());
}

// ─── Constraint Updates ───────────────────────────────────────────────────────

/**
 * Apply a ConstraintDelta to a cell (called by M3 action pipeline).
 * Returns a new SubstrateState (immutable update).
 */
export function updateConstraints(
  state: SubstrateState,
  cellId: string,
  delta: ConstraintDelta,
  now?: number,
): SubstrateState {
  const cell = state.cells.get(cellId);
  if (!cell) throw new Error(`Cell ${cellId} not found in substrate`);

  const ts = now ?? Date.now();
  const updated = new Map(state.cells);
  updated.set(cellId, {
    ...cell,
    constraints: applyDelta(cell.constraints, delta),
    lastUpdated: ts,
  });
  return { ...state, cells: updated, updatedAt: ts };
}

/**
 * Apply natural decay to a cell based on elapsed time.
 * dt = hours elapsed since lastUpdated.
 * Called by M6 Season during Reckoning phase.
 */
export function decayConstraints(
  state: SubstrateState,
  cellId: string,
  dt: number,  // hours
  now?: number,
): SubstrateState {
  const cell = state.cells.get(cellId);
  if (!cell) throw new Error(`Cell ${cellId} not found`);

  const ts = now ?? Date.now();
  const c = cell.constraints;
  const decayed: ConstraintParams = {
    thermodynamic: clamp(c.thermodynamic - DECAY_RATES.thermodynamic * dt * c.thermodynamic),
    hydrological:  clamp(c.hydrological  - DECAY_RATES.hydrological  * dt * c.hydrological),
    pedological:   clamp(c.pedological   - DECAY_RATES.pedological   * dt * c.pedological),
    ecological:    clamp(c.ecological    - DECAY_RATES.ecological    * dt * c.ecological),
    demographic:   clamp(c.demographic   - DECAY_RATES.demographic   * dt * c.demographic),
    temporal:      clamp(c.temporal      - DECAY_RATES.temporal      * dt * c.temporal),
  };

  const updated = new Map(state.cells);
  updated.set(cellId, { ...cell, constraints: decayed, lastUpdated: ts });
  return { ...state, cells: updated, updatedAt: ts };
}

/**
 * Decay all cells in the substrate by dt hours.
 * Convenience wrapper for Reckoning phase.
 */
export function decayAll(
  state: SubstrateState,
  dt: number,
  now?: number,
): SubstrateState {
  const ts = now ?? Date.now();
  let current = state;
  for (const cellId of current.cells.keys()) {
    current = decayConstraints(current, cellId, dt, ts);
  }
  return current;
}

// ─── Basin Integration (M4 export) ───────────────────────────────────────────

/**
 * Return all cells within k rings of a center cell (H3 gridDisk).
 * Used by M4 Basin to define a basin's cell membership.
 */
export function getBasinCells(
  state: SubstrateState,
  centerCellId: string,
  ringRadius: number = 3,
): HexCell[] {
  const disk = gridDisk(centerCellId, ringRadius);
  return disk
    .filter(id => state.cells.has(id))
    .map(id => state.cells.get(id)!);
}

/**
 * Export a serializable substrate snapshot for M4 basin aggregate queries.
 * Strips the Map structure; returns plain arrays.
 */
export function exportSnapshot(state: SubstrateState): SubstrateSnapshot {
  const cells: CellSnapshot[] = Array.from(state.cells.values()).map(cell => ({
    cellId:      cell.cellId,
    biomeType:   cell.biomeType,
    constraints: cell.constraints,
    health:      computeHealth(cell.constraints),
  }));

  return {
    resolution:  state.resolution,
    cellCount:   cells.length,
    cells,
    snapshotAt:  Date.now(),
  };
}

/**
 * Compute a lat/lng seed cell for the South Boulder Creek Watershed (default basin).
 * Returns an H3 cell ID at the configured resolution.
 */
export function southBoulderCreekSeedCell(resolution: number = DEFAULT_RESOLUTION): string {
  // South Boulder Creek Watershed centroid: ~39.95°N, 105.27°W
  return latLngToCell(39.95, -105.27, resolution);
}

// ─── Re-export health utility (used by M4, M7) ────────────────────────────────
export { computeHealth };
