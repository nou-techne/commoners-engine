/**
 * M2 Parcel — test suite
 * Sprint: P460
 */

import { latLngToCell } from 'h3-js';
import {
  initParcelState,
  claimParcel,
  startStewardship,
  updateParcelResources,
  succeedParcel,
  abandonParcel,
  getParcel,
  listParcelsByOwner,
  listParcelsByStatus,
  exportParcelSummaries,
  computeParcelHealth,
  ParcelStatus,
  ResourceType,
  DEGRADATION_THRESHOLD,
  RESTORATION_THRESHOLD,
} from '../src/modules/parcel.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PARCEL_ID = latLngToCell(39.95, -105.27, 7);
const AGENT_A   = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const AGENT_B   = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
const NOW       = 1_700_000_000_000;

function makeClaimedParcel() {
  return claimParcel(initParcelState(), PARCEL_ID, AGENT_A, NOW);
}

function makeStewarded() {
  return startStewardship(makeClaimedParcel(), PARCEL_ID, AGENT_A, NOW + 100);
}

// ─── Claim ────────────────────────────────────────────────────────────────────

describe('claimParcel', () => {
  test('parcel moves to Claimed status', () => {
    const ps = makeClaimedParcel();
    expect(getParcel(ps, PARCEL_ID)!.status).toBe(ParcelStatus.Claimed);
  });

  test('ownerId is set', () => {
    const ps = makeClaimedParcel();
    expect(getParcel(ps, PARCEL_ID)!.ownerId).toBe(AGENT_A);
  });

  test('initial resources are non-zero', () => {
    const ps = makeClaimedParcel();
    const { resources } = getParcel(ps, PARCEL_ID)!;
    expect(resources[ResourceType.Water]).toBeGreaterThan(0);
    expect(resources[ResourceType.Soil]).toBeGreaterThan(0);
  });

  test('claimed event is appended', () => {
    const ps = makeClaimedParcel();
    const events = getParcel(ps, PARCEL_ID)!.events;
    expect(events.some(e => e.type === 'claimed')).toBe(true);
  });

  test('history has initial snapshot', () => {
    const ps = makeClaimedParcel();
    expect(getParcel(ps, PARCEL_ID)!.history).toHaveLength(1);
  });

  test('throws if parcel already claimed', () => {
    const ps = makeClaimedParcel();
    expect(() => claimParcel(ps, PARCEL_ID, AGENT_B, NOW + 1)).toThrow(/already claimed/);
  });

  test('state is immutable — original unchanged', () => {
    const empty = initParcelState();
    claimParcel(empty, PARCEL_ID, AGENT_A, NOW);
    expect(empty.parcels.size).toBe(0);
  });
});

// ─── Stewardship ─────────────────────────────────────────────────────────────

describe('startStewardship', () => {
  test('transitions Claimed → Stewarded', () => {
    const ps = makeStewarded();
    expect(getParcel(ps, PARCEL_ID)!.status).toBe(ParcelStatus.Stewarded);
  });

  test('throws on wrong owner', () => {
    const ps = makeClaimedParcel();
    expect(() => startStewardship(ps, PARCEL_ID, AGENT_B)).toThrow(/does not own/);
  });

  test('throws if not in Claimed status', () => {
    const ps = makeStewarded();
    expect(() => startStewardship(ps, PARCEL_ID, AGENT_A)).toThrow(/Cannot start stewardship/);
  });
});

// ─── Resource Updates ─────────────────────────────────────────────────────────

describe('updateParcelResources', () => {
  test('positive delta increases resource', () => {
    const ps = makeStewarded();
    const before = getParcel(ps, PARCEL_ID)!.resources[ResourceType.Water];
    const ps2 = updateParcelResources(ps, PARCEL_ID, AGENT_A,
      { [ResourceType.Water]: 0.1 }, {});
    expect(getParcel(ps2, PARCEL_ID)!.resources[ResourceType.Water]).toBeCloseTo(before + 0.1, 5);
  });

  test('negative delta decreases resource', () => {
    const ps = makeStewarded();
    const before = getParcel(ps, PARCEL_ID)!.resources[ResourceType.Biomass];
    const ps2 = updateParcelResources(ps, PARCEL_ID, AGENT_A,
      { [ResourceType.Biomass]: -0.2 }, {});
    expect(getParcel(ps2, PARCEL_ID)!.resources[ResourceType.Biomass]).toBeCloseTo(before - 0.2, 5);
  });

  test('resource clamped to 0 on over-extraction', () => {
    const ps = makeStewarded();
    const ps2 = updateParcelResources(ps, PARCEL_ID, AGENT_A,
      { [ResourceType.Water]: -10 }, {});
    expect(getParcel(ps2, PARCEL_ID)!.resources[ResourceType.Water]).toBe(0);
  });

  test('resource clamped to 1 on over-restoration', () => {
    const ps = makeStewarded();
    const ps2 = updateParcelResources(ps, PARCEL_ID, AGENT_A,
      { [ResourceType.Soil]: 10 }, {});
    expect(getParcel(ps2, PARCEL_ID)!.resources[ResourceType.Soil]).toBe(1);
  });

  test('resource_updated event appended', () => {
    const ps = makeStewarded();
    const ps2 = updateParcelResources(ps, PARCEL_ID, AGENT_A,
      { [ResourceType.Biomass]: -0.1 }, {});
    expect(getParcel(ps2, PARCEL_ID)!.events.at(-1)?.type).toBe('resource_updated');
  });

  test('history snapshot appended on each update', () => {
    const ps = makeStewarded();
    const ps2 = updateParcelResources(ps, PARCEL_ID, AGENT_A,
      { [ResourceType.Water]: 0.05 }, {});
    expect(getParcel(ps2, PARCEL_ID)!.history.length).toBeGreaterThan(1);
  });
});

// ─── Degradation ─────────────────────────────────────────────────────────────

describe('degradation threshold', () => {
  test('status becomes Degraded when health drops below threshold', () => {
    const ps = makeStewarded();
    // Drive all resources to near-zero
    const ps2 = updateParcelResources(ps, PARCEL_ID, AGENT_A,
      {
        [ResourceType.Water]:        -10,
        [ResourceType.Soil]:         -10,
        [ResourceType.Biodiversity]: -10,
        [ResourceType.Biomass]:      -10,
        [ResourceType.Energy]:       -10,
      }, {});
    expect(getParcel(ps2, PARCEL_ID)!.status).toBe(ParcelStatus.Degraded);
  });

  test('degraded event emitted when crossing threshold', () => {
    const ps = makeStewarded();
    const ps2 = updateParcelResources(ps, PARCEL_ID, AGENT_A,
      { [ResourceType.Water]: -10, [ResourceType.Soil]: -10,
        [ResourceType.Biodiversity]: -10, [ResourceType.Biomass]: -10,
        [ResourceType.Energy]: -10 }, {});
    expect(getParcel(ps2, PARCEL_ID)!.events.some(e => e.type === 'degraded')).toBe(true);
  });

  test('status becomes Restored when health rises above restoration threshold', () => {
    const ps = makeStewarded();
    // First degrade
    const degraded = updateParcelResources(ps, PARCEL_ID, AGENT_A,
      { [ResourceType.Water]: -10, [ResourceType.Soil]: -10,
        [ResourceType.Biodiversity]: -10, [ResourceType.Biomass]: -10,
        [ResourceType.Energy]: -10 }, {});
    expect(getParcel(degraded, PARCEL_ID)!.status).toBe(ParcelStatus.Degraded);
    // Then restore
    const restored = updateParcelResources(degraded, PARCEL_ID, AGENT_A,
      { [ResourceType.Water]: 10, [ResourceType.Soil]: 10,
        [ResourceType.Biodiversity]: 10, [ResourceType.Biomass]: 10,
        [ResourceType.Energy]: 10 }, {});
    expect(getParcel(restored, PARCEL_ID)!.status).toBe(ParcelStatus.Restored);
  });

  test('restored event emitted when crossing restoration threshold', () => {
    const ps = makeStewarded();
    const degraded = updateParcelResources(ps, PARCEL_ID, AGENT_A,
      { [ResourceType.Water]: -10, [ResourceType.Soil]: -10,
        [ResourceType.Biodiversity]: -10, [ResourceType.Biomass]: -10,
        [ResourceType.Energy]: -10 }, {});
    const restored = updateParcelResources(degraded, PARCEL_ID, AGENT_A,
      { [ResourceType.Water]: 10, [ResourceType.Soil]: 10,
        [ResourceType.Biodiversity]: 10, [ResourceType.Biomass]: 10,
        [ResourceType.Energy]: 10 }, {});
    expect(getParcel(restored, PARCEL_ID)!.events.some(e => e.type === 'restored')).toBe(true);
  });
});

// ─── Succession ───────────────────────────────────────────────────────────────

describe('succeedParcel', () => {
  test('transfers ownership to new agent', () => {
    const ps = makeStewarded();
    const ps2 = succeedParcel(ps, PARCEL_ID, AGENT_A, AGENT_B);
    expect(getParcel(ps2, PARCEL_ID)!.ownerId).toBe(AGENT_B);
  });

  test('status preserved after succession', () => {
    const ps = makeStewarded();
    const ps2 = succeedParcel(ps, PARCEL_ID, AGENT_A, AGENT_B);
    expect(getParcel(ps2, PARCEL_ID)!.status).toBe(ParcelStatus.Stewarded);
  });

  test('succession event appended', () => {
    const ps = makeStewarded();
    const ps2 = succeedParcel(ps, PARCEL_ID, AGENT_A, AGENT_B);
    const ev = getParcel(ps2, PARCEL_ID)!.events.find(e => e.type === 'succession');
    expect(ev).toBeDefined();
    expect(ev!.payload['toAgentId']).toBe(AGENT_B);
  });

  test('throws if wrong owner initiates succession', () => {
    const ps = makeStewarded();
    expect(() => succeedParcel(ps, PARCEL_ID, AGENT_B, AGENT_A)).toThrow(/does not own/);
  });
});

// ─── Abandon ─────────────────────────────────────────────────────────────────

describe('abandonParcel', () => {
  test('status returns to Vacant', () => {
    const ps = makeStewarded();
    const ps2 = abandonParcel(ps, PARCEL_ID, AGENT_A);
    expect(getParcel(ps2, PARCEL_ID)!.status).toBe(ParcelStatus.Vacant);
  });

  test('ownerId becomes null', () => {
    const ps = makeStewarded();
    const ps2 = abandonParcel(ps, PARCEL_ID, AGENT_A);
    expect(getParcel(ps2, PARCEL_ID)!.ownerId).toBeNull();
  });

  test('abandoned event appended', () => {
    const ps = makeStewarded();
    const ps2 = abandonParcel(ps, PARCEL_ID, AGENT_A);
    expect(getParcel(ps2, PARCEL_ID)!.events.some(e => e.type === 'abandoned')).toBe(true);
  });

  test('throws if wrong agent abandons', () => {
    const ps = makeStewarded();
    expect(() => abandonParcel(ps, PARCEL_ID, AGENT_B)).toThrow(/does not own/);
  });
});

// ─── Queries ─────────────────────────────────────────────────────────────────

describe('queries', () => {
  test('listParcelsByOwner returns correct parcels', () => {
    const parcel2 = latLngToCell(40.0, -105.3, 7);
    let ps = initParcelState();
    ps = claimParcel(ps, PARCEL_ID, AGENT_A, NOW);
    ps = claimParcel(ps, parcel2, AGENT_B, NOW + 1);
    expect(listParcelsByOwner(ps, AGENT_A)).toHaveLength(1);
    expect(listParcelsByOwner(ps, AGENT_B)).toHaveLength(1);
    expect(listParcelsByOwner(ps, '0xUnknown')).toHaveLength(0);
  });

  test('listParcelsByStatus filters correctly', () => {
    let ps = makeClaimedParcel();
    ps = startStewardship(ps, PARCEL_ID, AGENT_A, NOW + 100);
    expect(listParcelsByStatus(ps, ParcelStatus.Stewarded)).toHaveLength(1);
    expect(listParcelsByStatus(ps, ParcelStatus.Claimed)).toHaveLength(0);
  });

  test('exportParcelSummaries is JSON-serializable', () => {
    const ps = makeStewarded();
    const summaries = exportParcelSummaries(ps);
    expect(() => JSON.stringify(summaries)).not.toThrow();
    expect(summaries[0].health).toBeGreaterThan(0);
  });
});

// ─── Health ───────────────────────────────────────────────────────────────────

describe('computeParcelHealth', () => {
  test('all-1 resources return health of 1', () => {
    const full = Object.fromEntries(
      Object.values(ResourceType).map(rt => [rt, 1])
    ) as Record<ResourceType, number>;
    expect(computeParcelHealth(full)).toBeCloseTo(1, 5);
  });

  test('all-0 resources return health of 0', () => {
    const empty = Object.fromEntries(
      Object.values(ResourceType).map(rt => [rt, 0])
    ) as Record<ResourceType, number>;
    expect(computeParcelHealth(empty)).toBeCloseTo(0, 5);
  });

  test('water has highest weight', () => {
    const onlyWater = Object.fromEntries(
      Object.values(ResourceType).map(rt => [rt, rt === ResourceType.Water ? 1 : 0])
    ) as Record<ResourceType, number>;
    const onlyEnergy = Object.fromEntries(
      Object.values(ResourceType).map(rt => [rt, rt === ResourceType.Energy ? 1 : 0])
    ) as Record<ResourceType, number>;
    expect(computeParcelHealth(onlyWater)).toBeGreaterThan(computeParcelHealth(onlyEnergy));
  });
});
