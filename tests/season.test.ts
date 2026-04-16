/**
 * M6 Season (minimal) — test suite
 * Sprint: P467
 *
 * Tests the Reading → Execution → Reckoning round structure.
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
  ParcelStatus,
} from '../src/modules/parcel.js';
import {
  initAgentState,
  registerAgent,
  syncAgentParcels,
  AgentType,
} from '../src/modules/agent.js';
import { ActionCategory } from '../src/types.js';
import {
  beginReading,
  executeRound,
  reckonRound,
  runRound,
  RoundPhase,
} from '../src/modules/season.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PARCEL_ID = southBoulderCreekSeedCell(DEFAULT_RESOLUTION);
const AGENT_A   = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const NOW       = 1_700_000_000_000;

function makeWorld() {
  let ss = initSubstrate({ now: NOW });
  ss = addCell(ss, PARCEL_ID, undefined, undefined, NOW);

  let ps = initParcelState();
  ps = claimParcel(ps, PARCEL_ID, AGENT_A, NOW);
  ps = startStewardship(ps, PARCEL_ID, AGENT_A, NOW + 10);

  let as = initAgentState();
  as = registerAgent(as, AGENT_A, 'Alice', AgentType.Human, NOW);
  as = syncAgentParcels(as, AGENT_A, [PARCEL_ID], NOW + 10);

  return { ss, as, ps };
}

function regen(n = 1) {
  return Array.from({ length: n }, (_, i) => ({
    actionId:     `regen-${i}`,
    agentId:      AGENT_A,
    category:     ActionCategory.Regenerative,
    targetParcel: PARCEL_ID,
    resourceType: ResourceType.Water as ResourceType,
    intensity:    0.5,
    timestamp:    NOW + 200 + i,
  }));
}

function extract(n = 1) {
  return Array.from({ length: n }, (_, i) => ({
    actionId:     `extract-${i}`,
    agentId:      AGENT_A,
    category:     ActionCategory.Productive,
    targetParcel: PARCEL_ID,
    resourceType: ResourceType.Biomass as ResourceType,
    intensity:    0.5,
    timestamp:    NOW + 200 + i,
  }));
}

// ─── Reading Phase ────────────────────────────────────────────────────────────

describe('beginReading', () => {
  test('returns Reading phase snapshot', () => {
    const { ss, ps } = makeWorld();
    const snap = beginReading(ss, ps, PARCEL_ID, 1, NOW);
    expect(snap.phase).toBe(RoundPhase.Reading);
  });

  test('parcel health is between 0 and 1', () => {
    const { ss, ps } = makeWorld();
    const snap = beginReading(ss, ps, PARCEL_ID, 1, NOW);
    expect(snap.parcelHealth).toBeGreaterThan(0);
    expect(snap.parcelHealth).toBeLessThanOrEqual(1);
  });

  test('substrate health is between 0 and 1', () => {
    const { ss, ps } = makeWorld();
    const snap = beginReading(ss, ps, PARCEL_ID, 1, NOW);
    expect(snap.substrateHealth).toBeGreaterThan(0);
    expect(snap.substrateHealth).toBeLessThanOrEqual(1);
  });

  test('resourceSummary contains all resource types', () => {
    const { ss, ps } = makeWorld();
    const snap = beginReading(ss, ps, PARCEL_ID, 1, NOW);
    expect(snap.resourceSummary[ResourceType.Water]).toBeDefined();
    expect(snap.resourceSummary[ResourceType.Soil]).toBeDefined();
  });

  test('throws for unknown parcel', () => {
    const { ss } = makeWorld();
    const emptyPs = initParcelState();
    expect(() => beginReading(ss, emptyPs, PARCEL_ID, 1)).toThrow(/not found/);
  });
});

// ─── Execution Phase ──────────────────────────────────────────────────────────

describe('executeRound', () => {
  test('returns one result per action', () => {
    const { as, ps } = makeWorld();
    const { results } = executeRound(as, ps, regen(3));
    expect(results).toHaveLength(3);
  });

  test('parcel state is updated after execution', () => {
    const { as, ps } = makeWorld();
    const before = ps.parcels.get(PARCEL_ID)!.resources[ResourceType.Water];
    const { newParcelState } = executeRound(as, ps, regen(1));
    const after = newParcelState.parcels.get(PARCEL_ID)!.resources[ResourceType.Water];
    expect(after).toBeGreaterThan(before);
  });

  test('constraint accumulator is non-empty for regenerative actions', () => {
    const { as, ps } = makeWorld();
    const { constraintAccumulator } = executeRound(as, ps, regen(1));
    expect(Object.keys(constraintAccumulator).length).toBeGreaterThan(0);
  });

  test('original parcel state is unchanged (immutable)', () => {
    const { as, ps } = makeWorld();
    const before = ps.parcels.get(PARCEL_ID)!.resources[ResourceType.Water];
    executeRound(as, ps, regen(2));
    expect(ps.parcels.get(PARCEL_ID)!.resources[ResourceType.Water]).toBe(before);
  });

  test('empty actions list returns original state unchanged', () => {
    const { as, ps } = makeWorld();
    const { results, newParcelState } = executeRound(as, ps, []);
    expect(results).toHaveLength(0);
    expect(newParcelState.parcels.get(PARCEL_ID)!.resources[ResourceType.Water])
      .toBe(ps.parcels.get(PARCEL_ID)!.resources[ResourceType.Water]);
  });
});

// ─── Reckoning Phase ──────────────────────────────────────────────────────────

describe('reckonRound', () => {
  test('verdict is thriving after regenerative actions', () => {
    const { as, ps } = makeWorld();
    // First drain to give room, then restore
    const { newParcelState: drained } = executeRound(as, ps, extract(3));
    const { results, newParcelState: restored } = executeRound(as, drained, regen(3));
    const score = reckonRound(PARCEL_ID, drained, restored, results, 1);
    expect(score.verdict).toBe('thriving');
  });

  test('verdict is declining after heavy extraction', () => {
    const { as, ps } = makeWorld();
    const bigExtract = Array.from({ length: 3 }, (_, i) => ({
      actionId:     `big-extract-${i}`,
      agentId:      AGENT_A,
      category:     ActionCategory.Productive,
      targetParcel: PARCEL_ID,
      resourceType: ResourceType.Biomass as ResourceType,
      intensity:    0.9,
      timestamp:    NOW + 200 + i,
    }));
    const { results, newParcelState } = executeRound(as, ps, bigExtract);
    const score = reckonRound(PARCEL_ID, ps, newParcelState, results, 1);
    expect(score.verdict).toBe('declining');
  });

  test('extractionScore matches productive actions', () => {
    const { as, ps } = makeWorld();
    const { results, newParcelState } = executeRound(as, ps, extract(2));
    const score = reckonRound(PARCEL_ID, ps, newParcelState, results, 1);
    expect(score.extractionScore).toBeGreaterThan(0);
    expect(score.restorationScore).toBe(0);
  });

  test('net trust valence negative for defector scenario', () => {
    const { as, ps } = makeWorld();
    const { results, newParcelState } = executeRound(as, ps, extract(3));
    const score = reckonRound(PARCEL_ID, ps, newParcelState, results, 1);
    expect(score.netTrustValence).toBeLessThan(0);
  });

  test('net trust valence positive for restorer scenario', () => {
    const { as, ps } = makeWorld();
    const { results, newParcelState } = executeRound(as, ps, regen(3));
    const score = reckonRound(PARCEL_ID, ps, newParcelState, results, 1);
    expect(score.netTrustValence).toBeGreaterThan(0);
  });

  test('phase is Reckoning', () => {
    const { as, ps } = makeWorld();
    const { results, newParcelState } = executeRound(as, ps, regen(1));
    const score = reckonRound(PARCEL_ID, ps, newParcelState, results, 1);
    expect(score.phase).toBe(RoundPhase.Reckoning);
  });
});

// ─── Full Round ───────────────────────────────────────────────────────────────

describe('runRound', () => {
  test('returns reading, execution, reckoning', () => {
    const { ss, as, ps } = makeWorld();
    const { reading, execution, reckoning } = runRound({
      ss, as, ps, parcelId: PARCEL_ID, actions: regen(1), roundNumber: 1, now: NOW,
    });
    expect(reading.phase).toBe(RoundPhase.Reading);
    expect(execution.results).toHaveLength(1);
    expect(reckoning.phase).toBe(RoundPhase.Reckoning);
  });

  test('runRound is deterministic with same inputs', () => {
    const { ss, as, ps } = makeWorld();
    const actions = regen(2);
    const r1 = runRound({ ss, as, ps, parcelId: PARCEL_ID, actions, roundNumber: 1, now: NOW });
    const r2 = runRound({ ss, as, ps, parcelId: PARCEL_ID, actions, roundNumber: 1, now: NOW });
    expect(r1.reckoning.parcelHealthAfter).toBe(r2.reckoning.parcelHealthAfter);
    expect(r1.reckoning.verdict).toBe(r2.reckoning.verdict);
  });

  test('stag hunt demo: restorer beats defector', () => {
    // Core mechanic: regenerative play produces better outcomes than extraction
    const { ss, as, ps } = makeWorld();

    const defectorRound = runRound({
      ss, as, ps, parcelId: PARCEL_ID,
      actions: extract(3), roundNumber: 1, now: NOW,
    });

    const restorerRound = runRound({
      ss, as, ps, parcelId: PARCEL_ID,
      actions: regen(3), roundNumber: 1, now: NOW,
    });

    expect(restorerRound.reckoning.parcelHealthAfter)
      .toBeGreaterThan(defectorRound.reckoning.parcelHealthAfter);
    expect(restorerRound.reckoning.netTrustValence)
      .toBeGreaterThan(defectorRound.reckoning.netTrustValence);
  });
});
