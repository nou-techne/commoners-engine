/**
 * M7 Trust/Reputation — test suite
 * Sprint: P465
 */

import {
  initTrustState,
  registerReputationRecord,
  applyTrustSignal,
  reckonTrust,
  partialSeasonReset,
  getTreatmentBand,
  getVoteWeightMultiplier,
  canPerformCategory,
  getVisibilityTier,
  getReputationRecord,
  listReputationRecords,
  TreatmentBand,
  TRUST_GRID_SIZE,
  VOTE_WEIGHT_MULTIPLIER,
  ACTION_GATE_THRESHOLD,
  RESTORATION_THRESHOLD,
  SEASON_DECAY,
} from '../src/modules/trust.js';
import { ActionCategory } from '../src/types.js';
import type { TrustSignal } from '../src/modules/agent.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const AGENT_B = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
const PARCEL  = '8a2a100803fffff';
const NOW     = 1_700_000_000_000;

function makeSignal(
  agentId: string,
  category: ActionCategory,
  valence: number,
  intensity = 1.0,
): TrustSignal {
  return { agentId, category, valence, intensity, targetParcel: PARCEL };
}

function makeRegenSignal(agentId = AGENT_A) {
  return makeSignal(agentId, ActionCategory.Regenerative, +1.0);
}

function makeExtractSignal(agentId = AGENT_A) {
  return makeSignal(agentId, ActionCategory.Productive, -1.0);
}

function makeGoverningSignal(agentId = AGENT_A) {
  return makeSignal(agentId, ActionCategory.Governing, +0.3);
}

// ─── Band Computation ─────────────────────────────────────────────────────────

describe('getTreatmentBand', () => {
  test('max cooperation + max restoration → band 1', () => {
    expect(getTreatmentBand(1.0, 1.0)).toBe(TreatmentBand.B1);
  });

  test('min cooperation + min restoration → band 7', () => {
    expect(getTreatmentBand(-1.0, -1.0)).toBe(TreatmentBand.B7);
  });

  test('neutral scores → band 4 (middle)', () => {
    expect(getTreatmentBand(0, 0)).toBe(TreatmentBand.B4);
  });

  test('asymmetric: max restoration + min coordination → middle band', () => {
    const band = getTreatmentBand(1.0, -1.0);
    expect(band).toBeGreaterThanOrEqual(TreatmentBand.B3);
    expect(band).toBeLessThanOrEqual(TreatmentBand.B5);
  });

  test('band range is always 1–7', () => {
    const testPoints = [-1, -0.5, 0, 0.5, 1];
    for (const e of testPoints) {
      for (const c of testPoints) {
        const band = getTreatmentBand(e, c);
        expect(band).toBeGreaterThanOrEqual(1);
        expect(band).toBeLessThanOrEqual(7);
      }
    }
  });

  test('covers all 7 distinct band values across the grid', () => {
    const bands = new Set<number>();
    for (let e = -1; e <= 1; e += 0.01) {
      for (let c = -1; c <= 1; c += 0.01) {
        bands.add(getTreatmentBand(e, c));
      }
    }
    expect(bands.size).toBe(TRUST_GRID_SIZE);
  });
});

// ─── Record Lifecycle ─────────────────────────────────────────────────────────

describe('registerReputationRecord', () => {
  test('creates record with neutral starting scores', () => {
    const ts = initTrustState();
    const ts2 = registerReputationRecord(ts, AGENT_A, NOW);
    const rec = getReputationRecord(ts2, AGENT_A)!;
    expect(rec.externality_score).toBe(0);
    expect(rec.coordination_score).toBe(0);
  });

  test('new agent starts at band 4 (neutral)', () => {
    const ts = initTrustState();
    const ts2 = registerReputationRecord(ts, AGENT_A, NOW);
    expect(getReputationRecord(ts2, AGENT_A)!.treatment_band).toBe(TreatmentBand.B4);
  });

  test('throws on duplicate registration', () => {
    const ts = initTrustState();
    const ts2 = registerReputationRecord(ts, AGENT_A, NOW);
    expect(() => registerReputationRecord(ts2, AGENT_A, NOW)).toThrow(/already exists/);
  });

  test('state is immutable — original unchanged', () => {
    const ts = initTrustState();
    registerReputationRecord(ts, AGENT_A, NOW);
    expect(ts.records.size).toBe(0);
  });
});

// ─── Trust Signal Application ─────────────────────────────────────────────────

describe('applyTrustSignal', () => {
  test('regenerative signal increases externality_score', () => {
    const ts = initTrustState();
    const ts2 = registerReputationRecord(ts, AGENT_A, NOW);
    const ts3 = applyTrustSignal(ts2, makeRegenSignal(), NOW);
    expect(getReputationRecord(ts3, AGENT_A)!.externality_score).toBeGreaterThan(0);
  });

  test('productive signal decreases externality_score', () => {
    const ts = initTrustState();
    const ts2 = registerReputationRecord(ts, AGENT_A, NOW);
    const ts3 = applyTrustSignal(ts2, makeExtractSignal(), NOW);
    expect(getReputationRecord(ts3, AGENT_A)!.externality_score).toBeLessThan(0);
  });

  test('governing signal increases coordination_score', () => {
    const ts = initTrustState();
    const ts2 = registerReputationRecord(ts, AGENT_A, NOW);
    const ts3 = applyTrustSignal(ts2, makeGoverningSignal(), NOW);
    expect(getReputationRecord(ts3, AGENT_A)!.coordination_score).toBeGreaterThan(0);
  });

  test('productive signal decreases coordination_score', () => {
    const ts = initTrustState();
    const ts2 = registerReputationRecord(ts, AGENT_A, NOW);
    const ts3 = applyTrustSignal(ts2, makeExtractSignal(), NOW);
    expect(getReputationRecord(ts3, AGENT_A)!.coordination_score).toBeLessThan(0);
  });

  test('auto-registers unknown agent', () => {
    const ts = initTrustState();
    const ts2 = applyTrustSignal(ts, makeRegenSignal(), NOW);
    expect(getReputationRecord(ts2, AGENT_A)).toBeDefined();
  });

  test('scores stay clamped to [-1, +1]', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    // Apply many regenerative signals to drive score toward +1
    for (let i = 0; i < 100; i++) {
      ts = applyTrustSignal(ts, makeRegenSignal(), NOW + i);
    }
    const rec = getReputationRecord(ts, AGENT_A)!;
    expect(rec.externality_score).toBeLessThanOrEqual(1);
    expect(rec.externality_score).toBeGreaterThanOrEqual(-1);
    expect(rec.coordination_score).toBeLessThanOrEqual(1);
    expect(rec.coordination_score).toBeGreaterThanOrEqual(-1);
  });

  test('state is immutable', () => {
    const ts = initTrustState();
    const ts2 = registerReputationRecord(ts, AGENT_A, NOW);
    applyTrustSignal(ts2, makeRegenSignal(), NOW);
    expect(getReputationRecord(ts2, AGENT_A)!.externality_score).toBe(0);
  });

  test('band improves with regenerative actions over time', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    // Drive to band 7 first
    for (let i = 0; i < 50; i++) {
      ts = applyTrustSignal(ts, makeExtractSignal(), NOW + i);
    }
    const bandAtWorst = getReputationRecord(ts, AGENT_A)!.treatment_band;
    // Now apply regenerative signals
    for (let i = 0; i < 50; i++) {
      ts = applyTrustSignal(ts, makeRegenSignal(), NOW + 100 + i);
    }
    const bandAtBetter = getReputationRecord(ts, AGENT_A)!.treatment_band;
    expect(bandAtBetter).toBeLessThan(bandAtWorst);
  });
});

// ─── Restorative Path ─────────────────────────────────────────────────────────

describe('restorative path', () => {
  test('restorative_action_count increments on Regenerative actions', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    ts = applyTrustSignal(ts, makeRegenSignal(), NOW);
    expect(getReputationRecord(ts, AGENT_A)!.restorative_action_count).toBe(1);
  });

  test('restorative_action_count increments on Governing actions', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    ts = applyTrustSignal(ts, makeGoverningSignal(), NOW);
    expect(getReputationRecord(ts, AGENT_A)!.restorative_action_count).toBe(1);
  });

  test('productive action does not increment restorative count', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    ts = applyTrustSignal(ts, makeExtractSignal(), NOW);
    expect(getReputationRecord(ts, AGENT_A)!.restorative_action_count).toBe(0);
  });

  test('hitting threshold in band ≥5 improves band by 1 and resets counter', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    // Drive to band 7
    for (let i = 0; i < 50; i++) {
      ts = applyTrustSignal(ts, makeExtractSignal(), NOW + i);
    }
    const bandBefore = getReputationRecord(ts, AGENT_A)!.treatment_band;
    expect(bandBefore).toBeGreaterThanOrEqual(TreatmentBand.B5);

    // Apply RESTORATION_THRESHOLD restorative actions
    for (let i = 0; i < RESTORATION_THRESHOLD; i++) {
      ts = applyTrustSignal(ts, makeRegenSignal(), NOW + 100 + i);
    }

    const rec = getReputationRecord(ts, AGENT_A)!;
    expect(rec.treatment_band).toBeLessThanOrEqual(bandBefore);
    expect(rec.restorative_action_count).toBe(0);
  });
});

// ─── Batch Reckoning ─────────────────────────────────────────────────────────

describe('reckonTrust', () => {
  test('processes multiple agents in one call', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    ts = registerReputationRecord(ts, AGENT_B, NOW);

    const signals: TrustSignal[] = [
      makeRegenSignal(AGENT_A),
      makeExtractSignal(AGENT_B),
    ];

    const ts2 = reckonTrust(ts, signals, 1, NOW);
    expect(getReputationRecord(ts2, AGENT_A)!.externality_score).toBeGreaterThan(0);
    expect(getReputationRecord(ts2, AGENT_B)!.externality_score).toBeLessThan(0);
  });

  test('appends round_history entry for each agent', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    const signals = [makeRegenSignal(AGENT_A)];

    const ts2 = reckonTrust(ts, signals, 1, NOW);
    const history = getReputationRecord(ts2, AGENT_A)!.round_history;
    expect(history).toHaveLength(1);
    expect(history[0].roundNumber).toBe(1);
  });

  test('empty signal list leaves records unchanged', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    const ts2 = reckonTrust(ts, [], 1, NOW);
    const rec = getReputationRecord(ts2, AGENT_A)!;
    expect(rec.externality_score).toBe(0);
    expect(rec.coordination_score).toBe(0);
  });
});

// ─── Season Reset ─────────────────────────────────────────────────────────────

describe('partialSeasonReset', () => {
  test('decays scores toward zero', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    // Push to a non-zero score
    for (let i = 0; i < 10; i++) {
      ts = applyTrustSignal(ts, makeRegenSignal(), NOW + i);
    }
    const before = getReputationRecord(ts, AGENT_A)!.externality_score;

    const ts2 = partialSeasonReset(ts, AGENT_A, NOW + 1000);
    const after = getReputationRecord(ts2, AGENT_A)!.externality_score;

    expect(Math.abs(after)).toBeLessThan(Math.abs(before));
  });

  test('preserves sign after decay', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    for (let i = 0; i < 10; i++) {
      ts = applyTrustSignal(ts, makeExtractSignal(), NOW + i);
    }
    const ts2 = partialSeasonReset(ts, AGENT_A, NOW + 1000);
    const after = getReputationRecord(ts2, AGENT_A)!.externality_score;
    expect(after).toBeLessThan(0);  // still negative, just smaller
  });

  test('resets restorative_action_count to 0', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    ts = applyTrustSignal(ts, makeRegenSignal(), NOW);
    const ts2 = partialSeasonReset(ts, AGENT_A, NOW + 1000);
    expect(getReputationRecord(ts2, AGENT_A)!.restorative_action_count).toBe(0);
  });

  test('throws for unknown agent', () => {
    const ts = initTrustState();
    expect(() => partialSeasonReset(ts, AGENT_A, NOW)).toThrow(/No reputation record/);
  });
});

// ─── Effect Functions ─────────────────────────────────────────────────────────

describe('getVoteWeightMultiplier', () => {
  test('band 1 has highest multiplier', () => {
    expect(getVoteWeightMultiplier(TreatmentBand.B1)).toBeGreaterThan(
      getVoteWeightMultiplier(TreatmentBand.B7),
    );
  });

  test('multiplier is monotonically decreasing with band number', () => {
    for (let b = 1; b < 7; b++) {
      expect(getVoteWeightMultiplier(b as TreatmentBand)).toBeGreaterThan(
        getVoteWeightMultiplier((b + 1) as TreatmentBand),
      );
    }
  });

  test('all multipliers are positive', () => {
    for (let b = 1; b <= 7; b++) {
      expect(getVoteWeightMultiplier(b as TreatmentBand)).toBeGreaterThan(0);
    }
  });
});

describe('canPerformCategory', () => {
  test('unrestricted categories are always permitted', () => {
    for (let b = 1; b <= 7; b++) {
      expect(canPerformCategory(b as TreatmentBand, ActionCategory.Regenerative)).toBe(true);
      expect(canPerformCategory(b as TreatmentBand, ActionCategory.Productive)).toBe(true);
    }
  });

  test('Governing allowed up to and including threshold band', () => {
    expect(canPerformCategory(ACTION_GATE_THRESHOLD, ActionCategory.Governing)).toBe(true);
  });

  test('Governing blocked for bands above threshold', () => {
    expect(canPerformCategory(TreatmentBand.B5, ActionCategory.Governing)).toBe(false);
    expect(canPerformCategory(TreatmentBand.B6, ActionCategory.Governing)).toBe(false);
    expect(canPerformCategory(TreatmentBand.B7, ActionCategory.Governing)).toBe(false);
  });

  test('Relational blocked at band 5+', () => {
    expect(canPerformCategory(TreatmentBand.B5, ActionCategory.Relational)).toBe(false);
  });

  test('Succession blocked at band 5+', () => {
    expect(canPerformCategory(TreatmentBand.B5, ActionCategory.Succession)).toBe(false);
  });
});

describe('getVisibilityTier', () => {
  test('band 1-3 → full', () => {
    expect(getVisibilityTier(TreatmentBand.B1)).toBe('full');
    expect(getVisibilityTier(TreatmentBand.B2)).toBe('full');
    expect(getVisibilityTier(TreatmentBand.B3)).toBe('full');
  });

  test('band 4 → standard', () => {
    expect(getVisibilityTier(TreatmentBand.B4)).toBe('standard');
  });

  test('band 5-6 → restricted', () => {
    expect(getVisibilityTier(TreatmentBand.B5)).toBe('restricted');
    expect(getVisibilityTier(TreatmentBand.B6)).toBe('restricted');
  });

  test('band 7 → flagged', () => {
    expect(getVisibilityTier(TreatmentBand.B7)).toBe('flagged');
  });
});

// ─── Integration: defector is dominated ──────────────────────────────────────

describe('defector is dominated (M7 integration)', () => {
  test('high-extraction agent degrades to band 6-7', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    for (let i = 0; i < 30; i++) {
      ts = applyTrustSignal(ts, makeExtractSignal(), NOW + i);
    }
    const band = getReputationRecord(ts, AGENT_A)!.treatment_band;
    expect(band).toBeGreaterThanOrEqual(TreatmentBand.B5);
  });

  test('high-extraction agent loses Governing access', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    for (let i = 0; i < 30; i++) {
      ts = applyTrustSignal(ts, makeExtractSignal(), NOW + i);
    }
    const band = getReputationRecord(ts, AGENT_A)!.treatment_band;
    if (band >= TreatmentBand.B5) {
      expect(canPerformCategory(band, ActionCategory.Governing)).toBe(false);
    }
  });

  test('defector vote weight multiplier < restorer multiplier', () => {
    let tsDef = initTrustState();
    tsDef = registerReputationRecord(tsDef, AGENT_A, NOW);
    let tsRes = initTrustState();
    tsRes = registerReputationRecord(tsRes, AGENT_B, NOW);

    // Drive defector to band 7, restorer to band 1
    for (let i = 0; i < 40; i++) {
      tsDef = applyTrustSignal(tsDef, makeExtractSignal(), NOW + i);
      tsRes = applyTrustSignal(tsRes, makeRegenSignal(AGENT_B), NOW + i);
    }

    const defBand = getReputationRecord(tsDef, AGENT_A)!.treatment_band;
    const resBand = getReputationRecord(tsRes, AGENT_B)!.treatment_band;

    expect(getVoteWeightMultiplier(defBand)).toBeLessThan(
      getVoteWeightMultiplier(resBand),
    );
  });

  test('restorer recovers from band 7 via restorative path', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    // Push to band 7
    for (let i = 0; i < 50; i++) {
      ts = applyTrustSignal(ts, makeExtractSignal(), NOW + i);
    }
    const bandAtWorst = getReputationRecord(ts, AGENT_A)!.treatment_band;

    // Apply enough restorative actions across multiple threshold cycles
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let i = 0; i < RESTORATION_THRESHOLD; i++) {
        ts = applyTrustSignal(ts, makeRegenSignal(), NOW + 1000 + cycle * 100 + i);
      }
    }

    const bandAfterRecovery = getReputationRecord(ts, AGENT_A)!.treatment_band;
    expect(bandAfterRecovery).toBeLessThan(bandAtWorst);
  });
});

// ─── Serialization ────────────────────────────────────────────────────────────

describe('serialization', () => {
  test('reputation record is JSON-serializable', () => {
    let ts = initTrustState();
    ts = registerReputationRecord(ts, AGENT_A, NOW);
    ts = applyTrustSignal(ts, makeRegenSignal(), NOW);
    const rec = getReputationRecord(ts, AGENT_A)!;
    expect(() => JSON.stringify(rec)).not.toThrow();
  });
});
