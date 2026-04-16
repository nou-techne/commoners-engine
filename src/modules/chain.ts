/**
 * Commoners Engine — M8: Chain + Spectator
 *
 * Two responsibilities:
 *
 * 1. ATTESTATION BRIDGE — At season end, governance outcome attestations are
 *    serialised into an onchain record (merkle root + season summary) and
 *    prepared as an unsigned EIP-1559 transaction ready for the OpenClaw signing
 *    host. Actual signing and broadcast require the private key held by the
 *    OpenClaw host; this module produces only the unsigned calldata.
 *
 * 2. SPECTATOR LAYER — A deterministic, public snapshot of current game state
 *    requiring no authentication. Designed for Agent Olympiad livestream and
 *    public basin-health dashboards.
 *
 * Onchain minimum viable record:
 *   season_id       (bytes32)
 *   basin_id        (bytes32)
 *   outcome_hash    (bytes32 — merkle root over governance attestation dataHashes)
 *   dominant_archetype (uint8 — 0=Orchard…4=Hearth, 255=Dust)
 *   collapse_flag   (bool)
 *
 * Techne wallet: 0xC37604A1dD79Ed50A5c2943358db85CB743dd3e2 (Base mainnet)
 * ERC-8004 Agent ID: 2202
 * Signing: OpenClaw host required — this module prepares tx, does NOT sign.
 *
 * Sprint: P466
 */

import { keccak256, encodePacked, encodeAbiParameters, parseAbiParameters } from 'viem';
import type { ParcelState } from './parcel.js';
import type { BasinState } from './basin.js';
import type { GovernanceState } from './governance.js';
import type { TrustState } from './trust.js';
import {
  computeBasinHealth,
  exportBasinSnapshot,
} from './basin.js';
import {
  listReputationRecords,
  getVoteWeightMultiplier,
  getVisibilityTier,
} from './trust.js';
import type { Attestation } from './governance.js';
import type { SeasonState } from './season-full.js';
import { FlourishingArchetype, COLLAPSE_ARCHETYPE } from './season-full.js';

// ─── Merkle Tree ──────────────────────────────────────────────────────────────

/**
 * Compute a binary keccak256 merkle root over an ordered list of leaf values.
 * Leaves are already 32-byte hex strings (e.g. attestation dataHashes).
 * If the list is empty, returns the keccak256 of an empty bytes string.
 * Odd-length layers duplicate the last leaf (standard practice).
 */
export function computeMerkleRoot(leaves: string[]): `0x${string}` {
  if (leaves.length === 0) {
    return keccak256(encodePacked(['bytes'], ['0x']));
  }

  let layer: string[] = leaves.map(l =>
    l.startsWith('0x') ? l : `0x${l}`
  );

  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left  = layer[i] as `0x${string}`;
      const right = (layer[i + 1] ?? layer[i]) as `0x${string}`;
      // Sort pair to make tree deterministic regardless of leaf order
      const [a, b] = left <= right ? [left, right] : [right, left];
      next.push(keccak256(encodePacked(['bytes32', 'bytes32'], [a, b])));
    }
    layer = next;
  }

  return layer[0] as `0x${string}`;
}

// ─── Archetype → uint8 mapping ────────────────────────────────────────────────

/** Maps FlourishingArchetype (and COLLAPSE_ARCHETYPE) to onchain uint8. */
export const ARCHETYPE_INDEX: Record<FlourishingArchetype | typeof COLLAPSE_ARCHETYPE, number> = {
  [FlourishingArchetype.Orchard]:    0,
  [FlourishingArchetype.Confluence]: 1,
  [FlourishingArchetype.Archive]:    2,
  [FlourishingArchetype.Workshop]:   3,
  [FlourishingArchetype.Hearth]:     4,
  [COLLAPSE_ARCHETYPE]:              255,
};

// ─── Onchain Record ───────────────────────────────────────────────────────────

export interface OnchainRecord {
  /** Season identifier, padded to bytes32 */
  seasonId:          string;
  /** Basin identifier, padded to bytes32 */
  basinId:           string;
  /** Merkle root of all governance attestation dataHashes this season */
  outcomeHash:       `0x${string}`;
  /** Dominant archetype as uint8 (0–4, or 255 for Dust/collapse) */
  dominantArchetype: number;
  /** True when basin health fell below collapse threshold */
  collapseFlag:      boolean;
  /** Unix timestamp (seconds) of season completion */
  completedAt:       number;
}

/**
 * Build the onchain record for a completed season.
 */
export function buildOnchainRecord(
  season: SeasonState,
  attestations: Attestation[],
): OnchainRecord {
  if (!season.seasonScore) {
    throw new Error(`Season ${season.seasonId} has no score — has it been completed?`);
  }

  const leaves  = attestations.map(a => a.dataHash);
  const merkleRoot = computeMerkleRoot(leaves);
  const outcome = season.seasonScore.outcome;

  return {
    seasonId:          season.seasonId,
    basinId:           season.basinId,
    outcomeHash:       merkleRoot,
    dominantArchetype: ARCHETYPE_INDEX[outcome],
    collapseFlag:      season.seasonScore.collapsed,
    completedAt:       Math.trunc((season.completedAt ?? Date.now()) / 1000),
  };
}

// ─── ABI Encoding ─────────────────────────────────────────────────────────────

/**
 * ABI-encode the onchain record for calldata construction.
 * Encodes as: (bytes32, bytes32, bytes32, uint8, bool, uint256)
 */
export function encodeOnchainRecord(record: OnchainRecord): `0x${string}` {
  const padId = (s: string): `0x${string}` => {
    const hex = Buffer.from(s, 'utf8').toString('hex').padEnd(64, '0');
    return `0x${hex}` as `0x${string}`;
  };

  return encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, bytes32, uint8, bool, uint256'),
    [
      padId(record.seasonId),
      padId(record.basinId),
      record.outcomeHash as `0x${string}`,
      record.dominantArchetype,
      record.collapseFlag,
      BigInt(record.completedAt),
    ],
  );
}

// ─── Chain Submission (Unsigned) ──────────────────────────────────────────────

/**
 * The Techne wallet address used for Base mainnet submissions.
 * Signing requires the OpenClaw host — this module prepares only the calldata.
 */
export const TECHNE_WALLET = '0xC37604A1dD79Ed50A5c2943358db85CB743dd3e2' as const;

/**
 * Base mainnet chain ID.
 */
export const BASE_CHAIN_ID = 8453;

export interface ChainSubmission {
  /** Prepared unsigned transaction object */
  tx: {
    chainId:  number;
    from:     string;
    /** Target contract address — null means this is ETH-calldata to a log contract */
    to:       string | null;
    value:    bigint;
    data:     `0x${string}`;
    /** Suggested max fee per gas (1 gwei baseline for Base) */
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  };
  /** Human-readable summary for the signing host */
  summary: string;
  /** Season record embedded for verification */
  record:  OnchainRecord;
}

/**
 * Prepare an unsigned Base transaction containing the encoded season record.
 * The transaction stores the calldata in an ETH transfer to Techne wallet
 * (data-bearing zero-value tx) — a simple on-chain log pattern that costs
 * minimal gas. No contract deployment required.
 *
 * To submit: pass `tx` to the OpenClaw signing host for signature + broadcast.
 */
export function prepareChainSubmission(record: OnchainRecord): ChainSubmission {
  const calldata = encodeOnchainRecord(record);

  return {
    tx: {
      chainId:             BASE_CHAIN_ID,
      from:                TECHNE_WALLET,
      to:                  TECHNE_WALLET,   // self-send with data (cheap on-chain log)
      value:               BigInt(0),
      data:                calldata,
      maxFeePerGas:        BigInt(1_000_000_000),  // 1 gwei
      maxPriorityFeePerGas: BigInt(100_000_000),   // 0.1 gwei
    },
    summary: [
      `Season ${record.seasonId} | Basin ${record.basinId}`,
      `Outcome: ${record.collapseFlag ? 'COLLAPSE (Dust)' : `archetype ${record.dominantArchetype}`}`,
      `MerkleRoot: ${record.outcomeHash.slice(0, 18)}…`,
      `CompletedAt: ${new Date(record.completedAt * 1000).toISOString()}`,
    ].join(' | '),
    record,
  };
}

// ─── Spectator View ───────────────────────────────────────────────────────────

export interface AgentSpectatorEntry {
  agentId:            string;
  treatmentBand:      number;
  externalityScore:   number;
  coordinationScore:  number;
  voteWeightMultiplier: number;
  visibilityTier:     string;
}

export interface SpectatorView {
  /** ISO timestamp of snapshot generation */
  snapshotAt:          string;
  /** Current basin health [0, 1] */
  basinHealth:         number;
  /** Whether basin is under stress */
  basinStressed:       boolean;
  /** Top agents by reputation (best band first, then by externality_score desc) */
  agentLeaderboard:    AgentSpectatorEntry[];
  /** Current season status */
  seasonStatus:        string;
  /** Current round number (0 = not started) */
  currentRound:        number;
  /** Current phase within the active round */
  currentPhase:        string;
  /** Season archetype score distribution (if scored) */
  archetypeScores:     { archetype: string; score: number; dominant: boolean }[];
  /** Dominant archetype or 'dust' */
  seasonOutcome:       string | null;
}

/**
 * Build a deterministic public spectator snapshot.
 * Requires no authentication — safe for public display.
 * Only agents with visibility tier ≠ 'flagged' appear in the leaderboard.
 */
export function buildSpectatorView(
  bs: BasinState,
  ps: ParcelState,
  ts: TrustState,
  season: SeasonState,
  now?: number,
): SpectatorView {
  const t = now ?? Date.now();

  // Basin health
  const basinHealth = computeBasinHealth(bs, ps, season.basinId);
  const snap        = exportBasinSnapshot(bs, ps, season.basinId);

  // Agent leaderboard (exclude flagged agents)
  const allRecs = listReputationRecords(ts);
  const visible = allRecs
    .filter(r => getVisibilityTier(r.treatment_band) !== 'flagged')
    .sort((a, b) => {
      if (a.treatment_band !== b.treatment_band) return a.treatment_band - b.treatment_band;
      return b.externality_score - a.externality_score;
    });

  const agentLeaderboard: AgentSpectatorEntry[] = visible.map(r => ({
    agentId:             r.agentId,
    treatmentBand:       r.treatment_band,
    externalityScore:    r.externality_score,
    coordinationScore:   r.coordination_score,
    voteWeightMultiplier: getVoteWeightMultiplier(r.treatment_band),
    visibilityTier:      getVisibilityTier(r.treatment_band),
  }));

  // Current round/phase
  const currentRound = season.currentRound;
  const currentPhase = currentRound > 0
    ? (season.rounds[currentRound - 1]?.currentPhase ?? 'unknown')
    : 'not_started';

  // Archetype distribution
  const archetypeScores = season.seasonScore?.scores.map(s => ({
    archetype: s.archetype,
    score:     s.score,
    dominant:  s.dominant,
  })) ?? [];

  return {
    snapshotAt:       new Date(t).toISOString(),
    basinHealth,
    basinStressed:    snap.stressed,
    agentLeaderboard,
    seasonStatus:     season.status,
    currentRound,
    currentPhase,
    archetypeScores,
    seasonOutcome:    season.seasonScore?.outcome ?? null,
  };
}
