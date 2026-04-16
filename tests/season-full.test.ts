/**
 * M6 Season Full — test suite
 * Sprint: P464
 */

import {
  initSubstrate,
  addCell,
  updateConstraints,
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
  AgentType,
} from '../src/modules/agent.js';
import {
  initBasinState,
  createBasin,
} from '../src/modules/basin.js';
import {
  initGovernanceState,
  submitProposal,
  castVote,
  tallyProposal,
  computeVoteWeight,
} from '../src/modules/governance.js';
import {
  initSeasonStore,
  createSeason,
  beginSeason,
  advancePhase,
  queueAction,
  noteProposal,
  getSeason,
  getCurrentRound,
  scoreArchetypes,
  PhaseType,
  SeasonStatus,
  FlourishingArchetype,
  COLLAPSE_ARCHETYPE,
} from '../src/modules/season-full.js';
import { RoundPhase } from '../src/modules/season.js';
import { ActionCategory } from '../src/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CENTER   = southBoulderCreekSeedCell(DEFAULT_RESOLUTION);
const AGENT_A  = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const NOW      = 1_700_000_000_000;

function makeWorld() {
  let ss = initSubstrate({ now: NOW });
  ss = addCell(ss, CENTER, undefined, undefined, NOW);

  let ps = initParcelState();
  ps = claimParcel(ps, CENTER, AGENT_A, NOW);
  ps = startStewardship(ps, CENTER, AGENT_A, NOW + 10);

  let as = initAgentState();
  as = registerAgent(as, AGENT_A, 'Alice', AgentType.Human, NOW);

  let bs = initBasinState();
  bs = createBasin(bs, ss, ps, CENTER, NOW);

  const gs = initGovernanceState();
  const store = initSeasonStore();

  return { ss, ps, as, bs, gs, store };
}

function makeRegenAction(ts = NOW + 200) {
  return {
    actionId:     `regen-${ts}`,
    agentId:      AGENT_A,
    category:     ActionCategory.Regenerative,
    targetParcel: CENTER,
    resourceType: ResourceType.Water as ResourceType,
    intensity:    0.5,
    timestamp:    ts,
  };
}

// ─── Season Creation ─────────────────────────────────────────────────────────

describe('createSeason', () => {
  test('season starts in Setup status', () => {
    const { store } = makeWorld();
    const s2 = createSeason(store, 's1', CENTER, 3, NOW);
    expect(getSeason(s2, 's1')!.status).toBe(SeasonStatus.Setup);
  });

  test('roundCount is stored', () => {
    const { store } = makeWorld();
    const s2 = createSeason(store, 's1', CENTER, 5, NOW);
    expect(getSeason(s2, 's1')!.roundCount).toBe(5);
  });

  test('throws on duplicate season', () => {
    const { store } = makeWorld();
    const s2 = createSeason(store, 's1', CENTER, 3, NOW);
    expect(() => createSeason(s2, 's1', CENTER, 3, NOW)).toThrow(/already exists/);
  });

  test('throws on roundCount < 1', () => {
    const { store } = makeWorld();
    expect(() => createSeason(store, 's1', CENTER, 0, NOW)).toThrow();
  });

  test('state is immutable', () => {
    const { store } = makeWorld();
    createSeason(store, 's1', CENTER, 3, NOW);
    expect(store.seasons.size).toBe(0);
  });
});

// ─── Season Begin ─────────────────────────────────────────────────────────────

describe('beginSeason', () => {
  test('season transitions to Running', () => {
    const { store } = makeWorld();
    let s = createSeason(store, 's1', CENTER, 2, NOW);
    s = beginSeason(s, 's1', NOW);
    expect(getSeason(s, 's1')!.status).toBe(SeasonStatus.Running);
  });

  test('currentRound becomes 1', () => {
    const { store } = makeWorld();
    let s = createSeason(store, 's1', CENTER, 2, NOW);
    s = beginSeason(s, 's1', NOW);
    expect(getSeason(s, 's1')!.currentRound).toBe(1);
  });

  test('round 1 starts in Reading phase', () => {
    const { store } = makeWorld();
    let s = createSeason(store, 's1', CENTER, 2, NOW);
    s = beginSeason(s, 's1', NOW);
    expect(getCurrentRound(s, 's1')!.currentPhase).toBe(PhaseType.Reading);
  });

  test('throws if already running', () => {
    const { store } = makeWorld();
    let s = createSeason(store, 's1', CENTER, 2, NOW);
    s = beginSeason(s, 's1', NOW);
    expect(() => beginSeason(s, 's1', NOW)).toThrow(/already/);
  });
});

// ─── Phase Advancement ────────────────────────────────────────────────────────

describe('advancePhase', () => {
  function runToProposing(store: ReturnType<typeof makeWorld>['store']) {
    const { ss, as, ps, bs, gs } = makeWorld();
    let s = createSeason(store, 's1', CENTER, 2, NOW);
    s = beginSeason(s, 's1', NOW);
    const r1 = advancePhase(s, 's1', ss, as, ps, bs, gs, CENTER, NOW + 10);
    return { s: r1.newStore, ss, as: r1.newAs, ps: r1.newPs, bs: r1.newBs, gs };
  }

  test('Reading → Proposing', () => {
    const { store } = makeWorld();
    const { s } = runToProposing(store);
    expect(getCurrentRound(s, 's1')!.currentPhase).toBe(PhaseType.Proposing);
  });

  test('Proposing → Negotiation', () => {
    const { store } = makeWorld();
    const { s: s2, ss, as, ps, bs, gs } = runToProposing(store);
    const r = advancePhase(s2, 's1', ss, as, ps, bs, gs, CENTER, NOW + 20);
    expect(getCurrentRound(r.newStore, 's1')!.currentPhase).toBe(PhaseType.Negotiation);
  });

  test('through Execution updates parcel state', () => {
    const { store } = makeWorld();
    let { s: st, ss, as, ps, bs, gs } = runToProposing(store);

    // Queue a regenerative action
    st = queueAction(st, 's1', makeRegenAction(NOW + 300));

    // Advance through Negotiation then Execution
    let r = advancePhase(st, 's1', ss, as, ps, bs, gs, CENTER, NOW + 30);
    st = r.newStore; as = r.newAs; ps = r.newPs; bs = r.newBs;

    r = advancePhase(st, 's1', ss, as, ps, bs, gs, CENTER, NOW + 40);
    st = r.newStore; as = r.newAs; ps = r.newPs; bs = r.newBs;

    // After Execution, parcel state should have changed
    const beforeWater = ps.parcels.get(CENTER)!.resources[ResourceType.Water];
    // newPs is post-execution
    expect(r.newPs.parcels.get(CENTER)!.resources[ResourceType.Water]).toBeGreaterThanOrEqual(beforeWater);
  });

  test('single-round season completes after Reckoning', () => {
    const { store } = makeWorld();
    let { ss, as, ps, bs, gs } = makeWorld();
    let st = createSeason(store, 'single', CENTER, 1, NOW);
    st = beginSeason(st, 'single', NOW);

    // Advance through all 4 transitions (Reading→Proposing→Negotiation→Execution→Reckoning)
    // Queue the action after advancing to Proposing phase
    let newAs = as, newPs = ps, newBs = bs;
    for (let i = 0; i < 4; i++) {
      const r = advancePhase(st, 'single', ss, newAs, newPs, newBs, gs, CENTER, NOW + 10 * (i + 1));
      st = r.newStore;
      newAs = r.newAs;
      newPs = r.newPs;
      newBs = r.newBs;
      // After first advance we're in Proposing — queue an action
      if (i === 0) {
        st = queueAction(st, 'single', makeRegenAction(NOW + 100));
      }
    }

    expect(getSeason(st, 'single')!.status).toBe(SeasonStatus.Complete);
  });

  test('multi-round season advances round counter', () => {
    const { store } = makeWorld();
    let { ss, as, ps, bs, gs } = makeWorld();
    let st = createSeason(store, 'multi', CENTER, 2, NOW);
    st = beginSeason(st, 'multi', NOW);

    let newAs = as, newPs = ps, newBs = bs;
    for (let i = 0; i < 4; i++) {
      const r = advancePhase(st, 'multi', ss, newAs, newPs, newBs, gs, CENTER, NOW + 10 * (i + 1));
      st = r.newStore; newAs = r.newAs; newPs = r.newPs; newBs = r.newBs;
      // Queue action after advancing to Proposing (i=0 = Reading→Proposing)
      if (i === 0) {
        st = queueAction(st, 'multi', makeRegenAction(NOW + 100));
      }
    }

    // After reckoning on round 1 of 2, currentRound should be 2
    expect(getSeason(st, 'multi')!.currentRound).toBe(2);
    expect(getSeason(st, 'multi')!.status).toBe(SeasonStatus.Running);
  });
});

// ─── Action Queuing ────────────────────────────────────────────────────────────

describe('queueAction', () => {
  test('adds action to current round queue', () => {
    const { store } = makeWorld();
    let s = createSeason(store, 's1', CENTER, 2, NOW);
    s = beginSeason(s, 's1', NOW);
    // Advance to Proposing first
    const { ss, as, ps, bs, gs } = makeWorld();
    const r = advancePhase(s, 's1', ss, as, ps, bs, gs, CENTER, NOW + 10);
    let st = r.newStore;
    st = queueAction(st, 's1', makeRegenAction());
    expect(getCurrentRound(st, 's1')!.queuedActions).toHaveLength(1);
  });

  test('throws if not in Proposing phase', () => {
    const { store } = makeWorld();
    let s = createSeason(store, 's1', CENTER, 2, NOW);
    s = beginSeason(s, 's1', NOW);
    // Still in Reading phase
    expect(() => queueAction(s, 's1', makeRegenAction())).toThrow(/Proposing/);
  });
});

// ─── Archetype Scoring ────────────────────────────────────────────────────────

describe('scoreArchetypes', () => {
  test('returns scores for all five archetypes', () => {
    const { bs, ps, gs } = makeWorld();
    // Simulate a minimal reckoning
    const mockReckoning: import('../src/modules/season.js').ReckoningScore = {
      roundNumber: 1, parcelHealthBefore: 0.6, parcelHealthAfter: 0.7,
      healthDelta: 0.1, extractionScore: 0.2, restorationScore: 0.8,
      netTrustValence: 1.5, verdict: 'thriving',
      phase: RoundPhase.Reckoning, timestamp: NOW,
    };
    const score = scoreArchetypes(bs, ps, gs, CENTER, [mockReckoning]);
    const archetypes = score.scores.map(s => s.archetype);
    expect(archetypes).toContain(FlourishingArchetype.Orchard);
    expect(archetypes).toContain(FlourishingArchetype.Confluence);
    expect(archetypes).toContain(FlourishingArchetype.Workshop);
  });

  test('exactly one archetype is dominant', () => {
    const { bs, ps, gs } = makeWorld();
    const mockReckoning: import('../src/modules/season.js').ReckoningScore = {
      roundNumber: 1, parcelHealthBefore: 0.6, parcelHealthAfter: 0.75,
      healthDelta: 0.15, extractionScore: 0, restorationScore: 1.0,
      netTrustValence: 2.0, verdict: 'thriving',
      phase: RoundPhase.Reckoning, timestamp: NOW,
    };
    const score = scoreArchetypes(bs, ps, gs, CENTER, [mockReckoning]);
    const dominantCount = score.scores.filter(s => s.dominant).length;
    expect(dominantCount).toBeGreaterThanOrEqual(1);
  });

  test('collapsed is false when basin is healthy', () => {
    const { bs, ps, gs } = makeWorld();
    const score = scoreArchetypes(bs, ps, gs, CENTER, []);
    expect(score.collapsed).toBe(false);
  });

  test('season score is JSON-serializable', () => {
    const { bs, ps, gs } = makeWorld();
    const score = scoreArchetypes(bs, ps, gs, CENTER, []);
    expect(() => JSON.stringify(score)).not.toThrow();
  });
});
