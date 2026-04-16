/**
 * M1 Substrate — test suite
 * Sprint: P459
 */

import { latLngToCell } from 'h3-js';
import {
  initSubstrate,
  addCell,
  getCell,
  updateConstraints,
  decayConstraints,
  decayAll,
  getBasinCells,
  exportSnapshot,
  southBoulderCreekSeedCell,
  computeHealth,
  DEFAULT_RESOLUTION,
} from '../src/modules/substrate.js';
import { BiomeType } from '../src/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SEED_CELL = southBoulderCreekSeedCell(DEFAULT_RESOLUTION);
const NOW = 1_700_000_000_000;

function makeSingleCellSubstrate(biome: BiomeType = BiomeType.Forest) {
  return initSubstrate({
    seedCells: [{ cellId: SEED_CELL, biomeType: biome }],
    now: NOW,
  });
}

// ─── Initialization ───────────────────────────────────────────────────────────

describe('initSubstrate', () => {
  test('empty substrate has no cells', () => {
    const s = initSubstrate();
    expect(s.cells.size).toBe(0);
    expect(s.resolution).toBe(DEFAULT_RESOLUTION);
  });

  test('seeded substrate has exactly the seeded cells', () => {
    const s = makeSingleCellSubstrate();
    expect(s.cells.size).toBe(1);
    expect(s.cells.has(SEED_CELL)).toBe(true);
  });

  test('cell inherits biome defaults', () => {
    const s = makeSingleCellSubstrate(BiomeType.Forest);
    const cell = getCell(s, SEED_CELL)!;
    expect(cell.biomeType).toBe(BiomeType.Forest);
    expect(cell.constraints.ecological).toBeGreaterThan(0.7);
    expect(cell.constraints.hydrological).toBeGreaterThan(0.6);
  });

  test('overrides blend with biome defaults', () => {
    const s = initSubstrate({
      seedCells: [{ cellId: SEED_CELL, biomeType: BiomeType.Wetland, constraints: { hydrological: -0.5 } }],
    });
    const cell = getCell(s, SEED_CELL)!;
    // Wetland hydrological base is 0.9; subtract 0.5 -> 0.4
    expect(cell.constraints.hydrological).toBeCloseTo(0.4, 5);
  });

  test('wrong-resolution seed cell throws', () => {
    const wrongResCell = latLngToCell(39.95, -105.27, 5); // resolution 5, not 7
    expect(() =>
      initSubstrate({ resolution: 7, seedCells: [{ cellId: wrongResCell }] })
    ).toThrow(/resolution mismatch/);
  });

  test('all constraint values are clamped to [0, 1]', () => {
    const s = initSubstrate({
      seedCells: [{ cellId: SEED_CELL, biomeType: BiomeType.Arid, constraints: { hydrological: 5 } }],
    });
    const { constraints } = getCell(s, SEED_CELL)!;
    expect(constraints.hydrological).toBe(1);
  });
});

// ─── Cell CRUD ────────────────────────────────────────────────────────────────

describe('addCell', () => {
  test('adds a new cell', () => {
    const empty = initSubstrate({ now: NOW });
    const s = addCell(empty, SEED_CELL, BiomeType.Riparian, undefined, NOW);
    expect(s.cells.size).toBe(1);
    expect(getCell(s, SEED_CELL)?.biomeType).toBe(BiomeType.Riparian);
  });

  test('throws on duplicate cell', () => {
    const s = makeSingleCellSubstrate();
    expect(() => addCell(s, SEED_CELL)).toThrow(/already exists/);
  });
});

describe('getCell', () => {
  test('returns undefined for missing cell', () => {
    const s = initSubstrate();
    expect(getCell(s, SEED_CELL)).toBeUndefined();
  });

  test('returns cell data', () => {
    const s = makeSingleCellSubstrate(BiomeType.Grassland);
    const cell = getCell(s, SEED_CELL);
    expect(cell).not.toBeUndefined();
    expect(cell!.cellId).toBe(SEED_CELL);
  });
});

// ─── Constraint Updates ───────────────────────────────────────────────────────

describe('updateConstraints', () => {
  test('applies positive delta (restoration)', () => {
    const s = initSubstrate({
      seedCells: [{ cellId: SEED_CELL, biomeType: BiomeType.Arid }],
      now: NOW,
    });
    const before = getCell(s, SEED_CELL)!.constraints.hydrological;
    const s2 = updateConstraints(s, SEED_CELL, { hydrological: 0.1 }, NOW + 1000);
    const after = getCell(s2, SEED_CELL)!.constraints.hydrological;
    expect(after).toBeCloseTo(before + 0.1, 5);
  });

  test('applies negative delta (extraction)', () => {
    const s = makeSingleCellSubstrate(BiomeType.Forest);
    const before = getCell(s, SEED_CELL)!.constraints.pedological;
    const s2 = updateConstraints(s, SEED_CELL, { pedological: -0.2 });
    expect(getCell(s2, SEED_CELL)!.constraints.pedological).toBeCloseTo(before - 0.2, 5);
  });

  test('clamps to 0 on over-extraction', () => {
    const s = makeSingleCellSubstrate(BiomeType.Arid);
    const s2 = updateConstraints(s, SEED_CELL, { hydrological: -10 });
    expect(getCell(s2, SEED_CELL)!.constraints.hydrological).toBe(0);
  });

  test('clamps to 1 on over-restoration', () => {
    const s = makeSingleCellSubstrate(BiomeType.Wetland);
    const s2 = updateConstraints(s, SEED_CELL, { ecological: 10 });
    expect(getCell(s2, SEED_CELL)!.constraints.ecological).toBe(1);
  });

  test('unspecified dimensions are unchanged', () => {
    const s = makeSingleCellSubstrate(BiomeType.Forest);
    const before = getCell(s, SEED_CELL)!.constraints;
    const s2 = updateConstraints(s, SEED_CELL, { hydrological: 0.05 });
    const after = getCell(s2, SEED_CELL)!.constraints;
    expect(after.pedological).toBe(before.pedological);
    expect(after.ecological).toBe(before.ecological);
  });

  test('throws on missing cell', () => {
    const s = initSubstrate();
    expect(() => updateConstraints(s, SEED_CELL, { hydrological: 0.1 })).toThrow(/not found/);
  });

  test('substrate is immutable — original unchanged', () => {
    const s = makeSingleCellSubstrate(BiomeType.Forest);
    const before = getCell(s, SEED_CELL)!.constraints.hydrological;
    const s2 = updateConstraints(s, SEED_CELL, { hydrological: -0.5 });
    // Original state unchanged
    expect(getCell(s, SEED_CELL)!.constraints.hydrological).toBe(before);
    // New state has update
    expect(getCell(s2, SEED_CELL)!.constraints.hydrological).toBeCloseTo(before - 0.5, 5);
  });
});

// ─── Decay ────────────────────────────────────────────────────────────────────

describe('decayConstraints', () => {
  test('reduces constraint values over time', () => {
    const s = makeSingleCellSubstrate(BiomeType.Forest);
    const before = getCell(s, SEED_CELL)!.constraints.hydrological;
    const s2 = decayConstraints(s, SEED_CELL, 24); // 24 hours
    const after = getCell(s2, SEED_CELL)!.constraints.hydrological;
    expect(after).toBeLessThan(before);
  });

  test('zero dt produces no change', () => {
    const s = makeSingleCellSubstrate(BiomeType.Forest);
    const before = getCell(s, SEED_CELL)!.constraints;
    const s2 = decayConstraints(s, SEED_CELL, 0);
    const after = getCell(s2, SEED_CELL)!.constraints;
    expect(after).toEqual(before);
  });

  test('cannot decay below 0', () => {
    const s = initSubstrate({
      seedCells: [{ cellId: SEED_CELL, biomeType: BiomeType.Arid, constraints: { hydrological: -0.24 } }],
    });
    const s2 = decayConstraints(s, SEED_CELL, 10000);
    expect(getCell(s2, SEED_CELL)!.constraints.hydrological).toBe(0);
  });

  test('pedological decays slower than demographic', () => {
    const s = makeSingleCellSubstrate(BiomeType.Grassland);
    const s2 = decayConstraints(s, SEED_CELL, 100);
    const c = getCell(s2, SEED_CELL)!.constraints;
    const c0 = getCell(s, SEED_CELL)!.constraints;
    const pedoDelta = c0.pedological - c.pedological;
    const demoDelta = c0.demographic - c.demographic;
    expect(pedoDelta).toBeLessThan(demoDelta);
  });
});

describe('decayAll', () => {
  test('decays all cells', () => {
    const cell2 = latLngToCell(40.0, -105.3, DEFAULT_RESOLUTION);
    let s = initSubstrate({
      seedCells: [
        { cellId: SEED_CELL, biomeType: BiomeType.Forest },
        { cellId: cell2,     biomeType: BiomeType.Arid   },
      ],
      now: NOW,
    });
    const beforeHydro1 = getCell(s, SEED_CELL)!.constraints.hydrological;
    const beforeHydro2 = getCell(s, cell2)!.constraints.hydrological;
    s = decayAll(s, 24);
    expect(getCell(s, SEED_CELL)!.constraints.hydrological).toBeLessThan(beforeHydro1);
    expect(getCell(s, cell2)!.constraints.hydrological).toBeLessThan(beforeHydro2);
  });
});

// ─── Basin Integration ────────────────────────────────────────────────────────

describe('getBasinCells', () => {
  test('returns cells within ring radius', () => {
    // Seed a disk of cells around the seed cell
    const disk = [SEED_CELL];
    // Can't get H3 neighbours without h3-js gridDisk, but we can test with just the center
    const s = makeSingleCellSubstrate();
    const basin = getBasinCells(s, SEED_CELL, 3);
    expect(basin.length).toBe(1); // only SEED_CELL is in the substrate
    expect(basin[0].cellId).toBe(SEED_CELL);
  });

  test('returns empty array when no substrate cells overlap disk', () => {
    const s = initSubstrate(); // empty
    const basin = getBasinCells(s, SEED_CELL, 2);
    expect(basin).toHaveLength(0);
  });
});

// ─── Snapshot Export ─────────────────────────────────────────────────────────

describe('exportSnapshot', () => {
  test('snapshot contains all cells', () => {
    const s = makeSingleCellSubstrate(BiomeType.Wetland);
    const snap = exportSnapshot(s);
    expect(snap.cellCount).toBe(1);
    expect(snap.cells[0].cellId).toBe(SEED_CELL);
  });

  test('snapshot health is between 0 and 1', () => {
    const s = makeSingleCellSubstrate(BiomeType.Forest);
    const snap = exportSnapshot(s);
    expect(snap.cells[0].health).toBeGreaterThan(0);
    expect(snap.cells[0].health).toBeLessThanOrEqual(1);
  });

  test('snapshot is serializable (no Maps)', () => {
    const s = makeSingleCellSubstrate();
    const snap = exportSnapshot(s);
    expect(() => JSON.stringify(snap)).not.toThrow();
  });

  test('snapshot resolution matches substrate', () => {
    const s = makeSingleCellSubstrate();
    expect(exportSnapshot(s).resolution).toBe(DEFAULT_RESOLUTION);
  });
});

// ─── Cross-Platform Determinism (PRD M1 must-have) ───────────────────────────
// H3 cell IDs and constraint math must produce identical results regardless of
// platform (Linux / macOS / browser). If H3 or float arithmetic were
// platform-sensitive, two agents on different hosts would see different world state.

describe('determinism', () => {
  test('same seed cell from same lat/lng on every call', () => {
    const a = southBoulderCreekSeedCell(DEFAULT_RESOLUTION);
    const b = southBoulderCreekSeedCell(DEFAULT_RESOLUTION);
    expect(a).toBe(b);
  });

  test('initSubstrate with same inputs produces identical constraint values', () => {
    const opts = { seedCells: [{ cellId: SEED_CELL, biomeType: BiomeType.Wetland }], now: NOW };
    const s1 = initSubstrate(opts);
    const s2 = initSubstrate(opts);
    expect(getCell(s1, SEED_CELL)!.constraints).toEqual(getCell(s2, SEED_CELL)!.constraints);
  });

  test('updateConstraints produces identical values given same delta', () => {
    const s = makeSingleCellSubstrate(BiomeType.Grassland);
    const delta = { hydrological: 0.13, pedological: -0.07 };
    const s1 = updateConstraints(s, SEED_CELL, delta, NOW + 1000);
    const s2 = updateConstraints(s, SEED_CELL, delta, NOW + 1000);
    expect(getCell(s1, SEED_CELL)!.constraints).toEqual(getCell(s2, SEED_CELL)!.constraints);
  });

  test('decayConstraints deterministic over same dt', () => {
    const s = makeSingleCellSubstrate(BiomeType.Forest);
    const s1 = decayConstraints(s, SEED_CELL, 48, NOW + 100);
    const s2 = decayConstraints(s, SEED_CELL, 48, NOW + 100);
    expect(getCell(s1, SEED_CELL)!.constraints).toEqual(getCell(s2, SEED_CELL)!.constraints);
  });

  test('exportSnapshot JSON is stable (same snapshot twice)', () => {
    const s = makeSingleCellSubstrate(BiomeType.Riparian);
    const snap1 = exportSnapshot(s);
    const snap2 = exportSnapshot(s);
    // snapshotAt may differ by a ms — compare cells only
    expect(snap1.cells).toEqual(snap2.cells);
    expect(snap1.resolution).toBe(snap2.resolution);
  });
});

// ─── Health Computation ───────────────────────────────────────────────────────

describe('computeHealth', () => {
  test('perfect health returns 1', () => {
    const perfect: import('../src/types.js').ConstraintParams = {
      thermodynamic: 1, hydrological: 1, pedological: 1,
      ecological: 1, demographic: 1, temporal: 1,
    };
    expect(computeHealth(perfect)).toBeCloseTo(1, 5);
  });

  test('collapsed returns 0', () => {
    const collapsed: import('../src/types.js').ConstraintParams = {
      thermodynamic: 0, hydrological: 0, pedological: 0,
      ecological: 0, demographic: 0, temporal: 0,
    };
    expect(computeHealth(collapsed)).toBeCloseTo(0, 5);
  });

  test('hydrological is highest-weight constraint', () => {
    const highHydro: import('../src/types.js').ConstraintParams = {
      thermodynamic: 0, hydrological: 1, pedological: 0,
      ecological: 0, demographic: 0, temporal: 0,
    };
    const highThermo: import('../src/types.js').ConstraintParams = {
      thermodynamic: 1, hydrological: 0, pedological: 0,
      ecological: 0, demographic: 0, temporal: 0,
    };
    expect(computeHealth(highHydro)).toBeGreaterThan(computeHealth(highThermo));
  });
});
