# Brainstorm: Fix Temporal CALLS Edge Migration Bugs
**Created:** 2026-03-07
**Status:** Draft

## Vision
Fix three bugs in how CALLS edges are handled during temporal graph migration. Currently, CALLS edges lose SCIP-enriched properties when transitioning to temporal versioning, unchanged edges from pre-temporal digests never receive temporal fields, and the close-out query can match wrong node versions.

## Existing Context

via RepoGraph + local file reads:

- **Differ** (`packages/backend/src/pipeline/differ.ts`): Produces `GraphChangeset` with `EdgeChange[]`. CALLS edge snapshots only capture `callSiteLine` in `properties` (line 297). The full `CallsEdge` type (`scip/types.ts:15-25`) has 4 additional SCIP properties.
- **Temporal Loader** (`packages/backend/src/pipeline/temporal-loader.ts`): `createEdges()` CALLS handler (lines 307-338) only writes `call_site_line`. `closeOutEdges()` CALLS handler (lines 423-440) doesn't filter nodes by `valid_to IS NULL`.
- **Non-temporal Loader** (`packages/backend/src/pipeline/loader.ts`): `loadCallsToNeo4j()` (lines 527-574) correctly stores all SCIP properties via MERGE.
- **Digest Orchestrator** (`packages/backend/src/pipeline/digest.ts`): Temporal path (lines 407-436) calls `diffGraph()` then `temporalLoad()`. No migration stamp step exists.
- **Phase 4 Audit** found Finding #4 (CALLS edge duplication on modified symbols) but the code already has `valid_to IS NULL` filter on caller/callee in `createEdges`. The audit may have been against an earlier version.

## Components Identified

### 1. Differ — CALLS Edge Snapshot Enrichment
- **Responsibility**: Capture all SCIP properties when snapshotting CALLS edges
- **Upstream (receives from)**: `CallsEdge[]` from SCIP stage (has `argTypes`, `argExpressions`, `hasTypeMismatch`, `typeMismatchDetail`)
- **Downstream (sends to)**: `GraphEdgeSnapshot.properties` consumed by temporal-loader
- **External dependencies**: None
- **Hands test**: FAIL — snapshot silently drops 4 SCIP properties

### 2. Temporal Loader — CALLS Edge Property Passthrough
- **Responsibility**: Write all CALLS edge properties to Neo4j, not just `call_site_line`
- **Upstream (receives from)**: `EdgeChange` from differ with `GraphEdgeSnapshot.properties`
- **Downstream (sends to)**: Neo4j CALLS relationships
- **External dependencies**: Neo4j session
- **Hands test**: FAIL — CREATE query only sets `call_site_line`, ignoring SCIP properties

### 3. Temporal Loader — Migration Stamp for Unchanged Edges
- **Responsibility**: On first temporal digest, stamp unchanged CALLS (and IMPORTS) edges with temporal fields
- **Upstream (receives from)**: `fetchPreviousGraphState()` result (knows which edges exist pre-temporal)
- **Downstream (sends to)**: Neo4j edge properties (adds `valid_from`, `valid_from_ts`)
- **External dependencies**: Neo4j session, commit metadata
- **Hands test**: FAIL — no migration step exists; unchanged edges remain without temporal fields

### 4. Temporal Loader — Close-Out Node Version Filter
- **Responsibility**: Only close out CALLS edges connected to current (non-closed) node versions
- **Upstream (receives from)**: `EdgeChange` with `changeType === "deleted"`
- **Downstream (sends to)**: Neo4j — sets `valid_to` on CALLS relationships
- **External dependencies**: Neo4j session
- **Hands test**: PARTIAL — works in most cases because the edge physically lives on the old node, but the unfiltered MATCH is fragile

## Rough Dependency Map

```
CallsEdge (SCIP) ──→ differ.ts (snapshot) ──→ temporal-loader.ts (createEdges)
                                                       │
                                           ┌───────────┴──────────┐
                                           ▼                      ▼
                                   Neo4j CALLS edge       Neo4j CALLS edge
                                   (new temporal)         (old, unchanged)
                                                                │
                                                     migration stamp needed
```

## Open Questions

1. Should the migration stamp also apply to IMPORTS edges? (Same bug exists there)
2. Should the differ detect the "first temporal digest" scenario and flag it, or should the temporal loader handle it independently?
3. For the migration stamp, should we use the HEAD commit SHA as `valid_from`, or a synthetic "pre-temporal" marker?

## Risks and Concerns

- **Performance**: Stamping all unchanged edges on first temporal digest could be slow for large repos (thousands of edges). Should use batch UNWIND.
- **Idempotency**: If the migration stamp runs twice (re-digest), it must not create duplicate temporal fields or corrupt existing temporal edges. Use conditional SET (only stamp if `valid_from` is missing).
- **Data loss window**: Between the old non-temporal digest and the first temporal digest, SCIP properties on CALLS edges are correct. After the first temporal digest, any CALLS edges that were "created" (new) in the diff lose their SCIP properties. This is the active data loss bug.
