/**
 * Commoners Engine — Shared Types
 * Architecture decision P456: TypeScript, H3 resolution 7, EIP-712 attestations
 */

// ─── Biome ────────────────────────────────────────────────────────────────────

export enum BiomeType {
  Forest    = 'forest',
  Grassland = 'grassland',
  Wetland   = 'wetland',
  Arid      = 'arid',
  Riparian  = 'riparian',
}

// ─── Binding Constraints ──────────────────────────────────────────────────────
// Six constraints from Game Design Memo 001, each clamped 0..1.
// 1.0 = fully healthy/available; 0.0 = exhausted/collapsed.

export interface ConstraintParams {
  thermodynamic: number;  // energy availability: solar, heat, caloric
  hydrological:  number;  // water: availability, flow, quality
  pedological:   number;  // soil: health, structure, microbial activity
  ecological:    number;  // biodiversity: species richness, ecosystem function
  demographic:   number;  // population density relative to carrying capacity
  temporal:      number;  // seasonal alignment: phenological fit
}

// ─── Hex Cell ─────────────────────────────────────────────────────────────────

export interface HexCell {
  cellId:      string;          // H3 cell ID (resolution 7)
  biomeType:   BiomeType;
  constraints: ConstraintParams;
  lastUpdated: number;          // unix ms
}

// ─── Substrate State ─────────────────────────────────────────────────────────

export interface SubstrateState {
  resolution: number;                 // H3 resolution (default 7)
  cells:      Map<string, HexCell>;
  createdAt:  number;                 // unix ms
  updatedAt:  number;
}

// ─── Constraint Delta ────────────────────────────────────────────────────────
// Partial update to one or more constraint dimensions.
// Positive = restoration; negative = extraction/degradation.

export type ConstraintDelta = Partial<ConstraintParams>;

// ─── Substrate Snapshot (M4 export) ─────────────────────────────────────────
// Serialisable form sent to Basin (M4) for aggregate queries.

export interface CellSnapshot {
  cellId:      string;
  biomeType:   BiomeType;
  constraints: ConstraintParams;
  health:      number;          // aggregate health score 0..1
}

export interface SubstrateSnapshot {
  resolution:    number;
  cellCount:     number;
  cells:         CellSnapshot[];
  snapshotAt:    number;
}

// ─── Action types (forward declaration for M3 integration) ───────────────────

export enum ActionCategory {
  Productive      = 'productive',       // 0 — resource extraction
  Regenerative    = 'regenerative',     // 1 — resource restoration
  Infrastructural = 'infrastructural',  // 2 — shared infrastructure
  Governing       = 'governing',        // 3 — proposal/vote
  Relational      = 'relational',       // 4 — inter-agent coordination
  Informational   = 'informational',    // 5 — observation/reporting
  Succession      = 'succession',       // 6 — transfer of parcel stewardship across seasons
                                        //     Succession is the memo's primary victory condition:
                                        //     transmitting a working system to the next season.
                                        //     M7 reads this across-season for reputation continuity.
                                        //     NOTE: added per P459 review (Nou/Opus — cross-season
                                        //     continuity gap in P456 attestation schema).
}

// ─── EIP-712 Attestation (P456 decision — shared across M3, M5, M8) ──────────

export interface AttestationFields {
  agentId:       string;   // Ethereum address
  actionType:    number;   // ActionCategory as uint8
  targetParcel:  string;   // H3 cellId encoded as bytes32 hex
  resourceDelta: bigint;   // positive = restoration, negative = extraction
  timestamp:     bigint;   // unix seconds as uint256
  outcomeHash:   string;   // bytes32 hash of effect resolution result
}

export const ATTESTATION_DOMAIN = {
  name:              'CommonsBasin',
  version:           '1',
  chainId:           8453,   // Base mainnet
  verifyingContract: '0x0000000000000000000000000000000000000000', // TBD P463
} as const;

export const ATTESTATION_TYPES = {
  Action: [
    { name: 'agentId',       type: 'address' },
    { name: 'actionType',    type: 'uint8'   },
    { name: 'targetParcel',  type: 'bytes32' },
    { name: 'resourceDelta', type: 'int256'  },
    { name: 'timestamp',     type: 'uint256' },
    { name: 'outcomeHash',   type: 'bytes32' },
  ],
} as const;
