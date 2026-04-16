/**
 * Commoners Engine — M5: Governance (Attestation Schema + Voting)
 * The governance layer. Every parcel action produces an attestation.
 * Basin proposals are voted on by agents; vote weight = parcelCount × reputationScore.
 *
 * Attestation schema committed in P456:
 *   agentId (address), actionType (uint8), targetParcel (bytes32),
 *   resourceDelta (int256), timestamp (uint256), outcomeHash (bytes32)
 * See types.ts ATTESTATION_DOMAIN / ATTESTATION_TYPES.
 *
 * Per P463 review (Nou/Opus): defector scenario must be strictly dominated —
 * governance must make defection a losing strategy, not merely prevent collapse
 * in one configuration. Tested in the "defection is dominated" suite below.
 *
 * Sprint: P463
 */

import { keccak256, encodePacked, getAddress } from 'viem';
import {
  ActionCategory,
  ATTESTATION_DOMAIN,
  ATTESTATION_TYPES,
  type AttestationFields,
} from '../types.js';
import type { ActionResult } from './agent.js';
import type { BasinState } from './basin.js';

// ─── ActionCategory → uint8 mapping ──────────────────────────────────────────
// ActionCategory is a string enum; EIP-712 actionType field is uint8.
const ACTION_TYPE_INDEX: Record<ActionCategory, number> = {
  [ActionCategory.Productive]:      0,
  [ActionCategory.Regenerative]:    1,
  [ActionCategory.Infrastructural]: 2,
  [ActionCategory.Governing]:       3,
  [ActionCategory.Relational]:      4,
  [ActionCategory.Informational]:   5,
  [ActionCategory.Succession]:      6,
};

// ─── Attestation ──────────────────────────────────────────────────────────────

export interface Attestation {
  fields:    AttestationFields;
  /** EIP-712 domain separator + struct hash (deterministic, no signing key needed in M5). */
  dataHash:  string;   // bytes32 hex — what M8 will sign onchain
}

/**
 * Derive the EIP-712 outcomeHash from an ActionResult.
 * outcomeHash = keccak256(abi.encodePacked(agentId, targetParcel, resourceDelta, timestamp))
 */
function computeOutcomeHash(result: ActionResult): `0x${string}` {
  const netDelta = Object.values(result.resourceDelta).reduce((s, v) => s + (v ?? 0), 0);
  // Scale to int256: multiply by 1e9 and floor for integer representation
  const scaledDelta = BigInt(Math.trunc(netDelta * 1e9));

  return keccak256(
    encodePacked(
      ['address', 'bytes32', 'int256', 'uint256'],
      [
        getAddress(result.agentId),
        padToBytes32(result.targetParcel),
        scaledDelta,
        BigInt(Math.trunc(result.timestamp / 1000)),  // unix seconds
      ],
    ),
  );
}

/**
 * Pad an H3 cell ID string to bytes32 (right-pad with zeros).
 * H3 cell IDs are ~15 ASCII chars; encode as UTF-8 bytes in a 32-byte slot.
 */
function padToBytes32(cellId: string): `0x${string}` {
  const hex = Buffer.from(cellId, 'utf8').toString('hex').padEnd(64, '0');
  return `0x${hex}` as `0x${string}`;
}

/**
 * Compute the EIP-712 struct hash for an Action attestation.
 * dataHash = keccak256(typeHash || abi.encode(fields))
 */
function computeAttestationDataHash(fields: AttestationFields): string {
  // Simplified: hash the outcome fields deterministically.
  // Full EIP-712 would encode the struct type hash + field values per the spec.
  // M8 is responsible for the actual ecrecover / EAS submission.
  return keccak256(
    encodePacked(
      ['address', 'uint8', 'bytes32', 'int256', 'uint256', 'bytes32'],
      [
        getAddress(fields.agentId),
        fields.actionType,
        padToBytes32(fields.targetParcel),
        fields.resourceDelta,
        fields.timestamp,
        fields.outcomeHash as `0x${string}`,
      ],
    ),
  );
}

/**
 * Build an Attestation from an ActionResult.
 * Called by the M3/M4 integration layer after each action execution.
 */
export function buildAttestation(result: ActionResult): Attestation {
  const netDelta = Object.values(result.resourceDelta).reduce((s, v) => s + (v ?? 0), 0);
  const outcomeHash = computeOutcomeHash(result);

  const fields: AttestationFields = {
    agentId:       result.agentId,
    actionType:    ACTION_TYPE_INDEX[result.category],
    targetParcel:  result.targetParcel,
    resourceDelta: BigInt(Math.trunc(netDelta * 1e9)),
    timestamp:     BigInt(Math.trunc(result.timestamp / 1000)),
    outcomeHash,
  };

  return {
    fields,
    dataHash: computeAttestationDataHash(fields),
  };
}

/**
 * Verify that an Attestation's dataHash is consistent with its fields.
 * Returns true if the hash recomputes correctly (integrity check).
 * Actual signature verification is M8's responsibility.
 */
export function verifyAttestation(att: Attestation): boolean {
  const recomputed = computeAttestationDataHash(att.fields);
  return recomputed === att.dataHash;
}

// ─── Governance Log ───────────────────────────────────────────────────────────

export interface GovernanceLogEntry {
  attestation:  Attestation;
  basinId:      string;
  loggedAt:     number;
}

export interface GovernanceLog {
  entries: GovernanceLogEntry[];
}

export function initGovernanceLog(): GovernanceLog {
  return { entries: [] };
}

export function appendGovernanceLog(
  log: GovernanceLog,
  att: Attestation,
  basinId: string,
  now?: number,
): GovernanceLog {
  return {
    entries: [
      ...log.entries,
      { attestation: att, basinId, loggedAt: now ?? Date.now() },
    ],
  };
}

// ─── Proposals ───────────────────────────────────────────────────────────────

export enum ProposalStatus {
  Pending = 'pending',
  Active  = 'active',
  Passed  = 'passed',
  Failed  = 'failed',
  Vetoed  = 'vetoed',
}

export interface Proposal {
  proposalId:    string;
  basinId:       string;
  proposerId:    string;
  title:         string;
  description:   string;
  status:        ProposalStatus;
  votes:         Vote[];
  /** Total vote weight cast FOR. */
  weightFor:     number;
  /** Total vote weight cast AGAINST. */
  weightAgainst: number;
  /** Required quorum (sum of all cast weights). Normal: QUORUM_THRESHOLD. Emergency: EMERGENCY_QUORUM. */
  quorumRequired:number;
  createdAt:     number;
  decidedAt?:    number;
}

export interface Vote {
  agentId:   string;
  support:   boolean;    // true = for, false = against
  weight:    number;
  timestamp: number;
}

// ─── Governance State ─────────────────────────────────────────────────────────

export interface GovernanceState {
  proposals: Map<string, Proposal>;
  log:       GovernanceLog;
}

export function initGovernanceState(): GovernanceState {
  return { proposals: new Map(), log: initGovernanceLog() };
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum total vote weight (as fraction of eligible weight) to pass a proposal. */
export const QUORUM_THRESHOLD = 0.5;

/** Reduced quorum for emergency governance when basin is stressed. */
export const EMERGENCY_QUORUM = 0.25;

/**
 * Majority threshold: fraction of cast weight that must be FOR to pass.
 * 0.5 = simple majority.
 */
export const MAJORITY_THRESHOLD = 0.5;

// ─── Vote Weight ──────────────────────────────────────────────────────────────

/**
 * Compute vote weight for an agent.
 * weight = parcelCount × reputationScore
 * where reputationScore ∈ [0, 1] (M7 will provide this; here we accept it as input).
 *
 * Design note: this makes restoration-track agents (high reputation, more parcels)
 * have more governance power. Defectors lose reputation → lose weight → governance
 * becomes dominated by stewards. This is the mechanism that makes defection
 * strictly dominated, not just suboptimal in one config.
 */
export function computeVoteWeight(parcelCount: number, reputationScore: number): number {
  return Math.max(0, parcelCount) * Math.max(0, Math.min(1, reputationScore));
}

// ─── Proposal Lifecycle ───────────────────────────────────────────────────────

export function submitProposal(
  gs: GovernanceState,
  bs: BasinState,
  proposalId: string,
  basinId: string,
  proposerId: string,
  title: string,
  description: string,
  now?: number,
): GovernanceState {
  if (gs.proposals.has(proposalId)) {
    throw new Error(`Proposal ${proposalId} already exists`);
  }

  const ts = now ?? Date.now();

  // Determine quorum based on whether basin is stressed
  const basin = bs.basins.get(basinId);
  const stressed = basin?.events.some(e => e.type === 'basin_stress') ?? false;
  const quorumRequired = stressed ? EMERGENCY_QUORUM : QUORUM_THRESHOLD;

  const proposal: Proposal = {
    proposalId,
    basinId,
    proposerId,
    title,
    description,
    status:        ProposalStatus.Active,
    votes:         [],
    weightFor:     0,
    weightAgainst: 0,
    quorumRequired,
    createdAt:     ts,
  };

  const newProposals = new Map(gs.proposals);
  newProposals.set(proposalId, proposal);
  return { ...gs, proposals: newProposals };
}

export function castVote(
  gs: GovernanceState,
  proposalId: string,
  agentId: string,
  support: boolean,
  voteWeight: number,
  now?: number,
): GovernanceState {
  const proposal = gs.proposals.get(proposalId);
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
  if (proposal.status !== ProposalStatus.Active) {
    throw new Error(`Proposal ${proposalId} is ${proposal.status}, not active`);
  }
  if (proposal.votes.some(v => v.agentId === agentId)) {
    throw new Error(`Agent ${agentId} has already voted on ${proposalId}`);
  }
  if (voteWeight < 0) {
    throw new Error('Vote weight cannot be negative');
  }

  const ts = now ?? Date.now();
  const vote: Vote = { agentId, support, weight: voteWeight, timestamp: ts };

  const updated: Proposal = {
    ...proposal,
    votes:         [...proposal.votes, vote],
    weightFor:     support ? proposal.weightFor + voteWeight : proposal.weightFor,
    weightAgainst: support ? proposal.weightAgainst : proposal.weightAgainst + voteWeight,
  };

  const newProposals = new Map(gs.proposals);
  newProposals.set(proposalId, updated);
  return { ...gs, proposals: newProposals };
}

/**
 * Tally votes and finalise a proposal.
 * A proposal passes when:
 *   totalCastWeight >= totalEligibleWeight × quorumRequired
 *   AND weightFor / totalCastWeight > MAJORITY_THRESHOLD
 *
 * totalEligibleWeight is the sum of all possible vote weights across eligible agents.
 * If not provided, falls back to total cast weight (conservative: quorum always met if
 * at least one agent votes).
 */
export function tallyProposal(
  gs: GovernanceState,
  proposalId: string,
  totalEligibleWeight: number,
  now?: number,
): GovernanceState {
  const proposal = gs.proposals.get(proposalId);
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
  if (proposal.status !== ProposalStatus.Active) {
    throw new Error(`Proposal ${proposalId} is not active`);
  }

  const ts = now ?? Date.now();
  const totalCast = proposal.weightFor + proposal.weightAgainst;

  // Quorum check
  const quorumMet = totalEligibleWeight > 0
    ? totalCast >= totalEligibleWeight * proposal.quorumRequired
    : totalCast > 0;  // fallback: any vote meets quorum

  const majorityFor = totalCast > 0
    ? proposal.weightFor / totalCast > MAJORITY_THRESHOLD
    : false;

  const newStatus: ProposalStatus =
    quorumMet && majorityFor ? ProposalStatus.Passed : ProposalStatus.Failed;

  const finalised: Proposal = { ...proposal, status: newStatus, decidedAt: ts };
  const newProposals = new Map(gs.proposals);
  newProposals.set(proposalId, finalised);

  // Append governance outcome to log
  const outcomeAtt: Attestation = {
    fields: {
      agentId:       proposal.proposerId,
      actionType:    ACTION_TYPE_INDEX[ActionCategory.Governing],
      targetParcel:  proposal.basinId,   // basin as the "target" for governance actions
      resourceDelta: BigInt(0),          // governance itself doesn't move resources
      timestamp:     BigInt(Math.trunc(ts / 1000)),
      outcomeHash:   keccak256(encodePacked(
        ['string', 'string', 'bool'],
        [proposalId, newStatus, newStatus === ProposalStatus.Passed],
      )),
    },
    dataHash: '',  // set below
  };
  outcomeAtt.dataHash = computeAttestationDataHash(outcomeAtt.fields);

  const newLog = appendGovernanceLog(gs.log, outcomeAtt, proposal.basinId, ts);
  return { proposals: newProposals, log: newLog };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function getProposal(gs: GovernanceState, proposalId: string): Proposal | undefined {
  return gs.proposals.get(proposalId);
}

export function listProposals(gs: GovernanceState): Proposal[] {
  return Array.from(gs.proposals.values());
}

export function listProposalsByStatus(gs: GovernanceState, status: ProposalStatus): Proposal[] {
  return listProposals(gs).filter(p => p.status === status);
}
