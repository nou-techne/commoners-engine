/**
 * Commoners Engine — M6: Season (minimal round structure for P467 Dress Rehearsal)
 *
 * Full M6 has five phases: Proposing → Negotiating → Reading → Execution → Reckoning.
 * This implementation covers the three phases needed for the late-April Olympiad demo:
 *   Reading → Execution → Reckoning
 *
 * Solo play: one agent, one parcel, no cross-parcel flows, no governance.
 *
 * Sprint: P467 (wiring sprint — depends on P459/P460/P461)
 */

import type { ConstraintDelta } from '../types.js';
import { ActionCategory } from '../types.js';
import type { SubstrateState } from '../types.js';
import { updateConstraints, computeHealth } from '../modules/substrate.js';
import type { ParcelState } from '../modules/parcel.js';
import { getParcel, computeParcelHealth, exportParcelSummaries } from '../modules/parcel.js';
import type { AgentState, ActionRequest, ActionResult } from '../modules/agent.js';
import { executeAction } from '../modules/agent.js';

// ─── Phase Enum ───────────────────────────────────────────────────────────────

export enum RoundPhase {
  Reading   = 'reading',    // Observe current world state
  Execution = 'execution',  // Submit and resolve actions
  Reckoning = 'reckoning',  // Score outcomes, update state
}

// ─── Round State ─────────────────────────────────────────────────────────────

export interface RoundState {
  roundNumber:  number;
  phase:        RoundPhase;
  actions:      ActionRequest[];
  results:      ActionResult[];
  startedAt:    number;
  completedAt?: number;
}

// ─── Reading Phase ────────────────────────────────────────────────────────────

export interface ReadingSnapshot {
  parcelHealth:       number;          // 0..1
  substrateHealth:    number;          // 0..1
  resourceSummary:    Record<string, number>;
  phase:              RoundPhase.Reading;
  roundNumber:        number;
  timestamp:          number;
}

/**
 * Phase 1: Reading.
 * Produce a snapshot of current world state for the agent to observe.
 * No state mutation.
 */
export function beginReading(
  ss: SubstrateState,
  ps: ParcelState,
  parcelId: string,
  roundNumber: number,
  now?: number,
): ReadingSnapshot {
  const parcel = getParcel(ps, parcelId);
  if (!parcel) throw new Error(`Parcel ${parcelId} not found`);

  const cell = ss.cells.get(parcelId);
  const substrateHealth = cell ? computeHealth(cell.constraints) : 0;

  return {
    parcelHealth:    computeParcelHealth(parcel.resources),
    substrateHealth,
    resourceSummary: { ...parcel.resources },
    phase:           RoundPhase.Reading,
    roundNumber,
    timestamp:       now ?? Date.now(),
  };
}

// ─── Execution Phase ──────────────────────────────────────────────────────────

export interface ExecutionResult {
  results:         ActionResult[];
  newAgentState:   AgentState;
  newParcelState:  ParcelState;
  /** Accumulated constraint deltas to apply to SubstrateState after execution. */
  constraintAccumulator: ConstraintDelta;
}

/**
 * Phase 2: Execution.
 * Process a batch of ActionRequests in order.
 * Constraint deltas are accumulated so the caller can apply them to SubstrateState.
 *
 * NOTE: Substrate update is the caller's responsibility — keeping module boundaries clean.
 */
export function executeRound(
  as: AgentState,
  ps: ParcelState,
  actions: ActionRequest[],
): ExecutionResult {
  let currentAs = as;
  let currentPs = ps;
  const results: ActionResult[] = [];
  const acc: ConstraintDelta = {};

  for (const req of actions) {
    const { newAgentState, newParcelState, result } = executeAction(currentAs, currentPs, req);
    currentAs = newAgentState;
    currentPs = newParcelState;
    results.push(result);

    // Accumulate constraint deltas (sum)
    for (const [k, v] of Object.entries(result.constraintDelta) as [keyof ConstraintDelta, number][]) {
      acc[k] = (acc[k] ?? 0) + v;
    }
  }

  return {
    results,
    newAgentState:         currentAs,
    newParcelState:        currentPs,
    constraintAccumulator: acc,
  };
}

// ─── Reckoning Phase ──────────────────────────────────────────────────────────

export interface ReckoningScore {
  roundNumber:          number;
  parcelHealthBefore:   number;
  parcelHealthAfter:    number;
  healthDelta:          number;
  extractionScore:      number;   // sum of productive action intensities (lower is better for ecology)
  restorationScore:     number;   // sum of regenerative action intensities
  /** Net valence across all trust signals. Positive = prosocial. */
  netTrustValence:      number;
  /** Simple verdict for the demo. */
  verdict:              'thriving' | 'stable' | 'declining';
  phase:                RoundPhase.Reckoning;
  timestamp:            number;
}

/**
 * Phase 3: Reckoning.
 * Score the round: what happened to the parcel, how extractive vs. restorative was play?
 */
export function reckonRound(
  parcelId: string,
  psBeforeExecution: ParcelState,
  psAfterExecution:  ParcelState,
  results:           ActionResult[],
  roundNumber:       number,
  now?: number,
): ReckoningScore {
  const parcelBefore = getParcel(psBeforeExecution, parcelId);
  const parcelAfter  = getParcel(psAfterExecution,  parcelId);

  if (!parcelBefore || !parcelAfter) throw new Error(`Parcel ${parcelId} not found`);

  const healthBefore = computeParcelHealth(parcelBefore.resources);
  const healthAfter  = computeParcelHealth(parcelAfter.resources);
  const healthDelta  = healthAfter - healthBefore;

  let extractionScore  = 0;
  let restorationScore = 0;
  let netTrustValence  = 0;

  for (const r of results) {
    if (r.category === ActionCategory.Productive)   extractionScore  += r.trustSignal.intensity;
    if (r.category === ActionCategory.Regenerative) restorationScore += r.trustSignal.intensity;
    netTrustValence += r.trustSignal.valence;
  }

  const verdict: ReckoningScore['verdict'] =
    healthDelta > 0.02 ? 'thriving' :
    healthDelta < -0.02 ? 'declining' :
    'stable';

  return {
    roundNumber,
    parcelHealthBefore:  healthBefore,
    parcelHealthAfter:   healthAfter,
    healthDelta,
    extractionScore,
    restorationScore,
    netTrustValence,
    verdict,
    phase:               RoundPhase.Reckoning,
    timestamp:           now ?? Date.now(),
  };
}

// ─── Full Round Helper ────────────────────────────────────────────────────────

/**
 * Run a complete Reading → Execution → Reckoning round.
 * Returns all intermediate artifacts for the demo output.
 *
 * The caller must apply ss = updateConstraints(ss, parcelId, execution.constraintAccumulator)
 * after this call to propagate substrate effects.
 */
export function runRound(opts: {
  ss: SubstrateState;
  as: AgentState;
  ps: ParcelState;
  parcelId: string;
  actions: ActionRequest[];
  roundNumber: number;
  now?: number;
}): {
  reading:   ReadingSnapshot;
  execution: ExecutionResult;
  reckoning: ReckoningScore;
} {
  const ts = opts.now ?? Date.now();

  const reading   = beginReading(opts.ss, opts.ps, opts.parcelId, opts.roundNumber, ts);
  const execution = executeRound(opts.as, opts.ps, opts.actions);
  const reckoning = reckonRound(
    opts.parcelId,
    opts.ps,
    execution.newParcelState,
    execution.results,
    opts.roundNumber,
    ts + 1,
  );

  return { reading, execution, reckoning };
}
