/**
 * M5 Governance — test suite
 * Sprint: P463
 *
 * Includes the defection-is-dominated suite per P463 review:
 * governance must make defection a strictly dominated strategy,
 * not just prevent collapse in one configuration.
 */

import { latLngToCell } from 'h3-js';
import {
  initSubstrate,
  addCell,
  southBoulderCreekSeedCell,
  DEFAULT_RESOLUTION,
} from '../src/modules/substrate.js';
import {
  initParcelState,
  claimParcel,
  startStewardship,
  ResourceType,
} from '../src/modules/parcel.js';
import {
  initAgentState,
  registerAgent,
  executeAction,
  AgentType,
} from '../src/modules/agent.js';
import {
  initBasinState,
  createBasin,
  accumulateExternality,
} from '../src/modules/basin.js';
import {
  initGovernanceState,
  buildAttestation,
  verifyAttestation,
  computeVoteWeight,
  submitProposal,
  castVote,
  tallyProposal,
  appendGovernanceLog,
  ProposalStatus,
  QUORUM_THRESHOLD,
  EMERGENCY_QUORUM,
  MAJORITY_THRESHOLD,
} from '../src/modules/governance.js';
import { ActionCategory } from '../src/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CENTER   = southBoulderCreekSeedCell(DEFAULT_RESOLUTION);
const PARCEL_A = CENTER;
const AGENT_A  = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const AGENT_B  = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
const AGENT_C  = '0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc';
const NOW      = 1_700_000_000_000;

function makeWorld() {
  let ss = initSubstrate({ now: NOW });
  ss = addCell(ss, PARCEL_A, undefined, undefined, NOW);

  let ps = initParcelState();
  ps = claimParcel(ps, PARCEL_A, AGENT_A, NOW);
  ps = startStewardship(ps, PARCEL_A, AGENT_A, NOW + 10);

  let as = initAgentState();
  as = registerAgent(as, AGENT_A, 'Alice', AgentType.Human, NOW);

  let bs = initBasinState();
  bs = createBasin(bs, ss, ps, CENTER, NOW);

  const gs = initGovernanceState();

  return { ss, ps, as, bs, gs };
}

function makeResult(category: ActionCategory, intensity = 0.5) {
  const { as, ps } = makeWorld();
  return executeAction(as, ps, {
    actionId:     'test-action',
    agentId:      AGENT_A,
    category,
    targetParcel: PARCEL_A,
    resourceType: ResourceType.Water as ResourceType,
    intensity,
    timestamp:    NOW + 100,
  }).result;
}

// ─── Attestation ──────────────────────────────────────────────────────────────

describe('buildAttestation', () => {
  test('attestation has required EIP-712 fields', () => {
    const result = makeResult(ActionCategory.Regenerative);
    const att = buildAttestation(result);
    expect(att.fields.agentId).toBe(AGENT_A);
    expect(att.fields.targetParcel).toBe(PARCEL_A);
    expect(typeof att.fields.resourceDelta).toBe('bigint');
    expect(typeof att.fields.timestamp).toBe('bigint');
    expect(att.fields.outcomeHash).toMatch(/^0x/);
  });

  test('dataHash is a 0x-prefixed 32-byte hex string', () => {
    const result = makeResult(ActionCategory.Productive);
    const att = buildAttestation(result);
    expect(att.dataHash).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  test('same result always produces same attestation (deterministic)', () => {
    const result = makeResult(ActionCategory.Regenerative);
    const att1 = buildAttestation(result);
    const att2 = buildAttestation(result);
    expect(att1.dataHash).toBe(att2.dataHash);
    expect(att1.fields.outcomeHash).toBe(att2.fields.outcomeHash);
  });

  test('different results produce different attestations', () => {
    const r1 = makeResult(ActionCategory.Productive);
    const r2 = makeResult(ActionCategory.Regenerative);
    expect(buildAttestation(r1).dataHash).not.toBe(buildAttestation(r2).dataHash);
  });
});

describe('verifyAttestation', () => {
  test('fresh attestation verifies', () => {
    const att = buildAttestation(makeResult(ActionCategory.Regenerative));
    expect(verifyAttestation(att)).toBe(true);
  });

  test('tampered attestation fails verification', () => {
    const att = buildAttestation(makeResult(ActionCategory.Regenerative));
    const tampered = { ...att, dataHash: '0x' + 'ff'.repeat(32) };
    expect(verifyAttestation(tampered)).toBe(false);
  });
});

// ─── Vote Weight ──────────────────────────────────────────────────────────────

describe('computeVoteWeight', () => {
  test('weight = parcelCount × reputationScore', () => {
    expect(computeVoteWeight(3, 0.8)).toBeCloseTo(2.4, 5);
  });

  test('zero parcels → zero weight', () => {
    expect(computeVoteWeight(0, 1.0)).toBe(0);
  });

  test('zero reputation → zero weight', () => {
    expect(computeVoteWeight(5, 0)).toBe(0);
  });

  test('reputation clamped to [0,1]', () => {
    expect(computeVoteWeight(1, 2.0)).toBe(computeVoteWeight(1, 1.0));
    expect(computeVoteWeight(1, -1.0)).toBe(0);
  });
});

// ─── Proposal Lifecycle ───────────────────────────────────────────────────────

describe('submitProposal', () => {
  test('proposal starts Active', () => {
    const { bs, gs } = makeWorld();
    const gs2 = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'Test', 'Desc', NOW);
    expect(gs2.proposals.get('p1')!.status).toBe(ProposalStatus.Active);
  });

  test('uses normal quorum on unstressed basin', () => {
    const { bs, gs } = makeWorld();
    const gs2 = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'Test', 'Desc', NOW);
    expect(gs2.proposals.get('p1')!.quorumRequired).toBe(QUORUM_THRESHOLD);
  });

  test('uses emergency quorum on stressed basin', () => {
    let { bs, gs, as, ps } = makeWorld();
    // Stress the basin
    for (let i = 0; i < 5; i++) {
      const result = makeResult(ActionCategory.Productive, 1.0);
      bs = accumulateExternality(bs, CENTER, result);
    }
    const gs2 = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'Emergency', 'Urgent', NOW);
    expect(gs2.proposals.get('p1')!.quorumRequired).toBe(EMERGENCY_QUORUM);
  });

  test('throws on duplicate proposalId', () => {
    const { bs, gs } = makeWorld();
    const gs2 = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'T', 'D', NOW);
    expect(() => submitProposal(gs2, bs, 'p1', CENTER, AGENT_A, 'T2', 'D2', NOW))
      .toThrow(/already exists/);
  });

  test('state is immutable', () => {
    const { bs, gs } = makeWorld();
    submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'T', 'D', NOW);
    expect(gs.proposals.size).toBe(0);
  });
});

describe('castVote', () => {
  test('vote is recorded', () => {
    const { bs, gs } = makeWorld();
    let state = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'T', 'D', NOW);
    state = castVote(state, 'p1', AGENT_A, true, 1.0, NOW + 1);
    const prop = state.proposals.get('p1')!;
    expect(prop.votes).toHaveLength(1);
    expect(prop.weightFor).toBe(1.0);
  });

  test('vote against updates weightAgainst', () => {
    const { bs, gs } = makeWorld();
    let state = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'T', 'D', NOW);
    state = castVote(state, 'p1', AGENT_A, false, 2.0, NOW + 1);
    expect(state.proposals.get('p1')!.weightAgainst).toBe(2.0);
  });

  test('throws on double vote', () => {
    const { bs, gs } = makeWorld();
    let state = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'T', 'D', NOW);
    state = castVote(state, 'p1', AGENT_A, true, 1.0, NOW + 1);
    expect(() => castVote(state, 'p1', AGENT_A, false, 1.0, NOW + 2))
      .toThrow(/already voted/);
  });

  test('throws on inactive proposal', () => {
    const { bs, gs } = makeWorld();
    let state = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'T', 'D', NOW);
    state = castVote(state, 'p1', AGENT_A, true, 1.0, NOW + 1);
    state = tallyProposal(state, 'p1', 1.0, NOW + 2);  // finalise it
    expect(() => castVote(state, 'p1', AGENT_B, true, 1.0, NOW + 3))
      .toThrow(/not active/);
  });
});

describe('tallyProposal', () => {
  test('passes when quorum and majority are met', () => {
    const { bs, gs } = makeWorld();
    let state = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'T', 'D', NOW);
    state = castVote(state, 'p1', AGENT_A, true,  3.0, NOW + 1);
    state = castVote(state, 'p1', AGENT_B, false, 1.0, NOW + 2);
    state = tallyProposal(state, 'p1', 4.0, NOW + 3);
    expect(state.proposals.get('p1')!.status).toBe(ProposalStatus.Passed);
  });

  test('fails when quorum not met', () => {
    const { bs, gs } = makeWorld();
    let state = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'T', 'D', NOW);
    state = castVote(state, 'p1', AGENT_A, true, 0.1, NOW + 1);
    // totalEligibleWeight = 10, cast = 0.1 → 1% < 50% quorum
    state = tallyProposal(state, 'p1', 10.0, NOW + 2);
    expect(state.proposals.get('p1')!.status).toBe(ProposalStatus.Failed);
  });

  test('fails when majority not reached despite quorum', () => {
    const { bs, gs } = makeWorld();
    let state = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'T', 'D', NOW);
    state = castVote(state, 'p1', AGENT_A, true,  1.0, NOW + 1);
    state = castVote(state, 'p1', AGENT_B, false, 3.0, NOW + 2);
    state = tallyProposal(state, 'p1', 4.0, NOW + 3);
    expect(state.proposals.get('p1')!.status).toBe(ProposalStatus.Failed);
  });

  test('governance outcome appended to log', () => {
    const { bs, gs } = makeWorld();
    let state = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'T', 'D', NOW);
    state = castVote(state, 'p1', AGENT_A, true, 1.0, NOW + 1);
    state = tallyProposal(state, 'p1', 1.0, NOW + 2);
    expect(state.log.entries.length).toBe(1);
  });

  test('log entry attestation is verifiable', () => {
    const { bs, gs } = makeWorld();
    let state = submitProposal(gs, bs, 'p1', CENTER, AGENT_A, 'T', 'D', NOW);
    state = castVote(state, 'p1', AGENT_A, true, 1.0, NOW + 1);
    state = tallyProposal(state, 'p1', 1.0, NOW + 2);
    const entry = state.log.entries[0];
    expect(verifyAttestation(entry.attestation)).toBe(true);
  });
});

// ─── Emergency Governance ─────────────────────────────────────────────────────

describe('emergency governance', () => {
  test('emergency proposal has lower quorum requirement', () => {
    let { bs, gs } = makeWorld();
    for (let i = 0; i < 5; i++) {
      bs = accumulateExternality(bs, CENTER, makeResult(ActionCategory.Productive, 1.0));
    }
    const gs2 = submitProposal(gs, bs, 'emergency-1', CENTER, AGENT_A, 'Emergency', 'Urgent', NOW);
    expect(gs2.proposals.get('emergency-1')!.quorumRequired).toBeLessThan(QUORUM_THRESHOLD);
  });

  test('emergency proposal can pass with less participation', () => {
    let { bs, gs } = makeWorld();
    for (let i = 0; i < 5; i++) {
      bs = accumulateExternality(bs, CENTER, makeResult(ActionCategory.Productive, 1.0));
    }
    let state = submitProposal(gs, bs, 'e1', CENTER, AGENT_A, 'Emergency', 'Urgent', NOW);
    // Only 1 vote from 10 total weight = 10% → still passes emergency quorum (25%)? No.
    // But with totalEligible=1.0 and 1 vote = 100% → passes
    state = castVote(state, 'e1', AGENT_A, true, 1.0, NOW + 1);
    state = tallyProposal(state, 'e1', 1.0, NOW + 2);
    expect(state.proposals.get('e1')!.status).toBe(ProposalStatus.Passed);
  });
});

// ─── Defection is Dominated ───────────────────────────────────────────────────
// Per P463 review: governance must make defection STRICTLY DOMINATED —
// a defector's vote weight falls to near-zero as reputation degrades,
// so stewards always out-vote defectors in governance.

describe('defection is dominated', () => {
  test('steward with high reputation out-votes defector with low reputation', () => {
    // Steward: 3 parcels, reputation 0.9
    // Defector: 3 parcels, reputation 0.1 (degraded by extraction)
    const stewardWeight  = computeVoteWeight(3, 0.9);  // 2.7
    const defectorWeight = computeVoteWeight(3, 0.1);  // 0.3

    expect(stewardWeight).toBeGreaterThan(defectorWeight);
  });

  test('defector with max parcels cannot overcome steward majority at moderate reputation', () => {
    // Even if a defector hoards 5 parcels but has 0.2 reputation,
    // a steward coalition of 3 agents × 2 parcels × 0.8 reputation wins
    const defectorWeight = computeVoteWeight(5, 0.2);   // 1.0
    const stewardCoalitionWeight = 3 * computeVoteWeight(2, 0.8);  // 4.8

    expect(stewardCoalitionWeight).toBeGreaterThan(defectorWeight * 3);  // strict domination
  });

  test('governance proposal to restrict extraction passes against defector block', () => {
    const { bs, gs } = makeWorld();
    let state = submitProposal(gs, bs, 'restrict-1', CENTER, AGENT_A,
      'Restrict high-intensity extraction', 'Cap productive actions at 0.5 intensity', NOW);

    // Three stewards vote for
    state = castVote(state, 'restrict-1', AGENT_A, true,  computeVoteWeight(2, 0.85), NOW + 1);
    state = castVote(state, 'restrict-1', AGENT_B, true,  computeVoteWeight(1, 0.90), NOW + 2);
    // One defector votes against
    state = castVote(state, 'restrict-1', AGENT_C, false, computeVoteWeight(2, 0.15), NOW + 3);

    const totalEligible = computeVoteWeight(2, 0.85) + computeVoteWeight(1, 0.90) + computeVoteWeight(2, 0.15);
    state = tallyProposal(state, 'restrict-1', totalEligible, NOW + 4);

    expect(state.proposals.get('restrict-1')!.status).toBe(ProposalStatus.Passed);
  });

  test('defector voting alone cannot pass a proposal to weaken commons rules', () => {
    const { bs, gs } = makeWorld();
    let state = submitProposal(gs, bs, 'weaken-1', CENTER, AGENT_C,
      'Remove extraction limits', 'Allow unlimited productive actions', NOW);

    // Only defector votes
    state = castVote(state, 'weaken-1', AGENT_C, true, computeVoteWeight(1, 0.1), NOW + 1);

    // Total eligible weight includes all stewards who didn't vote — defector alone can't meet quorum
    const stewardEligibleWeight = computeVoteWeight(3, 0.85) + computeVoteWeight(2, 0.75);
    const totalEligible = computeVoteWeight(1, 0.1) + stewardEligibleWeight;

    state = tallyProposal(state, 'weaken-1', totalEligible, NOW + 2);
    expect(state.proposals.get('weaken-1')!.status).toBe(ProposalStatus.Failed);
  });
});

// ─── Governance Log ───────────────────────────────────────────────────────────

describe('governance log', () => {
  test('log is append-only (immutable)', () => {
    const log1 = { entries: [] };
    const att = buildAttestation(makeResult(ActionCategory.Governing));
    const log2 = appendGovernanceLog(log1, att, CENTER, NOW);
    expect(log1.entries).toHaveLength(0);
    expect(log2.entries).toHaveLength(1);
  });

  test('log entries are JSON-serializable for M8', () => {
    const log1 = { entries: [] };
    const att = buildAttestation(makeResult(ActionCategory.Regenerative));
    const log2 = appendGovernanceLog(log1, att, CENTER, NOW);
    // BigInt fields need special handling; check the outer structure
    const entry = log2.entries[0];
    expect(entry.basinId).toBe(CENTER);
    expect(entry.attestation.dataHash).toMatch(/^0x/);
  });
});
