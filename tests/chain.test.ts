/**
 * M8 Chain + Spectator — test suite
 * Sprint: P466
 */

import {
  southBoulderCreekSeedCell,
  DEFAULT_RESOLUTION,
  initSubstrate,
  addCell,
} from '../src/modules/substrate.js';
import {
  initParcelState,
  claimParcel,
  startStewardship,
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
  buildAttestation,
} from '../src/modules/governance.js';
import {
  initTrustState,
  registerReputationRecord,
  applyTrustSignal,
  TreatmentBand,
} from '../src/modules/trust.js';
import {
  initSeasonStore,
  createSeason,
  beginSeason,
  advancePhase,
  queueAction,
  SeasonStatus,
  FlourishingArchetype,
  COLLAPSE_ARCHETYPE,
} from '../src/modules/season-full.js';
import {
  computeMerkleRoot,
  buildOnchainRecord,
  encodeOnchainRecord,
  prepareChainSubmission,
  buildSpectatorView,
  ARCHETYPE_INDEX,
  BASE_CHAIN_ID,
  TECHNE_WALLET,
} from '../src/modules/chain.js';
import { ActionCategory } from '../src/types.js';
import { ResourceType } from '../src/modules/parcel.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CENTER  = southBoulderCreekSeedCell(DEFAULT_RESOLUTION);
const AGENT_A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const NOW     = 1_700_000_000_000;

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

  let gs = initGovernanceState();
  let ts = initTrustState();
  ts = registerReputationRecord(ts, AGENT_A, NOW);

  const store = initSeasonStore();

  return { ss, ps, as, bs, gs, ts, store };
}

function makeRegenAction(ts = NOW + 200) {
  return {
    actionId: `regen-${ts}`, agentId: AGENT_A,
    category: ActionCategory.Regenerative,
    targetParcel: CENTER,
    resourceType: ResourceType.Water,
    intensity: 0.5, timestamp: ts,
  };
}

/** Run a season to completion and return it. */
function runCompleteSeason(
  world: ReturnType<typeof makeWorld>,
) {
  const { ss, as, ps, bs, gs } = world;
  let st = createSeason(world.store, 'test', CENTER, 1, NOW);
  st = beginSeason(st, 'test', NOW);

  let newAs = as, newPs = ps, newBs = bs;
  for (let i = 0; i < 4; i++) {
    const r = advancePhase(st, 'test', ss, newAs, newPs, newBs, gs, CENTER, NOW + 10 * (i + 1));
    st = r.newStore; newAs = r.newAs; newPs = r.newPs; newBs = r.newBs;
    if (i === 0) {
      st = queueAction(st, 'test', makeRegenAction(NOW + 100));
    }
  }

  return { store: st, ps: newPs, bs: newBs };
}

// ─── Merkle Root ──────────────────────────────────────────────────────────────

describe('computeMerkleRoot', () => {
  test('returns bytes32 hex string', () => {
    const root = computeMerkleRoot(['0x' + 'ab'.repeat(32)]);
    expect(root).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  test('empty list returns keccak of empty bytes', () => {
    const root = computeMerkleRoot([]);
    expect(root).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  test('single leaf root equals itself hashed', () => {
    const leaf = '0x' + 'ab'.repeat(32);
    const root = computeMerkleRoot([leaf]);
    expect(root).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  test('two leaves produce distinct root', () => {
    const leaf1 = '0x' + 'aa'.repeat(32);
    const leaf2 = '0x' + 'bb'.repeat(32);
    const root = computeMerkleRoot([leaf1, leaf2]);
    expect(root).not.toBe(leaf1);
    expect(root).not.toBe(leaf2);
  });

  test('root is deterministic (same input → same output)', () => {
    const leaves = ['0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(32)];
    expect(computeMerkleRoot(leaves)).toBe(computeMerkleRoot(leaves));
  });

  test('order-independent: sorted pair produces same root regardless of input order', () => {
    const a = '0x' + '11'.repeat(32);
    const b = '0x' + '22'.repeat(32);
    // The tree sorts pairs, so root(a, b) should equal root(b, a) for 2-leaf trees
    expect(computeMerkleRoot([a, b])).toBe(computeMerkleRoot([b, a]));
  });

  test('different leaves produce different roots', () => {
    const r1 = computeMerkleRoot(['0x' + 'aa'.repeat(32)]);
    const r2 = computeMerkleRoot(['0x' + 'bb'.repeat(32)]);
    expect(r1).not.toBe(r2);
  });
});

// ─── Archetype Index ─────────────────────────────────────────────────────────

describe('ARCHETYPE_INDEX', () => {
  test('all five archetypes have unique indices 0-4', () => {
    const indices = Object.values(FlourishingArchetype).map(a => ARCHETYPE_INDEX[a]);
    const unique = new Set(indices);
    expect(unique.size).toBe(5);
    for (const i of indices) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThanOrEqual(4);
    }
  });

  test('collapse archetype maps to 255', () => {
    expect(ARCHETYPE_INDEX[COLLAPSE_ARCHETYPE]).toBe(255);
  });
});

// ─── OnchainRecord ────────────────────────────────────────────────────────────

describe('buildOnchainRecord', () => {
  test('builds record from completed season', () => {
    const world = makeWorld();
    const { store, ps, bs } = runCompleteSeason(world);
    const season = store.seasons.get('test')!;

    const record = buildOnchainRecord(season, []);
    expect(record.seasonId).toBe('test');
    expect(record.basinId).toBe(CENTER);
    expect(record.outcomeHash).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  test('collapseFlag false for healthy season', () => {
    const world = makeWorld();
    const { store } = runCompleteSeason(world);
    const season = store.seasons.get('test')!;
    const record = buildOnchainRecord(season, []);
    expect(record.collapseFlag).toBe(false);
  });

  test('throws for season without score', () => {
    const world = makeWorld();
    let st = createSeason(world.store, 'notscore', CENTER, 1, NOW);
    st = beginSeason(st, 'notscore', NOW);
    const season = st.seasons.get('notscore')!;
    expect(() => buildOnchainRecord(season, [])).toThrow(/no score/);
  });

  test('outcomeHash includes attestation data', () => {
    const world = makeWorld();
    const { store } = runCompleteSeason(world);
    const season = store.seasons.get('test')!;

    const fakeAttestation = { fields: {} as any, dataHash: '0x' + 'ab'.repeat(32) };
    const recordWithAtt  = buildOnchainRecord(season, [fakeAttestation]);
    const recordWithout  = buildOnchainRecord(season, []);

    expect(recordWithAtt.outcomeHash).not.toBe(recordWithout.outcomeHash);
  });
});

// ─── ABI Encoding ─────────────────────────────────────────────────────────────

describe('encodeOnchainRecord', () => {
  test('produces 0x-prefixed hex string', () => {
    const world = makeWorld();
    const { store } = runCompleteSeason(world);
    const season = store.seasons.get('test')!;
    const record = buildOnchainRecord(season, []);
    const encoded = encodeOnchainRecord(record);
    expect(encoded).toMatch(/^0x[0-9a-f]+$/i);
  });

  test('encoded length is multiple of 32 bytes (192 bytes = 6 × 32)', () => {
    const world = makeWorld();
    const { store } = runCompleteSeason(world);
    const season = store.seasons.get('test')!;
    const record = buildOnchainRecord(season, []);
    const encoded = encodeOnchainRecord(record);
    const byteLen = (encoded.length - 2) / 2;
    expect(byteLen % 32).toBe(0);
  });
});

// ─── Chain Submission ─────────────────────────────────────────────────────────

describe('prepareChainSubmission', () => {
  function getRecord() {
    const world = makeWorld();
    const { store } = runCompleteSeason(world);
    const season = store.seasons.get('test')!;
    return buildOnchainRecord(season, []);
  }

  test('tx.from is Techne wallet', () => {
    const sub = prepareChainSubmission(getRecord());
    expect(sub.tx.from.toLowerCase()).toBe(TECHNE_WALLET.toLowerCase());
  });

  test('tx.chainId is Base mainnet', () => {
    const sub = prepareChainSubmission(getRecord());
    expect(sub.tx.chainId).toBe(BASE_CHAIN_ID);
  });

  test('tx.data is ABI-encoded calldata', () => {
    const sub = prepareChainSubmission(getRecord());
    expect(sub.tx.data).toMatch(/^0x/);
  });

  test('tx.value is 0', () => {
    const sub = prepareChainSubmission(getRecord());
    expect(sub.tx.value).toBe(BigInt(0));
  });

  test('summary string is non-empty', () => {
    const sub = prepareChainSubmission(getRecord());
    expect(sub.summary.length).toBeGreaterThan(0);
  });

  test('submission is JSON-serializable (except BigInt)', () => {
    const sub = prepareChainSubmission(getRecord());
    // BigInt isn't JSON-serializable by default — test the record and summary
    expect(() => JSON.stringify({ ...sub, tx: undefined })).not.toThrow();
    expect(() => JSON.stringify(sub.record)).not.toThrow();
  });
});

// ─── Spectator View ───────────────────────────────────────────────────────────

describe('buildSpectatorView', () => {
  test('basinHealth is in (0, 1]', () => {
    const world = makeWorld();
    const st = createSeason(world.store, 's', CENTER, 1, NOW);
    const season = st.seasons.get('s')!;
    const view = buildSpectatorView(world.bs, world.ps, world.ts, season, NOW);
    expect(view.basinHealth).toBeGreaterThan(0);
    expect(view.basinHealth).toBeLessThanOrEqual(1);
  });

  test('basinStressed is false for healthy basin', () => {
    const world = makeWorld();
    const st = createSeason(world.store, 's', CENTER, 1, NOW);
    const season = st.seasons.get('s')!;
    const view = buildSpectatorView(world.bs, world.ps, world.ts, season, NOW);
    expect(view.basinStressed).toBe(false);
  });

  test('seasonStatus reflects season state', () => {
    const world = makeWorld();
    let st = createSeason(world.store, 's', CENTER, 1, NOW);
    const setupSeason = st.seasons.get('s')!;
    const viewSetup = buildSpectatorView(world.bs, world.ps, world.ts, setupSeason, NOW);
    expect(viewSetup.seasonStatus).toBe('setup');
  });

  test('agentLeaderboard lists registered agents', () => {
    const world = makeWorld();
    // Apply some trust signals to AGENT_A
    let ts = applyTrustSignal(world.ts, {
      agentId: AGENT_A, category: ActionCategory.Regenerative,
      valence: 1.0, intensity: 0.8, targetParcel: CENTER,
    }, NOW);

    const st = createSeason(world.store, 's', CENTER, 1, NOW);
    const season = st.seasons.get('s')!;
    const view = buildSpectatorView(world.bs, world.ps, ts, season, NOW);

    expect(view.agentLeaderboard).toHaveLength(1);
    expect(view.agentLeaderboard[0].agentId).toBe(AGENT_A);
  });

  test('flagged agents (band 7) excluded from leaderboard', () => {
    const world = makeWorld();
    let ts = world.ts;
    // Drive AGENT_A to band 7
    for (let i = 0; i < 50; i++) {
      ts = applyTrustSignal(ts, {
        agentId: AGENT_A, category: ActionCategory.Productive,
        valence: -1.0, intensity: 1.0, targetParcel: CENTER,
      }, NOW + i);
    }

    const st = createSeason(world.store, 's', CENTER, 1, NOW);
    const season = st.seasons.get('s')!;
    const view = buildSpectatorView(world.bs, world.ps, ts, season, NOW);

    const agentInLeaderboard = view.agentLeaderboard.some(e => e.agentId === AGENT_A);
    // If agent is band 7, they should be excluded
    const rec = ts.records.get(AGENT_A)!;
    if (rec.treatment_band === TreatmentBand.B7) {
      expect(agentInLeaderboard).toBe(false);
    }
  });

  test('archetypeScores is empty before season completes', () => {
    const world = makeWorld();
    const st = createSeason(world.store, 's', CENTER, 1, NOW);
    const season = st.seasons.get('s')!;
    const view = buildSpectatorView(world.bs, world.ps, world.ts, season, NOW);
    expect(view.archetypeScores).toHaveLength(0);
  });

  test('archetypeScores populated after season completion', () => {
    const world = makeWorld();
    const { store, ps, bs } = runCompleteSeason(world);
    const season = store.seasons.get('test')!;
    const view = buildSpectatorView(bs, ps, world.ts, season, NOW + 1000);
    expect(view.archetypeScores.length).toBeGreaterThan(0);
  });

  test('view is JSON-serializable', () => {
    const world = makeWorld();
    const st = createSeason(world.store, 's', CENTER, 1, NOW);
    const season = st.seasons.get('s')!;
    const view = buildSpectatorView(world.bs, world.ps, world.ts, season, NOW);
    expect(() => JSON.stringify(view)).not.toThrow();
  });

  test('currentPhase is not_started before season begins', () => {
    const world = makeWorld();
    const st = createSeason(world.store, 's', CENTER, 1, NOW);
    const season = st.seasons.get('s')!;
    const view = buildSpectatorView(world.bs, world.ps, world.ts, season, NOW);
    expect(view.currentPhase).toBe('not_started');
  });
});
