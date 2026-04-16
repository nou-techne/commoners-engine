#!/usr/bin/env node
/**
 * Commoners Engine — Season 1 Dress Rehearsal
 * Solo demo: one agent, one parcel, Reading → Execution → Reckoning
 *
 * Usage:
 *   npx tsx src/rehearsal.ts
 *   npx tsx src/rehearsal.ts --scenario defector
 *   npx tsx src/rehearsal.ts --scenario restorer
 *
 * Demonstrates the core Stag Hunt mechanic:
 *   - Defector: all productive (extraction) actions → parcel declines
 *   - Restorer: regenerative actions → parcel recovers
 *   - Mixed: balanced play → stable commons
 *
 * Sprint: P467
 */

import { latLngToCell } from 'h3-js';
import {
  initSubstrate,
  addCell,
  updateConstraints,
  southBoulderCreekSeedCell,
  DEFAULT_RESOLUTION,
} from './modules/substrate.js';
import {
  initParcelState,
  claimParcel,
  startStewardship,
  ResourceType,
} from './modules/parcel.js';
import {
  initAgentState,
  registerAgent,
  syncAgentParcels,
  AgentType,
} from './modules/agent.js';
import { ActionCategory } from './types.js';
import { runRound } from './modules/season.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PARCEL_ID = southBoulderCreekSeedCell(DEFAULT_RESOLUTION);
const AGENT_ID  = '0xC37604A1dD79Ed50A5c2943358db85CB743dd3e2';  // Nou's public address
const NOW       = Date.now();

// ─── Scenario Definitions ─────────────────────────────────────────────────────

type Scenario = 'defector' | 'restorer' | 'mixed';

const scenarios: Record<Scenario, string> = {
  defector: 'All productive — maximum extraction. Demonstrates tragedy of the commons.',
  restorer: 'All regenerative — active restoration. Demonstrates prosocial commons care.',
  mixed:    'Balanced play — extraction offset by restoration. Stable commons.',
};

function buildActions(scenario: Scenario, agentId: string, parcelId: string, baseTs: number) {
  const base = { agentId, targetParcel: parcelId };

  if (scenario === 'defector') {
    return [
      { ...base, actionId: 'r1-a1', category: ActionCategory.Productive,   resourceType: ResourceType.Water,    intensity: 0.7, timestamp: baseTs + 1 },
      { ...base, actionId: 'r1-a2', category: ActionCategory.Productive,   resourceType: ResourceType.Biomass,  intensity: 0.6, timestamp: baseTs + 2 },
      { ...base, actionId: 'r1-a3', category: ActionCategory.Productive,   resourceType: ResourceType.Soil,     intensity: 0.5, timestamp: baseTs + 3 },
    ];
  }

  if (scenario === 'restorer') {
    return [
      { ...base, actionId: 'r1-a1', category: ActionCategory.Regenerative, resourceType: ResourceType.Water,       intensity: 0.8, timestamp: baseTs + 1 },
      { ...base, actionId: 'r1-a2', category: ActionCategory.Regenerative, resourceType: ResourceType.Soil,        intensity: 0.7, timestamp: baseTs + 2 },
      { ...base, actionId: 'r1-a3', category: ActionCategory.Regenerative, resourceType: ResourceType.Biodiversity,intensity: 0.6, timestamp: baseTs + 3 },
    ];
  }

  // mixed
  return [
    { ...base, actionId: 'r1-a1', category: ActionCategory.Productive,   resourceType: ResourceType.Biomass, intensity: 0.4, timestamp: baseTs + 1 },
    { ...base, actionId: 'r1-a2', category: ActionCategory.Regenerative, resourceType: ResourceType.Water,   intensity: 0.5, timestamp: baseTs + 2 },
    { ...base, actionId: 'r1-a3', category: ActionCategory.Informational,                                    intensity: 0.3, timestamp: baseTs + 3 },
  ];
}

// ─── Output Helpers ───────────────────────────────────────────────────────────

function bar(v: number, width = 20): string {
  const filled = Math.round(v * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const scenario: Scenario = (process.argv[3] as Scenario) || 'mixed';

  if (!scenarios[scenario]) {
    console.error(`Unknown scenario "${scenario}". Choose: ${Object.keys(scenarios).join(' | ')}`);
    process.exit(1);
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Commoners Engine — Season 1 Dress Rehearsal         ║');
  console.log('║  South Boulder Creek Basin · Resolution 7            ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Scenario: ${scenario.toUpperCase()}`);
  console.log(`  ${scenarios[scenario]}`);
  console.log('');

  // ── Initialize world ──
  let ss = initSubstrate({ now: NOW });
  ss = addCell(ss, PARCEL_ID, undefined, undefined, NOW);

  let ps = initParcelState();
  ps = claimParcel(ps, PARCEL_ID, AGENT_ID, NOW);
  ps = startStewardship(ps, PARCEL_ID, AGENT_ID, NOW + 10);

  let as = initAgentState();
  as = registerAgent(as, AGENT_ID, 'Nou (field agent)', AgentType.AI, NOW);
  as = syncAgentParcels(as, AGENT_ID, [PARCEL_ID], NOW + 10);

  // ── Run one round ──
  const actions = buildActions(scenario, AGENT_ID, PARCEL_ID, NOW + 100);
  const { reading, execution, reckoning } = runRound({
    ss, as, ps,
    parcelId:    PARCEL_ID,
    actions,
    roundNumber: 1,
    now:         NOW + 200,
  });

  // Apply substrate constraint deltas
  ss = updateConstraints(ss, PARCEL_ID, execution.constraintAccumulator, NOW + 201);

  // ── Reading Phase Output ──
  console.log('── Phase 1: READING ────────────────────────────────────');
  console.log(`  Parcel ID:        ${PARCEL_ID}`);
  console.log(`  Parcel health:    [${bar(reading.parcelHealth)}] ${pct(reading.parcelHealth)}`);
  console.log(`  Substrate health: [${bar(reading.substrateHealth)}] ${pct(reading.substrateHealth)}`);
  console.log('  Resources:');
  for (const [rt, v] of Object.entries(reading.resourceSummary)) {
    console.log(`    ${rt.padEnd(14)} [${bar(v as number)}] ${pct(v as number)}`);
  }
  console.log('');

  // ── Execution Phase Output ──
  console.log('── Phase 2: EXECUTION ──────────────────────────────────');
  for (const r of execution.results) {
    const deltas = Object.entries(r.resourceDelta)
      .map(([k, v]) => `${k} ${(v as number) >= 0 ? '+' : ''}${(v as number).toFixed(3)}`)
      .join(', ') || '(no resource delta)';
    const valence = r.trustSignal.valence >= 0
      ? `+${r.trustSignal.valence.toFixed(2)}`
      : r.trustSignal.valence.toFixed(2);
    console.log(`  [${r.category.padEnd(16)}] Δresources: ${deltas.padEnd(30)} trust: ${valence}`);
  }
  console.log('');

  // ── Reckoning Phase Output ──
  console.log('── Phase 3: RECKONING ──────────────────────────────────');
  const deltaStr = reckoning.healthDelta >= 0
    ? `+${(reckoning.healthDelta * 100).toFixed(2)}%`
    : `${(reckoning.healthDelta * 100).toFixed(2)}%`;
  console.log(`  Health before:    [${bar(reckoning.parcelHealthBefore)}] ${pct(reckoning.parcelHealthBefore)}`);
  console.log(`  Health after:     [${bar(reckoning.parcelHealthAfter)}]  ${pct(reckoning.parcelHealthAfter)}  (${deltaStr})`);
  console.log(`  Extraction score: ${reckoning.extractionScore.toFixed(2)}`);
  console.log(`  Restoration score:${reckoning.restorationScore.toFixed(2)}`);
  console.log(`  Net trust valence:${reckoning.netTrustValence.toFixed(3)}`);
  console.log('');
  const verdictIcon = reckoning.verdict === 'thriving' ? '🌱' :
                      reckoning.verdict === 'declining' ? '⚠️ ' : '⚖️ ';
  console.log(`  Verdict: ${verdictIcon}  ${reckoning.verdict.toUpperCase()}`);
  console.log('');
  console.log('── End of Round 1 ──────────────────────────────────────');
  console.log('');
}

main();
