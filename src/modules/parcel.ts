/**
 * Commoners Engine — M2: Parcel
 * The land stewardship unit. A Parcel is a Substrate cell (M1) that has been
 * claimed and is being actively managed by an agent.
 *
 * State machine: vacant → claimed → stewarded → degraded → restored
 * All state changes are event-sourced: events drive state, not direct mutation.
 * Sprint: P460
 */

import type { ConstraintDelta } from '../types.js';

// ─── Parcel Status ────────────────────────────────────────────────────────────

export enum ParcelStatus {
  Vacant    = 'vacant',     // unclaimed hex cell
  Claimed   = 'claimed',    // agent has claimed but not yet stewarded
  Stewarded = 'stewarded',  // active stewardship underway
  Degraded  = 'degraded',   // health dropped below degradation threshold
  Restored  = 'restored',   // recovered from Degraded via regenerative actions
}

// ─── Resource Types ───────────────────────────────────────────────────────────

export enum ResourceType {
  Biomass    = 'biomass',     // harvestable biological material
  Water      = 'water',       // accessible fresh water
  Soil       = 'soil',        // productive soil capacity
  Biodiversity = 'biodiversity', // species richness proxy
  Energy     = 'energy',      // solar/thermal capture
}

export type ResourceState = Record<ResourceType, number>;  // each 0..1

// ─── Parcel ───────────────────────────────────────────────────────────────────

export interface Parcel {
  parcelId:   string;         // == H3 cellId (resolution 7)
  ownerId:    string | null;  // agent_id or null if vacant
  status:     ParcelStatus;
  resources:  ResourceState;
  history:    ResourceSnapshot[];  // append-only resource history
  events:     ParcelEvent[];       // append-only event log
  createdAt:  number;
  updatedAt:  number;
}

// ─── Events ───────────────────────────────────────────────────────────────────

export type ParcelEventType =
  | 'claimed'
  | 'stewardship_started'
  | 'resource_updated'
  | 'degraded'
  | 'restored'
  | 'succession'      // ownership transferred across seasons (ActionCategory.Succession)
  | 'abandoned';      // owner released without succession

export interface ParcelEvent {
  type:        ParcelEventType;
  agentId:     string;
  payload:     Record<string, unknown>;
  timestamp:   number;
}

export interface ResourceSnapshot {
  resources:  ResourceState;
  timestamp:  number;
}

// ─── Parcel State ─────────────────────────────────────────────────────────────

export interface ParcelState {
  parcels: Map<string, Parcel>;
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

/** Health threshold below which a Stewarded parcel becomes Degraded. */
export const DEGRADATION_THRESHOLD = 0.25;

/** Health threshold above which a Degraded parcel becomes Restored. */
export const RESTORATION_THRESHOLD = 0.55;

// ─── Default Resource State ───────────────────────────────────────────────────

function defaultResources(): ResourceState {
  return {
    [ResourceType.Biomass]:      0.6,
    [ResourceType.Water]:        0.65,
    [ResourceType.Soil]:         0.7,
    [ResourceType.Biodiversity]: 0.65,
    [ResourceType.Energy]:       0.55,
  };
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Compute aggregate parcel health from resource state. */
export function computeParcelHealth(resources: ResourceState): number {
  const w = {
    [ResourceType.Water]:        0.30,
    [ResourceType.Soil]:         0.25,
    [ResourceType.Biodiversity]: 0.20,
    [ResourceType.Biomass]:      0.15,
    [ResourceType.Energy]:       0.10,
  };
  return Object.values(ResourceType).reduce(
    (acc, rt) => acc + resources[rt] * w[rt], 0
  );
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initParcelState(): ParcelState {
  return { parcels: new Map() };
}

// ─── Operations ───────────────────────────────────────────────────────────────

/**
 * Claim a vacant parcel on behalf of an agent.
 * Registers the parcel in state with status Claimed.
 *
 * NOTE: This function manages parcel state only.
 * The caller (M3 action pipeline) is responsible for ensuring the H3 cell
 * exists in SubstrateState via addCell() before or after this call.
 * Keeping module boundaries clean: Parcel doesn't import Substrate.
 */
export function claimParcel(
  ps: ParcelState,
  parcelId: string,
  agentId: string,
  now?: number,
): ParcelState {
  if (ps.parcels.has(parcelId)) {
    const existing = ps.parcels.get(parcelId)!;
    if (existing.status !== ParcelStatus.Vacant) {
      throw new Error(`Parcel ${parcelId} is already ${existing.status}`);
    }
  }

  const ts = now ?? Date.now();
  const initRes = defaultResources();
  const parcel: Parcel = {
    parcelId,
    ownerId:   agentId,
    status:    ParcelStatus.Claimed,
    resources: initRes,
    history:   [{ resources: initRes, timestamp: ts }],
    events:    [{ type: 'claimed', agentId, payload: {}, timestamp: ts }],
    createdAt: ts,
    updatedAt: ts,
  };

  const newParcels = new Map(ps.parcels);
  newParcels.set(parcelId, parcel);
  return { parcels: newParcels };
}

/**
 * Start active stewardship on a Claimed parcel.
 * Status transitions: Claimed → Stewarded.
 */
export function startStewardship(
  ps: ParcelState,
  parcelId: string,
  agentId: string,
  now?: number,
): ParcelState {
  const parcel = requireParcel(ps, parcelId);
  if (parcel.status !== ParcelStatus.Claimed) {
    throw new Error(`Cannot start stewardship on ${parcel.status} parcel`);
  }
  if (parcel.ownerId !== agentId) {
    throw new Error(`Agent ${agentId} does not own parcel ${parcelId}`);
  }

  return applyEvent(ps, parcelId, {
    type: 'stewardship_started',
    agentId,
    payload: {},
    timestamp: now ?? Date.now(),
  }, { status: ParcelStatus.Stewarded });
}

/**
 * Update parcel resource state from an agent action.
 * Returns the new ParcelState. Also returns the constraintDelta so the
 * caller (M3 action pipeline) can propagate it to SubstrateState.
 */
export function updateParcelResources(
  ps: ParcelState,
  parcelId: string,
  agentId: string,
  resourceDelta: Partial<ResourceState>,
  constraintDelta: ConstraintDelta,
  now?: number,
): ParcelState {
  const parcel = requireParcel(ps, parcelId);
  const ts = now ?? Date.now();

  const newResources: ResourceState = { ...parcel.resources };
  for (const [rt, delta] of Object.entries(resourceDelta)) {
    newResources[rt as ResourceType] = clamp(newResources[rt as ResourceType] + (delta ?? 0));
  }

  const newHealth = computeParcelHealth(newResources);

  // Determine next status from health thresholds
  let newStatus = parcel.status;
  if (
    (parcel.status === ParcelStatus.Stewarded || parcel.status === ParcelStatus.Restored) &&
    newHealth < DEGRADATION_THRESHOLD
  ) {
    newStatus = ParcelStatus.Degraded;
  } else if (
    parcel.status === ParcelStatus.Degraded &&
    newHealth >= RESTORATION_THRESHOLD
  ) {
    newStatus = ParcelStatus.Restored;
  }

  const events: ParcelEvent[] = [
    ...parcel.events,
    {
      type: 'resource_updated',
      agentId,
      payload: { resourceDelta, constraintDelta, newHealth },
      timestamp: ts,
    },
  ];

  if (newStatus === ParcelStatus.Degraded && parcel.status !== ParcelStatus.Degraded) {
    events.push({ type: 'degraded', agentId, payload: { health: newHealth }, timestamp: ts });
  } else if (newStatus === ParcelStatus.Restored && parcel.status === ParcelStatus.Degraded) {
    events.push({ type: 'restored', agentId, payload: { health: newHealth }, timestamp: ts });
  }

  const newParcels = new Map(ps.parcels);
  newParcels.set(parcelId, {
    ...parcel,
    status:    newStatus,
    resources: newResources,
    history:   [...parcel.history, { resources: newResources, timestamp: ts }],
    events,
    updatedAt: ts,
  });

  return { parcels: newParcels };
}

/**
 * Transfer ownership to a new agent (Succession — ActionCategory 6).
 * The current owner passes stewardship; the new owner inherits status and resources.
 * Status remains Stewarded/Restored after succession.
 */
export function succeedParcel(
  ps: ParcelState,
  parcelId: string,
  fromAgentId: string,
  toAgentId: string,
  now?: number,
): ParcelState {
  const parcel = requireParcel(ps, parcelId);
  if (parcel.ownerId !== fromAgentId) {
    throw new Error(`Agent ${fromAgentId} does not own parcel ${parcelId}`);
  }
  if (parcel.status === ParcelStatus.Vacant) {
    throw new Error('Cannot succeed a vacant parcel');
  }

  return applyEvent(ps, parcelId, {
    type: 'succession',
    agentId: fromAgentId,
    payload: { fromAgentId, toAgentId },
    timestamp: now ?? Date.now(),
  }, { ownerId: toAgentId });
}

/**
 * Abandon a parcel (no successor). Status → Vacant, owner → null.
 */
export function abandonParcel(
  ps: ParcelState,
  parcelId: string,
  agentId: string,
  now?: number,
): ParcelState {
  const parcel = requireParcel(ps, parcelId);
  if (parcel.ownerId !== agentId) {
    throw new Error(`Agent ${agentId} does not own parcel ${parcelId}`);
  }

  return applyEvent(ps, parcelId, {
    type: 'abandoned',
    agentId,
    payload: {},
    timestamp: now ?? Date.now(),
  }, { ownerId: null, status: ParcelStatus.Vacant });
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function getParcel(ps: ParcelState, parcelId: string): Parcel | undefined {
  return ps.parcels.get(parcelId);
}

export function listParcels(ps: ParcelState): Parcel[] {
  return Array.from(ps.parcels.values());
}

export function listParcelsByOwner(ps: ParcelState, agentId: string): Parcel[] {
  return listParcels(ps).filter(p => p.ownerId === agentId);
}

export function listParcelsByStatus(ps: ParcelState, status: ParcelStatus): Parcel[] {
  return listParcels(ps).filter(p => p.status === status);
}

/** Export parcel summaries for M4 Basin aggregate queries. */
export interface ParcelSummary {
  parcelId:  string;
  ownerId:   string | null;
  status:    ParcelStatus;
  health:    number;
}

export function exportParcelSummaries(ps: ParcelState): ParcelSummary[] {
  return listParcels(ps).map(p => ({
    parcelId: p.parcelId,
    ownerId:  p.ownerId,
    status:   p.status,
    health:   computeParcelHealth(p.resources),
  }));
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function requireParcel(ps: ParcelState, parcelId: string): Parcel {
  const p = ps.parcels.get(parcelId);
  if (!p) throw new Error(`Parcel ${parcelId} not found`);
  return p;
}

function applyEvent(
  ps: ParcelState,
  parcelId: string,
  event: ParcelEvent,
  overrides: Partial<Parcel> = {},
): ParcelState {
  const parcel = requireParcel(ps, parcelId);
  const newParcels = new Map(ps.parcels);
  newParcels.set(parcelId, {
    ...parcel,
    ...overrides,
    events: [...parcel.events, event],
    updatedAt: event.timestamp,
  });
  return { parcels: newParcels };
}
