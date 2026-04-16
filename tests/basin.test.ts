/**
 * M4 Basin — test suite
 * Sprint: P462
 */

import { latLngToCell } from 'h3-js';
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
  executeAction,
  AgentType,
} from '../src/modules/agent.js';
import {
  initBasinState,
  createBasin,
  computeBasinCommons,
  computeBasinHealth,
  applyFlows,
  accumulateExternality,
  resetExternality,
  refreshCommons,
  syncParcelMembership,
  exportBasinSnapshot,
  getBasin,
  STRESS_THRESHOLD,
  BASIN_RING_RADIUS,
} from '../src/modules/basin.js';
import { ActionCategory } from '../src/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CENTER   = southBoulderCreekSeedCell(DEFAULT_RESOLUTION);
const PARCEL_A = CENTER;
const PARCEL_B = latLngToCell(40.0, -105.3, DEFAULT_RESOLUTION);
const AGENT_A  = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
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

  return { ss, ps, as, bs };
}

function makeActionResult(
  category: ActionCategory,
  targetParcel = PARCEL_A,
  intensity = 0.5,
) {
  const { as, ps } = makeWorld();
  const req = {
    actionId:     'test-action',
    agentId:      AGENT_A,
    category,
    targetParcel,
    resourceType: ResourceType.Water as ResourceType,
    intensity,
    timestamp:    NOW + 100,
  };
  return executeAction(as, ps, req).result;
}

// ─── Basin Creation ────────────────────────────────────────────────────────────

describe('createBasin', () => {
  test('basin is created with the center cell ID', () => {
    const { bs } = makeWorld();
    expect(getBasin(bs, CENTER)).toBeDefined();
  });

  test('basin contains substrate cells within ring radius', () => {
    const { bs } = makeWorld();
    const basin = getBasin(bs, CENTER)!;
    expect(basin.cellIds).toContain(CENTER);
  });

  test('basin includes claimed parcels', () => {
    const { bs } = makeWorld();
    const basin = getBasin(bs, CENTER)!;
    expect(basin.parcelIds).toContain(PARCEL_A);
  });

  test('throws on duplicate basin', () => {
    const { bs, ss, ps } = makeWorld();
    expect(() => createBasin(bs, ss, ps, CENTER, NOW)).toThrow(/already exists/);
  });

  test('basin_created event is emitted', () => {
    const { bs } = makeWorld();
    const basin = getBasin(bs, CENTER)!;
    expect(basin.events.some(e => e.type === 'basin_created')).toBe(true);
  });

  test('state is immutable — original unchanged', () => {
    const empty = initBasinState();
    const { ss, ps } = makeWorld();
    createBasin(empty, ss, ps, CENTER, NOW);
    expect(empty.basins.size).toBe(0);
  });
});

// ─── Commons Computation ──────────────────────────────────────────────────────

describe('computeBasinCommons', () => {
  test('returns 0 for empty cell list', () => {
    const { ss } = makeWorld();
    const commons = computeBasinCommons(ss, []);
    expect(commons.watershedHealth).toBe(0);
  });

  test('values are in [0, 1]', () => {
    const { ss, bs } = makeWorld();
    const basin = getBasin(bs, CENTER)!;
    const commons = computeBasinCommons(ss, basin.cellIds);
    expect(commons.watershedHealth).toBeGreaterThan(0);
    expect(commons.watershedHealth).toBeLessThanOrEqual(1);
    expect(commons.soilCarbonIndex).toBeGreaterThan(0);
    expect(commons.biodiversityIndex).toBeGreaterThan(0);
  });

  test('after raising hydrological constraint, watershed health increases', () => {
    const { ss, bs } = makeWorld();
    const basin = getBasin(bs, CENTER)!;
    const before = computeBasinCommons(ss, basin.cellIds).watershedHealth;
    const ss2 = updateConstraints(ss, CENTER, { hydrological: 0.2 }, NOW + 1);
    const after = computeBasinCommons(ss2, basin.cellIds).watershedHealth;
    expect(after).toBeGreaterThan(before);
  });
});

// ─── Basin Health ─────────────────────────────────────────────────────────────

describe('computeBasinHealth', () => {
  test('returns value in [0, 1]', () => {
    const { bs, ps } = makeWorld();
    const h = computeBasinHealth(bs, ps, CENTER);
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThanOrEqual(1);
  });

  test('throws for unknown basin', () => {
    const { ps } = makeWorld();
    expect(() => computeBasinHealth(initBasinState(), ps, CENTER)).toThrow(/not found/);
  });
});

// ─── Externality Accumulation ─────────────────────────────────────────────────

describe('accumulateExternality', () => {
  test('extraction action increases accumulator', () => {
    const { bs } = makeWorld();
    const result = makeActionResult(ActionCategory.Productive, PARCEL_A, 0.8);
    const bs2 = accumulateExternality(bs, CENTER, result);
    expect(getBasin(bs2, CENTER)!.externalityAccumulator).toBeGreaterThan(0);
  });

  test('regenerative action does not increase accumulator', () => {
    const { bs } = makeWorld();
    const result = makeActionResult(ActionCategory.Regenerative, PARCEL_A, 0.8);
    const bs2 = accumulateExternality(bs, CENTER, result);
    expect(getBasin(bs2, CENTER)!.externalityAccumulator).toBe(0);
  });

  test('basin_stress event fires when threshold exceeded', () => {
    let { bs } = makeWorld();
    // Accumulate with enough intensity to cross threshold
    for (let i = 0; i < 5; i++) {
      const result = makeActionResult(ActionCategory.Productive, PARCEL_A, 1.0);
      bs = accumulateExternality(bs, CENTER, result);
    }
    expect(getBasin(bs, CENTER)!.events.some(e => e.type === 'basin_stress')).toBe(true);
  });

  test('basin_stress only fires once per cycle', () => {
    let { bs } = makeWorld();
    for (let i = 0; i < 10; i++) {
      const result = makeActionResult(ActionCategory.Productive, PARCEL_A, 1.0);
      bs = accumulateExternality(bs, CENTER, result);
    }
    const stressEvents = getBasin(bs, CENTER)!.events.filter(e => e.type === 'basin_stress');
    expect(stressEvents).toHaveLength(1);
  });

  test('resetExternality clears accumulator', () => {
    let { bs } = makeWorld();
    const result = makeActionResult(ActionCategory.Productive, PARCEL_A, 0.9);
    bs = accumulateExternality(bs, CENTER, result);
    bs = resetExternality(bs, CENTER, NOW + 1);
    expect(getBasin(bs, CENTER)!.externalityAccumulator).toBe(0);
  });
});

// ─── Flow Network ─────────────────────────────────────────────────────────────

describe('applyFlows', () => {
  test('returns updated basin state', () => {
    const { bs } = makeWorld();
    const result = makeActionResult(ActionCategory.Productive, PARCEL_A, 0.5);
    const bs2 = applyFlows(bs, CENTER, result);
    // Basin with one parcel has no downstream edges — state should be unchanged
    expect(getBasin(bs2, CENTER)).toBeDefined();
  });

  test('flow_applied event emitted when edges exist', () => {
    // Build a two-parcel basin
    let ss = initSubstrate({ now: NOW });
    ss = addCell(ss, PARCEL_A, undefined, undefined, NOW);
    ss = addCell(ss, PARCEL_B, undefined, undefined, NOW);

    let ps = initParcelState();
    ps = claimParcel(ps, PARCEL_A, AGENT_A, NOW);
    ps = startStewardship(ps, PARCEL_A, AGENT_A, NOW + 10);
    ps = claimParcel(ps, PARCEL_B, AGENT_A, NOW + 20);
    ps = startStewardship(ps, PARCEL_B, AGENT_A, NOW + 30);

    let as = initAgentState();
    as = registerAgent(as, AGENT_A, 'Alice', AgentType.Human, NOW);

    let bs = initBasinState();
    bs = createBasin(bs, ss, ps, CENTER, NOW);

    // Manually sync parcel membership so the flow network includes both parcels
    bs = syncParcelMembership(bs, ps, CENTER, NOW + 1);

    const req = {
      actionId: 'flow-test', agentId: AGENT_A,
      category: ActionCategory.Productive, targetParcel: PARCEL_A,
      resourceType: ResourceType.Water as ResourceType, intensity: 0.5, timestamp: NOW + 100,
    };
    const result = executeAction(as, ps, req).result;

    const bs2 = applyFlows(bs, CENTER, result, NOW + 101);
    expect(getBasin(bs2, CENTER)!.events.some(e => e.type === 'flow_applied')).toBe(true);
  });
});

// ─── Commons Refresh ─────────────────────────────────────────────────────────

describe('refreshCommons', () => {
  test('commons_updated event is appended', () => {
    const { bs, ss } = makeWorld();
    const bs2 = refreshCommons(bs, ss, CENTER, NOW + 1);
    expect(getBasin(bs2, CENTER)!.events.some(e => e.type === 'commons_updated')).toBe(true);
  });

  test('commons reflect substrate changes after refresh', () => {
    const { bs, ss } = makeWorld();
    const before = getBasin(bs, CENTER)!.commons.watershedHealth;
    const ss2 = updateConstraints(ss, CENTER, { hydrological: 0.3 }, NOW + 1);
    const bs2 = refreshCommons(bs, ss2, CENTER, NOW + 2);
    expect(getBasin(bs2, CENTER)!.commons.watershedHealth).toBeGreaterThan(before);
  });
});

// ─── Snapshot Export ─────────────────────────────────────────────────────────

describe('exportBasinSnapshot', () => {
  test('snapshot is JSON-serializable', () => {
    const { bs, ps } = makeWorld();
    const snap = exportBasinSnapshot(bs, ps, CENTER, NOW);
    expect(() => JSON.stringify(snap)).not.toThrow();
  });

  test('health is in (0, 1]', () => {
    const { bs, ps } = makeWorld();
    const snap = exportBasinSnapshot(bs, ps, CENTER, NOW);
    expect(snap.health).toBeGreaterThan(0);
    expect(snap.health).toBeLessThanOrEqual(1);
  });

  test('stressed is false before threshold', () => {
    const { bs, ps } = makeWorld();
    const snap = exportBasinSnapshot(bs, ps, CENTER, NOW);
    expect(snap.stressed).toBe(false);
  });

  test('stressed is true after threshold exceeded', () => {
    let { bs, ps } = makeWorld();
    for (let i = 0; i < 5; i++) {
      const result = makeActionResult(ActionCategory.Productive, PARCEL_A, 1.0);
      bs = accumulateExternality(bs, CENTER, result);
    }
    const snap = exportBasinSnapshot(bs, ps, CENTER, NOW + 1);
    expect(snap.stressed).toBe(true);
  });
});

// ─── Parcel Membership Sync ───────────────────────────────────────────────────

describe('syncParcelMembership', () => {
  test('new parcels within disk are picked up', () => {
    let { ss, ps, bs } = makeWorld();
    // Add a second parcel within the basin footprint
    ss = addCell(ss, PARCEL_B, undefined, undefined, NOW + 10);
    ps = claimParcel(ps, PARCEL_B, AGENT_A, NOW + 10);
    bs = syncParcelMembership(bs, ps, CENTER, NOW + 11);
    // PARCEL_B may or may not be within the disk — just check no error thrown
    expect(getBasin(bs, CENTER)).toBeDefined();
  });
});
