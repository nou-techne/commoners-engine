/**
 * Commoners Engine — M3: Agents (Player Entities)
 * An agent is any participant — human-operated, AI, or bot — that takes
 * stewardship actions in the world.
 *
 * ## Agent Contract (frozen at P461)
 * The public surface used by M4 Basin, M5 Governance, M7 Trust, M8 Chain.
 * Once published, changes are semver-breaking (require a new sprint):
 *   - AgentState, Agent, AgentType, AgentStatus
 *   - ActionRequest, ActionResult
 *   - ActionCategory (already in types.ts — do not move)
 *   - initAgentState, registerAgent, executeAction
 *   - getAgent, listAgentsByStatus
 *
 * Sprint: P461
 */

import type { ConstraintDelta } from '../types.js';
import { ActionCategory } from '../types.js';
import type { ResourceState, ResourceType } from './parcel.js';
import type { ParcelState } from './parcel.js';
import {
  getParcel,
  updateParcelResources,
  ParcelStatus,
} from './parcel.js';

// ─── Agent Entity ─────────────────────────────────────────────────────────────

export enum AgentType {
  Human = 'human',
  AI    = 'ai',
  Bot   = 'bot',
}

export enum AgentStatus {
  Active   = 'active',
  Inactive = 'inactive',
}

export interface Agent {
  agentId:     string;         // Ethereum address (EIP-55 checksum)
  displayName: string;
  agentType:   AgentType;
  status:      AgentStatus;
  parcelIds:   string[];       // H3 cellIds of owned parcels
  createdAt:   number;
  updatedAt:   number;
}

// ─── Agent State ──────────────────────────────────────────────────────────────

export interface AgentState {
  agents: Map<string, Agent>;
}

// ─── Action Types ─────────────────────────────────────────────────────────────

/**
 * An action request submitted by an agent.
 * The pipeline validates, resolves effects, and emits results.
 */
export interface ActionRequest {
  actionId:      string;            // client-provided UUID
  agentId:       string;
  category:      ActionCategory;
  targetParcel:  string;            // H3 cellId
  resourceType?: ResourceType;      // primary resource affected (nullable for non-resource actions)
  intensity:     number;            // 0..1 — how hard the agent pushes this action
  collaborators?: string[];         // other agentIds involved (for Relational / Governing)
  timestamp:     number;
}

/**
 * The resolved output of a single action.
 * Three streams for downstream modules:
 *   - resourceDelta → M2 Parcel (updateParcelResources)
 *   - constraintDelta → M1 Substrate (updateConstraints) — propagated by caller
 *   - trustSignal → M7 Trust/Reputation
 *   - event → M4 Basin event log
 */
export interface ActionResult {
  actionId:        string;
  agentId:         string;
  category:        ActionCategory;
  targetParcel:    string;
  resourceDelta:   Partial<Record<ResourceType, number>>;
  constraintDelta: ConstraintDelta;
  trustSignal:     TrustSignal;
  event:           ActionEvent;
  timestamp:       number;
}

// ─── Trust Signal ─────────────────────────────────────────────────────────────

export interface TrustSignal {
  agentId:       string;
  category:      ActionCategory;
  /** Signed scalar: positive = prosocial, negative = extractive/defection. */
  valence:       number;   // -1..1
  intensity:     number;   // 0..1 (mirrors ActionRequest.intensity)
  targetParcel:  string;
}

// ─── Action Event ─────────────────────────────────────────────────────────────

export interface ActionEvent {
  type:          string;           // 'action_executed'
  actionId:      string;
  agentId:       string;
  category:      ActionCategory;
  targetParcel:  string;
  payload:       Record<string, unknown>;
  timestamp:     number;
}

// ─── Effect Tables ────────────────────────────────────────────────────────────
// Per-category resource and constraint effect shapes.
// intensity scales the base deltas linearly.

/**
 * Productive: extract resources — negative resource delta, negative trust valence.
 * The parcel provides output; constraints are drawn down.
 */
function resolveProductive(req: ActionRequest): Pick<ActionResult, 'resourceDelta' | 'constraintDelta' | 'trustSignal'> {
  const scale = -req.intensity * 0.3;   // max 0.3 extraction per action
  const rd: Partial<Record<ResourceType, number>> = {};
  if (req.resourceType) rd[req.resourceType] = scale;

  return {
    resourceDelta:   rd,
    constraintDelta: { hydrological: scale * 0.5, pedological: scale * 0.3 },
    trustSignal: {
      agentId:      req.agentId,
      category:     ActionCategory.Productive,
      valence:      -req.intensity * 0.4,   // extraction is slightly extractive
      intensity:    req.intensity,
      targetParcel: req.targetParcel,
    },
  };
}

/**
 * Regenerative: restore resources — positive resource delta, positive trust valence.
 */
function resolveRegenerative(req: ActionRequest): Pick<ActionResult, 'resourceDelta' | 'constraintDelta' | 'trustSignal'> {
  const scale = req.intensity * 0.25;
  const rd: Partial<Record<ResourceType, number>> = {};
  if (req.resourceType) rd[req.resourceType] = scale;

  return {
    resourceDelta:   rd,
    constraintDelta: { hydrological: scale * 0.4, ecological: scale * 0.3, pedological: scale * 0.2 },
    trustSignal: {
      agentId:      req.agentId,
      category:     ActionCategory.Regenerative,
      valence:      req.intensity * 0.8,
      intensity:    req.intensity,
      targetParcel: req.targetParcel,
    },
  };
}

/**
 * Infrastructural: build shared infrastructure — neutral to slightly positive.
 */
function resolveInfrastructural(req: ActionRequest): Pick<ActionResult, 'resourceDelta' | 'constraintDelta' | 'trustSignal'> {
  return {
    resourceDelta:   {},
    constraintDelta: { thermodynamic: req.intensity * 0.1, temporal: req.intensity * 0.05 },
    trustSignal: {
      agentId:      req.agentId,
      category:     ActionCategory.Infrastructural,
      valence:      req.intensity * 0.3,
      intensity:    req.intensity,
      targetParcel: req.targetParcel,
    },
  };
}

/**
 * Governing: proposal/vote — no resource effect, positive trust for participation.
 */
function resolveGoverning(req: ActionRequest): Pick<ActionResult, 'resourceDelta' | 'constraintDelta' | 'trustSignal'> {
  return {
    resourceDelta:   {},
    constraintDelta: { demographic: req.intensity * 0.05 },
    trustSignal: {
      agentId:      req.agentId,
      category:     ActionCategory.Governing,
      valence:      req.intensity * 0.5,
      intensity:    req.intensity,
      targetParcel: req.targetParcel,
    },
  };
}

/**
 * Relational: inter-agent coordination — strengthens social fabric.
 */
function resolveRelational(req: ActionRequest): Pick<ActionResult, 'resourceDelta' | 'constraintDelta' | 'trustSignal'> {
  return {
    resourceDelta:   {},
    constraintDelta: { demographic: req.intensity * 0.08 },
    trustSignal: {
      agentId:      req.agentId,
      category:     ActionCategory.Relational,
      valence:      req.intensity * 0.6,
      intensity:    req.intensity,
      targetParcel: req.targetParcel,
    },
  };
}

/**
 * Informational: observation/reporting — small positive signal for visibility.
 */
function resolveInformational(req: ActionRequest): Pick<ActionResult, 'resourceDelta' | 'constraintDelta' | 'trustSignal'> {
  return {
    resourceDelta:   {},
    constraintDelta: { temporal: req.intensity * 0.03 },
    trustSignal: {
      agentId:      req.agentId,
      category:     ActionCategory.Informational,
      valence:      req.intensity * 0.2,
      intensity:    req.intensity,
      targetParcel: req.targetParcel,
    },
  };
}

/**
 * Succession: cross-season ownership transfer — high trust, handled by parcel module.
 * Resource/constraint effects are resolved by the succeedParcel call in M2.
 */
function resolveSuccession(req: ActionRequest): Pick<ActionResult, 'resourceDelta' | 'constraintDelta' | 'trustSignal'> {
  return {
    resourceDelta:   {},
    constraintDelta: {},
    trustSignal: {
      agentId:      req.agentId,
      category:     ActionCategory.Succession,
      valence:      1.0,   // The memo's primary victory condition — highest trust signal
      intensity:    req.intensity,
      targetParcel: req.targetParcel,
    },
  };
}

const EFFECT_RESOLVERS: Record<ActionCategory, (req: ActionRequest) => Pick<ActionResult, 'resourceDelta' | 'constraintDelta' | 'trustSignal'>> = {
  [ActionCategory.Productive]:      resolveProductive,
  [ActionCategory.Regenerative]:    resolveRegenerative,
  [ActionCategory.Infrastructural]: resolveInfrastructural,
  [ActionCategory.Governing]:       resolveGoverning,
  [ActionCategory.Relational]:      resolveRelational,
  [ActionCategory.Informational]:   resolveInformational,
  [ActionCategory.Succession]:      resolveSuccession,
};

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initAgentState(): AgentState {
  return { agents: new Map() };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerAgent(
  as: AgentState,
  agentId: string,
  displayName: string,
  agentType: AgentType = AgentType.Human,
  now?: number,
): AgentState {
  if (as.agents.has(agentId)) {
    throw new Error(`Agent ${agentId} already registered`);
  }
  const ts = now ?? Date.now();
  const agent: Agent = {
    agentId,
    displayName,
    agentType,
    status:    AgentStatus.Active,
    parcelIds: [],
    createdAt: ts,
    updatedAt: ts,
  };
  const newAgents = new Map(as.agents);
  newAgents.set(agentId, agent);
  return { agents: newAgents };
}

/** Sync parcel ownership into AgentState after a parcel operation. */
export function syncAgentParcels(
  as: AgentState,
  agentId: string,
  parcelIds: string[],
  now?: number,
): AgentState {
  const agent = requireAgent(as, agentId);
  const ts = now ?? Date.now();
  const newAgents = new Map(as.agents);
  newAgents.set(agentId, { ...agent, parcelIds, updatedAt: ts });
  return { agents: newAgents };
}

// ─── Action Pipeline ──────────────────────────────────────────────────────────

/**
 * Validate an action request before execution.
 * Throws with descriptive messages on any violation.
 */
function validateAction(
  as: AgentState,
  ps: ParcelState,
  req: ActionRequest,
): void {
  // Agent must exist and be active
  const agent = as.agents.get(req.agentId);
  if (!agent) throw new Error(`Agent ${req.agentId} not registered`);
  if (agent.status !== AgentStatus.Active) throw new Error(`Agent ${req.agentId} is ${agent.status}`);

  // Parcel must exist
  const parcel = getParcel(ps, req.targetParcel);
  if (!parcel) throw new Error(`Parcel ${req.targetParcel} not found`);

  // Parcel must not be vacant for resource actions
  if (parcel.status === ParcelStatus.Vacant &&
      req.category !== ActionCategory.Informational) {
    throw new Error(`Cannot act on vacant parcel ${req.targetParcel}`);
  }

  // Resource-touching actions require ownership or Regenerative intent
  if (
    (req.category === ActionCategory.Productive ||
     req.category === ActionCategory.Regenerative) &&
    parcel.ownerId !== req.agentId
  ) {
    throw new Error(`Agent ${req.agentId} does not own parcel ${req.targetParcel}`);
  }

  // Intensity must be in [0, 1]
  if (req.intensity < 0 || req.intensity > 1) {
    throw new Error(`Intensity must be in [0, 1], got ${req.intensity}`);
  }
}

/**
 * Execute an action in the world.
 *
 * Returns:
 *   - newAgentState: updated agent state
 *   - newParcelState: updated parcel state (resource deltas applied)
 *   - result: ActionResult carrying all three output streams
 *
 * NOTE: The caller (M4 integration layer) is responsible for propagating
 * result.constraintDelta to SubstrateState via updateConstraints().
 * Keeping module boundaries clean: agent.ts does not import substrate.ts.
 */
export function executeAction(
  as: AgentState,
  ps: ParcelState,
  req: ActionRequest,
): { newAgentState: AgentState; newParcelState: ParcelState; result: ActionResult } {
  validateAction(as, ps, req);

  const resolver = EFFECT_RESOLVERS[req.category];
  const effects = resolver(req);

  const event: ActionEvent = {
    type:         'action_executed',
    actionId:     req.actionId,
    agentId:      req.agentId,
    category:     req.category,
    targetParcel: req.targetParcel,
    payload: {
      resourceDelta:   effects.resourceDelta,
      constraintDelta: effects.constraintDelta,
      trustSignal:     effects.trustSignal,
      intensity:       req.intensity,
    },
    timestamp: req.timestamp,
  };

  const result: ActionResult = {
    actionId:        req.actionId,
    agentId:         req.agentId,
    category:        req.category,
    targetParcel:    req.targetParcel,
    ...effects,
    event,
    timestamp:       req.timestamp,
  };

  // Apply resource delta to parcel state (immutable)
  const newParcelState = updateParcelResources(
    ps,
    req.targetParcel,
    req.agentId,
    effects.resourceDelta,
    effects.constraintDelta,
    req.timestamp,
  );

  // Agent state itself doesn't change from a simple action execution;
  // parcel ownership is synced by explicit syncAgentParcels calls.
  return {
    newAgentState: as,
    newParcelState,
    result,
  };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function getAgent(as: AgentState, agentId: string): Agent | undefined {
  return as.agents.get(agentId);
}

export function listAgents(as: AgentState): Agent[] {
  return Array.from(as.agents.values());
}

export function listAgentsByStatus(as: AgentState, status: AgentStatus): Agent[] {
  return listAgents(as).filter(a => a.status === status);
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function requireAgent(as: AgentState, agentId: string): Agent {
  const a = as.agents.get(agentId);
  if (!a) throw new Error(`Agent ${agentId} not found`);
  return a;
}
