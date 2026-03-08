# Build Plan: Fix Temporal CALLS Edge Migration Bugs
**Created:** 2026-03-07
**Brainstorm:** ../brainstorm/calls-edge-migration-fix-brainstorm-2026-03-07.md
**Status:** Draft

## Overview

Fix three bugs where CALLS edges lose SCIP properties during temporal versioning, unchanged pre-temporal edges never receive temporal fields, and the close-out query doesn't filter node versions. All fixes are in two files: `differ.ts` and `temporal-loader.ts`.

## Component Inventory

| # | Component | File | Change Type | Description |
|---|-----------|------|-------------|-------------|
| 1 | CALLS snapshot enrichment | `differ.ts` | Modify | Capture all SCIP properties in GraphEdgeSnapshot |
| 2 | CALLS edge CREATE query | `temporal-loader.ts` | Modify | Write all SCIP properties to Neo4j |
| 3 | Migration stamp | `temporal-loader.ts` | New function | Stamp unchanged pre-temporal edges with temporal fields |
| 4 | Close-out node filter | `temporal-loader.ts` | Modify | Add valid_to IS NULL filter on nodes in closeOutEdges CALLS query |
| 5 | Digest orchestrator | `digest.ts` | Modify | Pass migration context to temporalLoad |

## Integration Contracts

### Contract 1: Differ → Temporal Loader (SCIP properties)
```
diffGraph() → temporalLoad()
  What flows:     GraphEdgeSnapshot.properties now includes:
                  { callSiteLine, argTypes, argExpressions,
                    hasTypeMismatch, typeMismatchDetail }
  How it flows:   Same EdgeChange data structure, just more properties populated
  Error path:     Missing SCIP properties default to null (backward compatible)
```

### Contract 2: Temporal Loader → Neo4j (CALLS CREATE)
```
createEdges() → Neo4j
  What flows:     CALLS relationship with all SCIP properties:
                  call_site_line, arg_types, arg_expressions,
                  has_type_mismatch, type_mismatch_detail,
                  valid_from, valid_from_ts, change_type
  How it flows:   Cypher CREATE with additional SET clauses
  Error path:     Null SCIP properties stored as null (Neo4j handles gracefully)
```

### Contract 3: Migration Stamp → Neo4j (unchanged edges)
```
stampPreTemporalEdges() → Neo4j
  What flows:     For all CALLS/IMPORTS edges where valid_from IS missing:
                  SET valid_from = commitSha, valid_from_ts = commitTs
  How it flows:   Batch Cypher query with WHERE NOT EXISTS(r.valid_from)
  Auth/Config:    Same Neo4j session
  Error path:     Idempotent — condition (NOT EXISTS valid_from) prevents double-stamp
```

## End-to-End Flows

### Flow 1: First temporal digest (migration path)
```
1. diffGraph() fetches previous state (old non-temporal nodes/edges found)
2. diffGraph() produces changeset with SCIP properties preserved in snapshots
3. temporalLoad() processes node changes (create/modify/delete)
4. temporalLoad() processes edge changes (create/delete) — new CALLS edges
   now include all SCIP properties
5. stampPreTemporalEdges() runs — finds all edges with no valid_from
   property, stamps them with HEAD commit SHA and timestamp
6. createIntroducedInEdges() runs for changed nodes
```

### Flow 2: Incremental temporal digest (steady state)
```
1. diffGraph() produces changeset — SCIP properties flow through
2. temporalLoad() creates/closes edges with full SCIP properties
3. stampPreTemporalEdges() runs but finds 0 edges to stamp (all already
   have valid_from) — no-op
4. Normal flow continues
```

### Flow 3: Close-out of CALLS edge on modified symbol
```
1. modifyNodes() closes old version, creates new version of caller
2. closeOutEdges() matches CALLS edge:
   - caller filtered by valid_to IS NULL (matches new version OR old
     non-temporal nodes without valid_to property)
   - Edge r filtered by valid_to IS NULL
   - Sets r.valid_to = commitSha
3. Result: Only the edge on the correct node version is closed
```

## Issues Found

All three issues are in the current code and documented in the brainstorm.

## Wiring Checklist

### Fix 1: SCIP Properties in Differ Snapshot (differ.ts)
- [ ] Update CALLS edge snapshot in `diffGraph()` (line ~293-298) to include `argTypes`, `argExpressions`, `hasTypeMismatch`, `typeMismatchDetail` from `CallsEdge`
- [ ] Update `fetchPreviousGraphState()` CALLS query (line ~150-157) to also return `arg_types`, `arg_expressions`, `has_type_mismatch`, `type_mismatch_detail` from existing Neo4j CALLS edges
- [ ] Include these properties in the `GraphEdgeSnapshot.properties` map for previous-state CALLS edges (line ~160-173)

### Fix 2: SCIP Properties in Temporal Loader CREATE (temporal-loader.ts)
- [ ] Update `createEdges()` CALLS batch mapping (line ~309-319) to extract SCIP properties from `snap.properties`
- [ ] Update `createEdges()` CALLS Cypher CREATE query (line ~322-335) to include `arg_types`, `arg_expressions`, `has_type_mismatch`, `type_mismatch_detail` on the relationship

### Fix 3: Migration Stamp for Pre-Temporal Edges (temporal-loader.ts)
- [ ] Add new function `stampPreTemporalEdges(session, ctx)` that:
  - Finds all CALLS edges where `NOT EXISTS(r.valid_from)` and stamps with `valid_from`, `valid_from_ts`
  - Finds all IMPORTS edges where `NOT EXISTS(r.valid_from)` and stamps with `valid_from`, `valid_from_ts`
  - Uses UNWIND batching for performance
  - Returns count of stamped edges
- [ ] Call `stampPreTemporalEdges()` from `temporalLoad()` after edge processing
- [ ] Add `preTemporalEdgesStamped` to `TemporalLoadResult` interface
- [ ] Also stamp pre-temporal NODES (symbols without `valid_from`): `MATCH (n) WHERE n.repo_url = $repoUrl AND NOT EXISTS(n.valid_from) AND (n:Function OR n:Class OR n:TypeDef OR n:Constant) SET n.valid_from = $sha, n.valid_from_ts = datetime($ts), n.change_type = 'migrated'`

### Fix 4: Close-Out Node Version Filter (temporal-loader.ts)
- [ ] In `closeOutEdges()` CALLS section (line ~427-428), add `AND (caller.valid_to IS NULL)` and `AND (callee.valid_to IS NULL)` to the MATCH WHERE clause

## Build Order

### Phase 1: Differ + Loader fixes (Fix 1 + Fix 2 + Fix 4)
**Files:** `differ.ts`, `temporal-loader.ts`
**Dependencies:** None — these are property additions and query fixes
**Checkpoint:** After applying, verify that a temporal digest produces CALLS edges with SCIP properties in Neo4j

### Phase 2: Migration stamp (Fix 3)
**Files:** `temporal-loader.ts`, `digest.ts` (optional: pass context)
**Dependencies:** Phase 1 (SCIP properties should flow before we stamp old edges)
**Checkpoint:** Run temporal digest on a repo with existing non-temporal data, verify all CALLS/IMPORTS edges have `valid_from` after digest
