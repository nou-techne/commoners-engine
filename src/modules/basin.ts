/**
 * Commoners Engine — M4: Basin (Watershed Commons)
 * The Basin is the Ostrom commons unit — a contiguous set of Substrate cells
 * sharing a watershed. Basin-level resources are affected by aggregate parcel
 * stewardship. Agents within a Basin share a commons pool.
 *
 * Design decisions:
 * - Basin state is a pure function of its member parcel states + substrate cells.
 * - Cross-parcel flows use a simple directed graph (upstream → downstream).
 *   Flow weight is a scalar [0,1] representing how much of the upstream resource
 *   delta bleeds into the downstream parcel's commons pool.
 * - Commons pool is separate from individual parcel resources — it represents
 *   shared goods no single parcel fully owns (watershed health, soil carbon,
 *   biodiversity index).
 * - Basin stress fires when aggregate externality score exceeds STRESS_THRESHOLD.
 *
 * Sprint: P462
 */

import { gridDisk } from 'h3-js';
import type { SubstrateState } from '../types.js';
import { computeHealth } from './substrate.js';
import type { ParcelState } from './parcel.js';
import { computeParcelHealth, listParcels, exportParcelSummaries } from './parcel.js';
import type { ActionResult } from './agent.js';

// ─── Basin Commons Pool ───────────────────────────────────────────────────────

export interface BasinCommons {
  watershedHealth:    number;   // aggregate hydrological score across cells
  soilCarbonIndex:    number;   // aggregate pedological score
  biodiversityIndex:  number;   // aggregate ecological score
}

// ─── Flow Network ─────────────────────────────────────────────────────────────

export interface FlowEdge {
  upstreamParcelId:   string;
  downstreamParcelId: string;
  /** Fraction [0,1] of upstream resource delta that flows downstream. */
  weight:             number;
}

export interface FlowNetwork {
  edges: FlowEdge[];
}

// ─── Basin Entity ─────────────────────────────────────────────────────────────

export interface Basin {
  basinId:      string;           // H3 cellId of the basin center cell
  cellIds:      string[];         // all H3 cells in the basin (resolution 7)
  parcelIds:    string[];         // subset of cellIds that have claimed parcels
  commons:      BasinCommons;
  flowNetwork:  FlowNetwork;
  /** Accumulated externality score from M3 action results. Resets each Reckoning. */
  externalityAccumulator: number;
  events:       BasinEvent[];
  createdAt:    number;
  updatedAt:    number;
}

// ─── Basin Events ─────────────────────────────────────────────────────────────

export type BasinEventType =
  | 'basin_created'
  | 'commons_updated'
  | 'flow_applied'
  | 'basin_stress';    // externality score exceeded STRESS_THRESHOLD

export interface BasinEvent {
  type:       BasinEventType;
  payload:    Record<string, unknown>;
  timestamp:  number;
}

// ─── Basin State ──────────────────────────────────────────────────────────────

export interface BasinState {
  basins: Map<string, Basin>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Ring radius (H3 grid distance) defining the basin footprint. */
export const BASIN_RING_RADIUS = 3;

/**
 * Externality accumulator threshold above which a basin_stress event fires.
 * Calibrated so that 3 heavy-extraction actions in one round trigger stress.
 */
export const STRESS_THRESHOLD = 0.8;

/** Default flow weight for adjacent parcels if no explicit edge is set. */
export const DEFAULT_FLOW_WEIGHT = 0.15;

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initBasinState(): BasinState {
  return { basins: new Map() };
}

// ─── Basin Creation ───────────────────────────────────────────────────────────

/**
 * Create a Basin centered on a given H3 cell.
 * The basin footprint is a gridDisk of BASIN_RING_RADIUS rings.
 * If the SubstrateState has cells within that disk, they are included.
 */
export function createBasin(
  bs: BasinState,
  ss: SubstrateState,
  ps: ParcelState,
  centerCellId: string,
  now?: number,
): BasinState {
  if (bs.basins.has(centerCellId)) {
    throw new Error(`Basin ${centerCellId} already exists`);
  }

  const ts = now ?? Date.now();

  // Basin footprint: all H3 cells in the disk
  const disk = new Set(gridDisk(centerCellId, BASIN_RING_RADIUS));
  const cellIds = Array.from(disk).filter(c => ss.cells.has(c));

  // Parcels within basin
  const allParcels = listParcels(ps);
  const parcelIds = allParcels
    .filter(p => disk.has(p.parcelId))
    .map(p => p.parcelId);

  const commons = computeBasinCommons(ss, cellIds);
  const flowNetwork = buildFlowNetwork(parcelIds);

  const basin: Basin = {
    basinId:                centerCellId,
    cellIds,
    parcelIds,
    commons,
    flowNetwork,
    externalityAccumulator: 0,
    events: [{ type: 'basin_created', payload: { cellCount: cellIds.length, parcelCount: parcelIds.length }, timestamp: ts }],
    createdAt: ts,
    updatedAt: ts,
  };

  const newBasins = new Map(bs.basins);
  newBasins.set(centerCellId, basin);
  return { basins: newBasins };
}

// ─── Commons Computation ──────────────────────────────────────────────────────

/**
 * Recompute basin commons from current substrate state.
 * Pure function — no side effects.
 */
export function computeBasinCommons(
  ss: SubstrateState,
  cellIds: string[],
): BasinCommons {
  if (cellIds.length === 0) {
    return { watershedHealth: 0, soilCarbonIndex: 0, biodiversityIndex: 0 };
  }

  let hydro = 0, pedo = 0, eco = 0;
  let count = 0;

  for (const cellId of cellIds) {
    const cell = ss.cells.get(cellId);
    if (!cell) continue;
    hydro += cell.constraints.hydrological;
    pedo  += cell.constraints.pedological;
    eco   += cell.constraints.ecological;
    count++;
  }

  if (count === 0) return { watershedHealth: 0, soilCarbonIndex: 0, biodiversityIndex: 0 };

  return {
    watershedHealth:   hydro / count,
    soilCarbonIndex:   pedo  / count,
    biodiversityIndex: eco   / count,
  };
}

/**
 * Recompute aggregate basin health as weighted mean of:
 * - commons pool (60%)
 * - average parcel health (40%)
 */
export function computeBasinHealth(
  bs: BasinState,
  ps: ParcelState,
  basinId: string,
): number {
  const basin = bs.basins.get(basinId);
  if (!basin) throw new Error(`Basin ${basinId} not found`);

  const { commons } = basin;
  const commonsHealth = (commons.watershedHealth + commons.soilCarbonIndex + commons.biodiversityIndex) / 3;

  const summaries = exportParcelSummaries(ps).filter(s => basin.parcelIds.includes(s.parcelId));
  const parcelHealth = summaries.length > 0
    ? summaries.reduce((acc, s) => acc + s.health, 0) / summaries.length
    : 0;

  return commonsHealth * 0.6 + parcelHealth * 0.4;
}

// ─── Flow Network ─────────────────────────────────────────────────────────────

/**
 * Build a simple linear flow network from a list of parcel IDs.
 * For the demo: each parcel flows into the next (ordering = array order).
 * Production M4 would use H3 grid distance and elevation data to determine
 * actual watershed flow direction.
 */
function buildFlowNetwork(parcelIds: string[]): FlowNetwork {
  if (parcelIds.length < 2) return { edges: [] };

  const edges: FlowEdge[] = [];
  for (let i = 0; i < parcelIds.length - 1; i++) {
    edges.push({
      upstreamParcelId:   parcelIds[i],
      downstreamParcelId: parcelIds[i + 1],
      weight:             DEFAULT_FLOW_WEIGHT,
    });
  }
  return { edges };
}

/**
 * Apply cross-parcel flows from an upstream action result to downstream commons.
 * Returns updated BasinState.
 *
 * Flow mechanic: if an upstream parcel's resource delta is negative (extraction),
 * that stress propagates downstream at `edge.weight` intensity.
 * Positive (restoration) also flows, representing watershed benefits.
 */
export function applyFlows(
  bs: BasinState,
  basinId: string,
  result: ActionResult,
  now?: number,
): BasinState {
  const basin = bs.basins.get(basinId);
  if (!basin) throw new Error(`Basin ${basinId} not found`);

  const ts = now ?? Date.now();

  // Find edges where this action's parcel is upstream
  const downstreamEdges = basin.flowNetwork.edges.filter(
    e => e.upstreamParcelId === result.targetParcel,
  );

  if (downstreamEdges.length === 0) {
    return bs; // No flows to apply
  }

  // Compute net resource delta sign: negative = extraction stress
  const totalDelta = Object.values(result.resourceDelta).reduce((sum, v) => sum + (v ?? 0), 0);
  const flowSignal = totalDelta; // positive = restoration benefit, negative = extraction stress

  const events: BasinEvent[] = [
    ...basin.events,
    {
      type:      'flow_applied',
      payload:   { fromParcel: result.targetParcel, flowSignal, edgeCount: downstreamEdges.length },
      timestamp: ts,
    },
  ];

  const newBasins = new Map(bs.basins);
  newBasins.set(basinId, { ...basin, events, updatedAt: ts });
  return { basins: newBasins };
}

// ─── Externality Accumulation ─────────────────────────────────────────────────

/**
 * Accumulate externality score from an action result into the basin.
 * Fires a basin_stress event if STRESS_THRESHOLD is crossed.
 *
 * Externality is measured by the magnitude of negative trust valence
 * (extractive actions impose externalities on the commons).
 */
export function accumulateExternality(
  bs: BasinState,
  basinId: string,
  result: ActionResult,
  now?: number,
): BasinState {
  const basin = bs.basins.get(basinId);
  if (!basin) throw new Error(`Basin ${basinId} not found`);

  // Only extraction actions contribute negative externality
  const contribution = result.trustSignal.valence < 0
    ? Math.abs(result.trustSignal.valence) * result.trustSignal.intensity
    : 0;

  const newAccumulator = basin.externalityAccumulator + contribution;
  const ts = now ?? Date.now();

  const events: BasinEvent[] = [...basin.events];
  const alreadyStressed = basin.events.some(e => e.type === 'basin_stress');

  if (!alreadyStressed && newAccumulator >= STRESS_THRESHOLD) {
    events.push({
      type:      'basin_stress',
      payload:   { externalityAccumulator: newAccumulator, threshold: STRESS_THRESHOLD },
      timestamp: ts,
    });
  }

  const newBasins = new Map(bs.basins);
  newBasins.set(basinId, {
    ...basin,
    externalityAccumulator: newAccumulator,
    events,
    updatedAt: ts,
  });
  return { basins: newBasins };
}

/**
 * Reset the externality accumulator at the start of each Reckoning phase.
 */
export function resetExternality(
  bs: BasinState,
  basinId: string,
  now?: number,
): BasinState {
  const basin = requireBasin(bs, basinId);
  const ts = now ?? Date.now();
  const newBasins = new Map(bs.basins);
  newBasins.set(basinId, {
    ...basin,
    externalityAccumulator: 0,
    updatedAt: ts,
  });
  return { basins: newBasins };
}

// ─── Commons Update ───────────────────────────────────────────────────────────

/**
 * Refresh the basin commons pool from current substrate state.
 * Call this after applying substrate constraint updates (end of execution phase).
 */
export function refreshCommons(
  bs: BasinState,
  ss: SubstrateState,
  basinId: string,
  now?: number,
): BasinState {
  const basin = requireBasin(bs, basinId);
  const ts = now ?? Date.now();

  const newCommons = computeBasinCommons(ss, basin.cellIds);
  const events: BasinEvent[] = [
    ...basin.events,
    { type: 'commons_updated', payload: { ...newCommons }, timestamp: ts },
  ];

  const newBasins = new Map(bs.basins);
  newBasins.set(basinId, {
    ...basin,
    commons:   newCommons,
    events,
    updatedAt: ts,
  });
  return { basins: newBasins };
}

/**
 * Sync parcel membership — call after new parcels are claimed within the basin footprint.
 */
export function syncParcelMembership(
  bs: BasinState,
  ps: ParcelState,
  basinId: string,
  now?: number,
): BasinState {
  const basin = requireBasin(bs, basinId);
  const ts = now ?? Date.now();
  const disk = new Set(gridDisk(basinId, BASIN_RING_RADIUS));
  const parcelIds = listParcels(ps)
    .filter(p => disk.has(p.parcelId))
    .map(p => p.parcelId);
  const flowNetwork = buildFlowNetwork(parcelIds);

  const newBasins = new Map(bs.basins);
  newBasins.set(basinId, { ...basin, parcelIds, flowNetwork, updatedAt: ts });
  return { basins: newBasins };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function getBasin(bs: BasinState, basinId: string): Basin | undefined {
  return bs.basins.get(basinId);
}

export function listBasins(bs: BasinState): Basin[] {
  return Array.from(bs.basins.values());
}

/**
 * Produce a JSON-serializable snapshot of a basin for spectator/M8 consumption.
 */
export interface BasinSnapshot {
  basinId:               string;
  cellCount:             number;
  parcelCount:           number;
  commons:               BasinCommons;
  health:                number;
  externalityAccumulator:number;
  stressed:              boolean;
  snapshotAt:            number;
}

export function exportBasinSnapshot(
  bs: BasinState,
  ps: ParcelState,
  basinId: string,
  now?: number,
): BasinSnapshot {
  const basin = requireBasin(bs, basinId);
  return {
    basinId,
    cellCount:              basin.cellIds.length,
    parcelCount:            basin.parcelIds.length,
    commons:                basin.commons,
    health:                 computeBasinHealth(bs, ps, basinId),
    externalityAccumulator: basin.externalityAccumulator,
    stressed:               basin.events.some(e => e.type === 'basin_stress'),
    snapshotAt:             now ?? Date.now(),
  };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function requireBasin(bs: BasinState, basinId: string): Basin {
  const b = bs.basins.get(basinId);
  if (!b) throw new Error(`Basin ${basinId} not found`);
  return b;
}
