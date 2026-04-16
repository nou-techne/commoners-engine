/**
 * Commoners Engine — M7: Trust / Reputation (Graduated Trust Integration)
 *
 * Reputation is a two-axis projection drawn from the Graduated Trust framework:
 *
 *   externality_score  ∈ [-1, +1]  — extractive (−) ↔ restorative (+)
 *   coordination_score ∈ [-1, +1]  — defector   (−) ↔ cooperator  (+)
 *
 * The two axes form a 7×7 grid (49 cells). Each cell maps to a treatment_band
 * (1 = highest trust / most access, 7 = lowest trust / most restricted).
 *
 * Treatment band controls:
 *   - vote weight multiplier (fed back into M5 governance)
 *   - action category access (bands 5-7 lose Governing/Relational access)
 *   - spectator visibility tier
 *
 * Restorative path: agents accumulate a restorative action count across rounds;
 * once the count crosses RESTORATION_THRESHOLD the band improves by 1.
 *
 * Between seasons, scores undergo a partial reset (decay 50% toward neutral 0).
 *
 * Sprint: P465
 */

import { ActionCategory } from '../types.js';
import type { TrustSignal } from './agent.js';

// ─── Treatment Band ──────────────────────────────────────────────────────────

/**
 * Numeric treatment bands 1–7.
 * 1 = best access (high trust, cooperative steward)
 * 7 = most restricted (low trust, defective actor)
 */
export enum TreatmentBand {
  B1 = 1,
  B2 = 2,
  B3 = 3,
  B4 = 4,
  B5 = 5,
  B6 = 6,
  B7 = 7,
}

/** Number of trust axis cells per dimension (7 × 7 = 49 total). */
export const TRUST_GRID_SIZE = 7;

/** Learning rate: fraction of each trust signal absorbed per event. */
export const TRUST_LEARNING_RATE = 0.12;

/**
 * Coordination delta per action category.
 * Added to coordination_score on every action execution.
 */
export const COORDINATION_DELTA: Record<ActionCategory, number> = {
  [ActionCategory.Relational]:      +0.40,  // highest cooperative signal
  [ActionCategory.Governing]:       +0.30,  // participation in shared governance
  [ActionCategory.Succession]:      +0.30,  // commons transfer — cooperative
  [ActionCategory.Regenerative]:    +0.10,  // working with the commons
  [ActionCategory.Infrastructural]: +0.15,  // building shared capacity
  [ActionCategory.Informational]:   +0.10,  // sharing knowledge
  [ActionCategory.Productive]:     -0.15,  // unilateral extraction = coordination cost
};

/**
 * After this many accumulated restorative actions (Regenerative + Governing),
 * an agent in bands 5–7 receives an automatic band improvement by 1.
 */
export const RESTORATION_THRESHOLD = 5;

/** Partial season-reset decay factor: scores multiply by this between seasons. */
export const SEASON_DECAY = 0.5;

// ─── Effect Tables ────────────────────────────────────────────────────────────

/** Vote weight multipliers per treatment band. */
export const VOTE_WEIGHT_MULTIPLIER: Record<TreatmentBand, number> = {
  [TreatmentBand.B1]: 1.50,
  [TreatmentBand.B2]: 1.25,
  [TreatmentBand.B3]: 1.00,
  [TreatmentBand.B4]: 0.75,
  [TreatmentBand.B5]: 0.50,
  [TreatmentBand.B6]: 0.25,
  [TreatmentBand.B7]: 0.10,
};

/**
 * Action categories that are gated by trust band.
 * Lower-trust agents (bands 5-7) cannot access these categories.
 */
export const GATED_CATEGORIES: Set<ActionCategory> = new Set([
  ActionCategory.Governing,
  ActionCategory.Relational,
  ActionCategory.Succession,
]);

/** Minimum band required to perform gated action categories (inclusive). */
export const ACTION_GATE_THRESHOLD: TreatmentBand = TreatmentBand.B4;

// ─── Data Model ───────────────────────────────────────────────────────────────

export interface RoundTrustSummary {
  roundNumber:          number;
  signalCount:          number;
  externalityDelta:     number;
  coordinationDelta:    number;
  bandBefore:           TreatmentBand;
  bandAfter:            TreatmentBand;
}

export interface ReputationRecord {
  agentId:                string;
  /** -1 (extractive) ↔ +1 (restorative). */
  externality_score:      number;
  /** -1 (defector) ↔ +1 (cooperator). */
  coordination_score:     number;
  treatment_band:         TreatmentBand;
  round_history:          RoundTrustSummary[];
  /** Cumulative count of restorative actions for the restorative path. */
  restorative_action_count: number;
  /** The band at the start of the current season (for partial reset tracking). */
  season_start_band:      TreatmentBand;
  updatedAt:              number;
}

export interface TrustState {
  records: Map<string, ReputationRecord>;
}

export function initTrustState(): TrustState {
  return { records: new Map() };
}

// ─── Band Computation ─────────────────────────────────────────────────────────

/**
 * Map a score ∈ [-1, +1] to a grid cell index 0..6.
 * Cell 0 = worst (score near -1), Cell 6 = best (score near +1).
 */
function scoreToCell(score: number): number {
  // Clamp to [-1, 1], then map to [0, 6]
  const clamped = Math.max(-1, Math.min(1, score));
  const idx = Math.floor((clamped + 1) * 3.5);  // [0, 7) → clamp to [0, 6]
  return Math.min(6, idx);
}

/**
 * Compute the treatment band from axis scores.
 * cell 6 = best, cell 0 = worst; combined best = band 1, combined worst = band 7.
 */
export function getTreatmentBand(
  externality_score: number,
  coordination_score: number,
): TreatmentBand {
  const eCell = scoreToCell(externality_score);
  const cCell = scoreToCell(coordination_score);
  // Average cell (0–6), then invert to get band (1–7)
  const avgCell = Math.floor((eCell + cCell) / 2);  // 0..6
  const band = (TRUST_GRID_SIZE - avgCell) as TreatmentBand;  // 7..1
  return Math.max(1, Math.min(7, band)) as TreatmentBand;
}

// ─── Record Lifecycle ─────────────────────────────────────────────────────────

/**
 * Register a new agent in the trust layer. Starting scores neutral (0, 0) → band 4.
 */
export function registerReputationRecord(
  ts: TrustState,
  agentId: string,
  now?: number,
): TrustState {
  if (ts.records.has(agentId)) {
    throw new Error(`Reputation record for ${agentId} already exists`);
  }

  const startBand = TreatmentBand.B4;  // neutral starting position
  const record: ReputationRecord = {
    agentId,
    externality_score:       0,
    coordination_score:      0,
    treatment_band:          startBand,
    round_history:           [],
    restorative_action_count: 0,
    season_start_band:       startBand,
    updatedAt:               now ?? Date.now(),
  };

  const newRecords = new Map(ts.records);
  newRecords.set(agentId, record);
  return { records: newRecords };
}

// ─── Trust Signal Application ─────────────────────────────────────────────────

/**
 * Apply a single TrustSignal to an agent's reputation record.
 * Returns the updated TrustState (immutable).
 */
export function applyTrustSignal(
  ts: TrustState,
  signal: TrustSignal,
  now?: number,
): TrustState {
  const record = ts.records.get(signal.agentId);
  if (!record) {
    // Auto-register unknown agents at neutral starting position
    const ts2 = registerReputationRecord(ts, signal.agentId, now);
    return applyTrustSignal(ts2, signal, now);
  }

  const t = now ?? Date.now();
  const lr = TRUST_LEARNING_RATE;

  // Externality: trust signal valence drives externality_score
  const extDelta = signal.valence * signal.intensity * lr;

  // Coordination: category posture drives coordination_score
  const rawCoordDelta = COORDINATION_DELTA[signal.category] ?? 0;
  const coordDelta = rawCoordDelta * signal.intensity * lr;

  const newExt   = clampScore(record.externality_score  + extDelta);
  const newCoord = clampScore(record.coordination_score + coordDelta);

  const bandBefore = record.treatment_band;
  const bandAfter  = getTreatmentBand(newExt, newCoord);

  // Track restorative actions for the restorative path
  const isRestorative =
    signal.category === ActionCategory.Regenerative ||
    signal.category === ActionCategory.Governing;
  const newRestCount = record.restorative_action_count + (isRestorative ? 1 : 0);

  // Restorative path: if agent is in bands 5-7 and has hit the threshold, improve by 1
  let finalBand = bandAfter;
  let finalRestCount = newRestCount;
  if (
    bandAfter >= TreatmentBand.B5 &&
    newRestCount >= RESTORATION_THRESHOLD
  ) {
    finalBand = Math.max(1, bandAfter - 1) as TreatmentBand;
    finalRestCount = 0;  // reset counter after improvement
  }

  const updated: ReputationRecord = {
    ...record,
    externality_score:       newExt,
    coordination_score:      newCoord,
    treatment_band:          finalBand,
    restorative_action_count: finalRestCount,
    updatedAt:               t,
  };

  const newRecords = new Map(ts.records);
  newRecords.set(signal.agentId, updated);
  return { records: newRecords };
}

/**
 * Apply all trust signals from a set of action results (e.g. from ExecutionResult.results).
 * Convenience wrapper around applyTrustSignal for batch post-round updates.
 */
export function reckonTrust(
  ts: TrustState,
  signals: TrustSignal[],
  roundNumber: number,
  now?: number,
): TrustState {
  let current = ts;
  const t = now ?? Date.now();

  // Snapshot per-agent state before the batch for round_history
  const snapshotBands = new Map<string, TreatmentBand>();
  for (const sig of signals) {
    if (!snapshotBands.has(sig.agentId)) {
      const rec = current.records.get(sig.agentId);
      snapshotBands.set(sig.agentId, rec?.treatment_band ?? TreatmentBand.B4);
    }
  }

  // Apply all signals
  for (const signal of signals) {
    current = applyTrustSignal(current, signal, t);
  }

  // Append round_history summaries per agent
  const agentSignals = new Map<string, TrustSignal[]>();
  for (const sig of signals) {
    const arr = agentSignals.get(sig.agentId) ?? [];
    arr.push(sig);
    agentSignals.set(sig.agentId, arr);
  }

  const newRecords = new Map(current.records);
  for (const [agentId, sigs] of agentSignals) {
    const rec = newRecords.get(agentId)!;
    const extDelta = sigs.reduce((s, sig) => s + sig.valence * sig.intensity * TRUST_LEARNING_RATE, 0);
    const coordDelta = sigs.reduce((s, sig) => s + (COORDINATION_DELTA[sig.category] ?? 0) * sig.intensity * TRUST_LEARNING_RATE, 0);
    const summary: RoundTrustSummary = {
      roundNumber,
      signalCount:       sigs.length,
      externalityDelta:  extDelta,
      coordinationDelta: coordDelta,
      bandBefore:        snapshotBands.get(agentId)!,
      bandAfter:         rec.treatment_band,
    };
    newRecords.set(agentId, {
      ...rec,
      round_history: [...rec.round_history, summary],
    });
  }

  return { records: newRecords };
}

// ─── Season Reset ─────────────────────────────────────────────────────────────

/**
 * Partial reset of reputation scores between seasons.
 * Scores decay 50% toward neutral (0), preserving direction but reducing magnitude.
 * This allows new-season redemption without erasing history entirely.
 */
export function partialSeasonReset(
  ts: TrustState,
  agentId: string,
  now?: number,
): TrustState {
  const record = ts.records.get(agentId);
  if (!record) throw new Error(`No reputation record for ${agentId}`);

  const t = now ?? Date.now();
  const newExt   = record.externality_score  * SEASON_DECAY;
  const newCoord = record.coordination_score * SEASON_DECAY;
  const newBand  = getTreatmentBand(newExt, newCoord);

  const updated: ReputationRecord = {
    ...record,
    externality_score:        newExt,
    coordination_score:       newCoord,
    treatment_band:           newBand,
    restorative_action_count: 0,
    season_start_band:        newBand,
    updatedAt:                t,
  };

  const newRecords = new Map(ts.records);
  newRecords.set(agentId, updated);
  return { records: newRecords };
}

// ─── Effect Functions ─────────────────────────────────────────────────────────

/**
 * Vote weight multiplier for this agent's current band.
 * Multiply the base computeVoteWeight (from M5) by this factor.
 */
export function getVoteWeightMultiplier(band: TreatmentBand): number {
  return VOTE_WEIGHT_MULTIPLIER[band];
}

/**
 * True if the agent is permitted to perform the given action category.
 * Bands 5-7 cannot initiate Governing, Relational, or Succession actions.
 */
export function canPerformCategory(band: TreatmentBand, category: ActionCategory): boolean {
  if (!GATED_CATEGORIES.has(category)) return true;
  return band <= ACTION_GATE_THRESHOLD;
}

/**
 * Spectator visibility tier.
 * Bands 1-3: full visibility
 * Band 4: standard visibility
 * Bands 5-6: restricted (spectators see less detail)
 * Band 7: flagged (spectators see only aggregate signals)
 */
export type VisibilityTier = 'full' | 'standard' | 'restricted' | 'flagged';

export function getVisibilityTier(band: TreatmentBand): VisibilityTier {
  if (band <= TreatmentBand.B3) return 'full';
  if (band === TreatmentBand.B4) return 'standard';
  if (band <= TreatmentBand.B6) return 'restricted';
  return 'flagged';
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function getReputationRecord(
  ts: TrustState,
  agentId: string,
): ReputationRecord | undefined {
  return ts.records.get(agentId);
}

export function listReputationRecords(ts: TrustState): ReputationRecord[] {
  return Array.from(ts.records.values());
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampScore(v: number): number {
  return Math.max(-1, Math.min(1, v));
}
