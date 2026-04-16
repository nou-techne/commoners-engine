/**
 * Commoners Engine — M6: Season (Full — Round Structure and Temporal Rhythm)
 * One Season consists of N Rounds. Each Round has five phases:
 *   Reading → Proposing → Negotiation → Execution → Reckoning
 *
 * The minimal three-phase version (P467 rehearsal) lives in season.ts.
 * This module extends it to the full five-phase protocol and adds Season
 * scoring across the five flourishing archetypes + Dust collapse condition.
 *
 * Sprint: P464
 */

import type { SubstrateState } from '../types.js';
import type { ParcelState } from './parcel.js';
import type { AgentState, ActionRequest, ActionResult } from './agent.js';
import type { BasinState } from './basin.js';
import type { GovernanceState } from './governance.js';
import {
  beginReading,
  executeRound,
  reckonRound,
  type ReadingSnapshot,
  type ExecutionResult,
  type ReckoningScore,
} from './season.js';
import {
  computeBasinHealth,
  exportBasinSnapshot,
  type BasinSnapshot,
} from './basin.js';
import {
  listProposalsByStatus,
  ProposalStatus,
} from './governance.js';
import { exportParcelSummaries } from './parcel.js';

// ─── Phase Enum (full five phases) ───────────────────────────────────────────

export enum PhaseType {
  Reading     = 'reading',
  Proposing   = 'proposing',
  Negotiation = 'negotiation',
  Execution   = 'execution',
  Reckoning   = 'reckoning',
}

export const PHASE_ORDER: PhaseType[] = [
  PhaseType.Reading,
  PhaseType.Proposing,
  PhaseType.Negotiation,
  PhaseType.Execution,
  PhaseType.Reckoning,
];

// ─── Flourishing Archetypes ───────────────────────────────────────────────────

export enum FlourishingArchetype {
  Orchard    = 'orchard',    // high yield + low externality
  Confluence = 'confluence', // high inter-agent coordination
  Archive    = 'archive',    // knowledge/information density
  Workshop   = 'workshop',   // infrastructure investment
  Hearth     = 'hearth',     // relational density
}

export const COLLAPSE_ARCHETYPE = 'dust' as const;  // basin degraded beyond recovery

// ─── Scoring ──────────────────────────────────────────────────────────────────

export interface ArchetypeScore {
  archetype:  FlourishingArchetype | typeof COLLAPSE_ARCHETYPE;
  score:      number;  // 0..1
  dominant:   boolean; // highest score this season
}

export interface SeasonScore {
  scores:     ArchetypeScore[];
  outcome:    FlourishingArchetype | typeof COLLAPSE_ARCHETYPE;
  /** The Dust threshold for collapse. */
  collapsed:  boolean;
}

/**
 * Compute archetype scores at the end of a Season.
 * Each archetype maps to observable state conditions.
 */
export function scoreArchetypes(
  bs: BasinState,
  ps: ParcelState,
  gs: GovernanceState,
  basinId: string,
  allReckonings: ReckoningScore[],
): SeasonScore {
  // ── Orchard: high resource yield with low externality ──
  const avgHealthAfter = allReckonings.reduce((sum, r) => sum + r.parcelHealthAfter, 0)
    / Math.max(1, allReckonings.length);
  const totalExtraction = allReckonings.reduce((sum, r) => sum + r.extractionScore, 0);
  const totalRestoration = allReckonings.reduce((sum, r) => sum + r.restorationScore, 0);
  const orchardScore = avgHealthAfter * (1 - Math.min(1, totalExtraction / (totalRestoration + 1)));

  // ── Confluence: governance participation (passed proposals as fraction of submitted) ──
  const allProposals = Array.from(gs.proposals.values());
  const passedCount = allProposals.filter(p => p.status === ProposalStatus.Passed).length;
  const confluenceScore = allProposals.length > 0 ? passedCount / allProposals.length : 0;

  // ── Archive: informational action density as fraction of total actions ──
  const allResults = allReckonings.flatMap(r => (r as any)._results ?? []) as ActionResult[];
  // If results aren't embedded in ReckoningScore, fall back to a proxy via trust valence variance
  // (higher informational play correlates with lower variance / more stable outcomes)
  const archiveScore = allReckonings.length > 0
    ? Math.min(1, Math.abs(allReckonings[allReckonings.length - 1].netTrustValence) * 0.3)
    : 0;

  // ── Workshop: positive constraint delta (infrastructure build-up) ──
  // Proxy: basin commons health relative to starting health
  const snap = exportBasinSnapshot(bs, ps, basinId);
  const workshopScore = snap.health * 0.8;

  // ── Hearth: number of unique collaborators per round ──
  // We don't track collaborators in reckoning currently; proxy via net trust valence
  const hearthScore = allReckonings.reduce((sum, r) =>
    sum + Math.max(0, r.netTrustValence) / Math.max(1, allReckonings.length), 0
  );

  // ── Dust: collapse condition ──
  const basinHealth = computeBasinHealth(bs, ps, basinId);
  const collapsed = basinHealth < 0.15 || snap.stressed;

  const raw: { archetype: FlourishingArchetype | typeof COLLAPSE_ARCHETYPE; score: number }[] = [
    { archetype: FlourishingArchetype.Orchard,    score: orchardScore    },
    { archetype: FlourishingArchetype.Confluence, score: confluenceScore },
    { archetype: FlourishingArchetype.Archive,    score: archiveScore    },
    { archetype: FlourishingArchetype.Workshop,   score: workshopScore   },
    { archetype: FlourishingArchetype.Hearth,     score: hearthScore     },
  ];

  if (collapsed) {
    raw.push({ archetype: COLLAPSE_ARCHETYPE, score: 1.0 });
  }

  const maxScore = Math.max(...raw.map(r => r.score));
  const scores: ArchetypeScore[] = raw.map(r => ({
    ...r,
    dominant: r.score === maxScore,
  }));

  const outcome = collapsed
    ? COLLAPSE_ARCHETYPE
    : (scores.find(s => s.dominant)!.archetype);

  return { scores, outcome, collapsed };
}

// ─── Round State (full) ───────────────────────────────────────────────────────

export interface RoundPhaseRecord {
  phase:     PhaseType;
  startedAt: number;
  endedAt?:  number;
}

export interface FullRoundState {
  roundNumber:   number;
  phases:        RoundPhaseRecord[];
  currentPhase:  PhaseType;
  /** Actions queued during Proposing, executed in Execution. */
  queuedActions: ActionRequest[];
  /** Governance proposals submitted this round (IDs). */
  proposalIds:   string[];
  reading?:      ReadingSnapshot;
  execution?:    ExecutionResult;
  reckoning?:    ReckoningScore;
  completedAt?:  number;
}

// ─── Season State ─────────────────────────────────────────────────────────────

export enum SeasonStatus {
  Setup    = 'setup',
  Running  = 'running',
  Complete = 'complete',
  Collapse = 'collapse',
}

export interface SeasonState {
  seasonId:      string;
  basinId:       string;
  status:        SeasonStatus;
  roundCount:    number;   // total rounds planned
  currentRound:  number;   // 1-indexed, 0 = not started
  rounds:        FullRoundState[];
  seasonScore?:  SeasonScore;
  startedAt:     number;
  completedAt?:  number;
}

export interface SeasonStore {
  seasons: Map<string, SeasonState>;
}

export function initSeasonStore(): SeasonStore {
  return { seasons: new Map() };
}

// ─── Season Lifecycle ─────────────────────────────────────────────────────────

export function createSeason(
  store: SeasonStore,
  seasonId: string,
  basinId: string,
  roundCount: number,
  now?: number,
): SeasonStore {
  if (store.seasons.has(seasonId)) {
    throw new Error(`Season ${seasonId} already exists`);
  }
  if (roundCount < 1) throw new Error('roundCount must be >= 1');

  const ts = now ?? Date.now();
  const season: SeasonState = {
    seasonId,
    basinId,
    status:       SeasonStatus.Setup,
    roundCount,
    currentRound: 0,
    rounds:       [],
    startedAt:    ts,
  };

  const newSeasons = new Map(store.seasons);
  newSeasons.set(seasonId, season);
  return { seasons: newSeasons };
}

/**
 * Advance a Season from Setup to Running and open Round 1.
 */
export function beginSeason(
  store: SeasonStore,
  seasonId: string,
  now?: number,
): SeasonStore {
  const season = requireSeason(store, seasonId);
  if (season.status !== SeasonStatus.Setup) {
    throw new Error(`Season ${seasonId} is already ${season.status}`);
  }

  const ts = now ?? Date.now();
  const firstRound: FullRoundState = {
    roundNumber:   1,
    phases:        [{ phase: PhaseType.Reading, startedAt: ts }],
    currentPhase:  PhaseType.Reading,
    queuedActions: [],
    proposalIds:   [],
  };

  const updated: SeasonState = {
    ...season,
    status:       SeasonStatus.Running,
    currentRound: 1,
    rounds:       [firstRound],
  };

  const newSeasons = new Map(store.seasons);
  newSeasons.set(seasonId, updated);
  return { seasons: newSeasons };
}

/**
 * Advance to the next phase within the current round.
 * If we're at Reckoning and there are more rounds, open the next round.
 * If we're at Reckoning on the last round, complete the season.
 */
export function advancePhase(
  store: SeasonStore,
  seasonId: string,
  ss: SubstrateState,
  as: AgentState,
  ps: ParcelState,
  bs: BasinState,
  gs: GovernanceState,
  parcelId: string,
  now?: number,
): {
  newStore:    SeasonStore;
  newAs:       AgentState;
  newPs:       ParcelState;
  newBs:       BasinState;
} {
  const season = requireSeason(store, seasonId);
  if (season.status !== SeasonStatus.Running) {
    throw new Error(`Season ${seasonId} is not running`);
  }

  const ts = now ?? Date.now();
  const roundIdx = season.currentRound - 1;
  const round = season.rounds[roundIdx];
  const phaseIdx = PHASE_ORDER.indexOf(round.currentPhase);
  const nextPhase: PhaseType | undefined = PHASE_ORDER[phaseIdx + 1];

  let newAs = as;
  let newPs = ps;
  let newBs = bs;
  let updatedRound: FullRoundState;

  // Close current phase
  const closedPhases = round.phases.map((p, i) =>
    i === round.phases.length - 1 ? { ...p, endedAt: ts } : p
  );

  if (!nextPhase) {
    // We're past Reckoning — shouldn't normally happen
    throw new Error('Already past Reckoning');
  }

  if (nextPhase === PhaseType.Execution) {
    // Actually run the execution phase
    const result = executeRound(as, ps, round.queuedActions);
    newAs = result.newAgentState;
    newPs = result.newParcelState;
    // Caller propagates constraintAccumulator to SubstrateState

    updatedRound = {
      ...round,
      phases:       [...closedPhases, { phase: PhaseType.Execution, startedAt: ts }],
      currentPhase: PhaseType.Execution,
      execution:    result,
    };
  } else if (nextPhase === PhaseType.Reckoning) {
    // Run reckoning
    const exec = round.execution;
    if (!exec) throw new Error('Cannot reckon without execution results');

    const reckoning = reckonRound(
      parcelId,
      ps,              // state before this round's execution
      exec.newParcelState,
      exec.results,
      round.roundNumber,
      ts,
    );

    // Check for Dust collapse
    const basinHealth = computeBasinHealth(bs, ps, season.basinId);
    const collapsed = basinHealth < 0.15;

    updatedRound = {
      ...round,
      phases:       [...closedPhases, { phase: PhaseType.Reckoning, startedAt: ts }],
      currentPhase: PhaseType.Reckoning,
      reckoning,
      completedAt:  ts,
    };

    const updatedRounds = [...season.rounds];
    updatedRounds[roundIdx] = updatedRound;

    if (collapsed || season.currentRound >= season.roundCount) {
      // Season ends
      const allReckonings = updatedRounds
        .map(r => r.reckoning)
        .filter((r): r is ReckoningScore => !!r);

      const seasonScore = scoreArchetypes(bs, exec.newParcelState, gs, season.basinId, allReckonings);
      const newStatus: SeasonStatus = collapsed ? SeasonStatus.Collapse : SeasonStatus.Complete;

      const newSeasons = new Map(store.seasons);
      newSeasons.set(seasonId, {
        ...season,
        status:       newStatus,
        rounds:       updatedRounds,
        seasonScore,
        completedAt:  ts,
      });
      return { newStore: { seasons: newSeasons }, newAs, newPs, newBs };
    }

    // Open next round
    const nextRound: FullRoundState = {
      roundNumber:   season.currentRound + 1,
      phases:        [{ phase: PhaseType.Reading, startedAt: ts + 1 }],
      currentPhase:  PhaseType.Reading,
      queuedActions: [],
      proposalIds:   [],
    };

    const newSeasons = new Map(store.seasons);
    newSeasons.set(seasonId, {
      ...season,
      currentRound: season.currentRound + 1,
      rounds:       [...updatedRounds, nextRound],
    });
    return { newStore: { seasons: newSeasons }, newAs, newPs, newBs };
  } else {
    // Simple phase advance (Reading→Proposing, Proposing→Negotiation, Negotiation→Execution)
    updatedRound = {
      ...round,
      phases:       [...closedPhases, { phase: nextPhase, startedAt: ts }],
      currentPhase: nextPhase,
    };
  }

  const updatedRounds = [...season.rounds];
  updatedRounds[roundIdx] = updatedRound;

  const newSeasons = new Map(store.seasons);
  newSeasons.set(seasonId, { ...season, rounds: updatedRounds });
  return { newStore: { seasons: newSeasons }, newAs, newPs, newBs };
}

/**
 * Queue an action request during the Proposing phase.
 */
export function queueAction(
  store: SeasonStore,
  seasonId: string,
  req: ActionRequest,
): SeasonStore {
  const season = requireSeason(store, seasonId);
  const round = season.rounds[season.currentRound - 1];
  if (round.currentPhase !== PhaseType.Proposing) {
    throw new Error(`queueAction requires Proposing phase; current phase is ${round.currentPhase}`);
  }

  const updatedRound: FullRoundState = {
    ...round,
    queuedActions: [...round.queuedActions, req],
  };

  const updatedRounds = [...season.rounds];
  updatedRounds[season.currentRound - 1] = updatedRound;

  const newSeasons = new Map(store.seasons);
  newSeasons.set(seasonId, { ...season, rounds: updatedRounds });
  return { seasons: newSeasons };
}

/**
 * Note a governance proposal submitted during Proposing/Negotiation phase.
 */
export function noteProposal(
  store: SeasonStore,
  seasonId: string,
  proposalId: string,
): SeasonStore {
  const season = requireSeason(store, seasonId);
  const round = season.rounds[season.currentRound - 1];

  const updatedRound: FullRoundState = {
    ...round,
    proposalIds: [...round.proposalIds, proposalId],
  };

  const updatedRounds = [...season.rounds];
  updatedRounds[season.currentRound - 1] = updatedRound;

  const newSeasons = new Map(store.seasons);
  newSeasons.set(seasonId, { ...season, rounds: updatedRounds });
  return { seasons: newSeasons };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function getSeason(store: SeasonStore, seasonId: string): SeasonState | undefined {
  return store.seasons.get(seasonId);
}

export function getCurrentRound(store: SeasonStore, seasonId: string): FullRoundState | undefined {
  const season = store.seasons.get(seasonId);
  if (!season || season.currentRound === 0) return undefined;
  return season.rounds[season.currentRound - 1];
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function requireSeason(store: SeasonStore, seasonId: string): SeasonState {
  const s = store.seasons.get(seasonId);
  if (!s) throw new Error(`Season ${seasonId} not found`);
  return s;
}
