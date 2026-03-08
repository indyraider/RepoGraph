# Phase 3 Forward Plan Review
**Phase completed:** Diff Engine
**Date:** 2026-03-07
**Plan updates needed:** YES

---

## Actual Interfaces Built

All exports from `packages/backend/src/pipeline/differ.ts`:

### Types

**`GraphNodeSnapshot`** (line 8-17)
```ts
export interface GraphNodeSnapshot {
  kind: "function" | "class" | "type" | "constant";
  name: string;
  filePath: string;
  signature: string;
  docstring: string;
  startLine: number;
  endLine: number;
  resolvedSignature?: string;
}
```

**`GraphEdgeSnapshot`** (line 19-24)
```ts
export interface GraphEdgeSnapshot {
  edgeType: "IMPORTS" | "DIRECTLY_IMPORTS" | "CALLS";
  sourceKey: string;
  targetKey: string;
  properties: Record<string, unknown>;
}
```

**`NodeChange<T>`** (line 26-31)
```ts
export interface NodeChange<T> {
  identityKey: string;   // format: "{filePath}::{name}"
  old?: T;
  new?: T;
  changeType: "created" | "modified" | "deleted";
}
```

**`EdgeChange`** (line 33-39)
```ts
export interface EdgeChange {
  identityKey: string;   // format varies by edge type, see identity key helpers
  edgeType: string;
  old?: GraphEdgeSnapshot;
  new?: GraphEdgeSnapshot;
  changeType: "created" | "modified" | "deleted";
}
```

**`GraphChangeset`** (line 41-52)
```ts
export interface GraphChangeset {
  nodes: NodeChange<GraphNodeSnapshot>[];
  edges: EdgeChange[];
  stats: {
    nodesCreated: number;
    nodesModified: number;
    nodesDeleted: number;
    edgesCreated: number;
    edgesModified: number;
    edgesDeleted: number;
  };
}
```

### Functions

**`fetchPreviousGraphState(repoUrl: string): Promise<PreviousGraphState>`** (line 85)
- Exported, public
- Queries Neo4j for all current nodes and edges where `valid_to IS NULL OR NOT EXISTS(valid_to)`
- Returns `PreviousGraphState` (interface is NOT exported -- internal use only)

**`diffGraph(repoUrl, currentSymbols, currentImports, currentCalls): Promise<GraphChangeset>`** (line 207-212)
```ts
export async function diffGraph(
  repoUrl: string,
  currentSymbols: ParsedSymbol[],
  currentImports: EnrichedResolvedImport[],
  currentCalls: CallsEdge[]
): Promise<GraphChangeset>
```

### Internal-only (not exported)

- `PreviousGraphState` interface (line 74-79) -- NOT exported
- `symbolIdentityKey()`, `importsEdgeKey()`, `directImportsEdgeKey()`, `callsEdgeKey()` -- NOT exported
- `symbolChanged()` -- NOT exported

---

## Mismatches with Plan

### MISMATCH 1: `GraphChangeset` structure differs from plan Contract 5
- **Plan says:** (Contract 5, line 84-89)
  ```
  GraphChangeset: {
    created: { nodes: VersionedNode[], edges: VersionedEdge[] },
    modified: { nodes: { old: VersionedNode, new: VersionedNode }[], edges: ... },
    deleted: { nodes: VersionedNode[], edges: VersionedEdge[] }
  }
  ```
- **Code actually:** (differ.ts:41-52)
  ```ts
  GraphChangeset: {
    nodes: NodeChange<GraphNodeSnapshot>[],  // flat array with changeType discriminator
    edges: EdgeChange[],                      // flat array with changeType discriminator
    stats: { nodesCreated, nodesModified, nodesDeleted, edgesCreated, edgesModified, edgesDeleted }
  }
  ```
- **Downstream impact:** Phase 4 (Temporal Loader) must iterate flat arrays and switch on `changeType` instead of accessing pre-bucketed `created`/`modified`/`deleted` sub-objects. Phase 4 builder needs to know that to access "created nodes", the pattern is:
  ```ts
  changeset.nodes.filter(n => n.changeType === "created")
  ```
  or iterate once and switch. The stats object provides counts without re-scanning.
- **Plan update:** Update Contract 5 to reflect the actual flat-array-with-discriminator shape. The actual shape is arguably better (single iteration, no redundancy), so the code should stay as-is and the plan should adapt.

### MISMATCH 2: No `VersionedNode` / `VersionedEdge` types exist
- **Plan says:** (Wiring Checklist, Phase 3) "Define `VersionedNode` type extending ParsedSymbol with temporal fields" and "Define `VersionedEdge` type with source/target identity + properties"
- **Code actually:** Uses `GraphNodeSnapshot` and `GraphEdgeSnapshot` instead. These are simpler types that do NOT carry temporal fields (`valid_from`, `valid_to`, `changed_by`, etc.). Temporal fields are not part of the changeset -- they will be applied by the temporal loader using commit metadata.
- **Downstream impact:** Phase 4 must combine `GraphNodeSnapshot` properties with commit metadata to produce the temporal node. This is the right design -- the diff engine should not be responsible for temporal stamping. Phase 4 just needs to know the types are `GraphNodeSnapshot`/`GraphEdgeSnapshot`, not `VersionedNode`/`VersionedEdge`.
- **Plan update:** Rename in plan: `VersionedNode` -> `GraphNodeSnapshot`, `VersionedEdge` -> `GraphEdgeSnapshot`. Phase 4 checklist items referencing `VersionedNode`/`VersionedEdge` should use the actual type names.

### MISMATCH 3: `diffGraph()` signature differs from plan Contract 4
- **Plan says:** (Contract 4) `diffGraph()` takes the full resolve output as a bundle: `{ allSymbols, allImports, allExports, callsEdges, allFiles }`
- **Code actually:** (differ.ts:207-212) Takes 4 separate positional parameters:
  ```ts
  diffGraph(repoUrl, currentSymbols, currentImports, currentCalls)
  ```
  - `repoUrl` is the first param (fetches previous state internally)
  - Does NOT accept `allExports`, `allFiles`, or `ScannedFile[]`
  - `currentImports` expects `EnrichedResolvedImport[]` (from `resolveResult.imports`), not `ResolvedImport[]`
- **Downstream impact:** Phase 4 orchestrator wiring must call:
  ```ts
  const changeset = await diffGraph(req.url, allSymbols, resolveResult.imports, callsEdges);
  ```
  All three inputs are already available in `runDigest()`: `allSymbols` (line 303), `resolveResult.imports` (line 354), `callsEdges` (line 344).
- **Plan update:** Update Contract 4 to show actual signature.

### MISMATCH 4: DIRECTLY_IMPORTS edges are not diffed
- **Plan says:** (Contract 5 and Phase 4 checklist) "Same close-out + create pattern for IMPORTS, DIRECTLY_IMPORTS, CALLS edges"
- **Code actually:** The differ imports `DirectlyImportsEdge` (line 3) but never uses it. `diffGraph()` does not accept `DirectlyImportsEdge[]` as input and does not diff DIRECTLY_IMPORTS edges. The `fetchPreviousGraphState()` also does not query DIRECTLY_IMPORTS edges (it has `importsEdges` and `callsEdges` maps, but no `directImportsEdges` map despite the `PreviousGraphState` interface declaring one at line 77).
- **Wait -- correction:** Looking again at line 74-79, `PreviousGraphState` DOES have a `directImportsEdges` field, and `fetchPreviousGraphState` does NOT populate it. The `directImportsEdges` map stays empty.
- **Downstream impact:** DIRECTLY_IMPORTS edges will not have temporal versioning. They'll continue to be purged-and-recreated each digest (existing behavior in `digest.ts`). Phase 4 temporal loader won't version them. Phase 6 MCP tools that query DIRECTLY_IMPORTS edges won't have history for them.
- **Severity:** MEDIUM. DIRECTLY_IMPORTS edges are derived from IMPORTS edges (they're the per-symbol expansion). They could be reconstructed from IMPORTS edge history. But if Phase 6 `get_symbol_history` wants to show "when was this specific import of symbol X introduced," it won't have that data.
- **Plan update:** Either (a) add DIRECTLY_IMPORTS diffing to differ.ts by accepting `DirectlyImportsEdge[]` as a 4th parameter, or (b) explicitly document that DIRECTLY_IMPORTS are not temporally versioned and Phase 6 should reconstruct from IMPORTS history. Option (a) is recommended if the feature is desired.

### MISMATCH 5: `diffGraph()` fetches previous state internally
- **Plan says:** (Contract 4) "Previous state: queried from Neo4j" -- implies it's a separate call or parameter
- **Code actually:** `diffGraph()` calls `fetchPreviousGraphState(repoUrl)` internally (line 213). The caller does NOT need to fetch previous state.
- **Downstream impact:** POSITIVE. Simpler API for Phase 4 orchestrator -- just pass current data, differ handles the rest. However, Phase 5 (Historical Backfill) should be aware that each call to `diffGraph()` in the per-commit loop will trigger a Neo4j query. This is correct behavior (each iteration diffs against the graph state that was just written by the previous iteration's temporal load), but it means the backfill loop must ensure temporal load commits to Neo4j before the next `diffGraph()` call.
- **Plan update:** Note this in Phase 5 design -- sequential execution is mandatory (no parallelism in the per-commit loop).

---

## Hook Points for Next Phase

### Phase 4 (Temporal Loader) needs to:

1. **Import from differ.ts:**
   ```ts
   import { GraphChangeset, NodeChange, EdgeChange, GraphNodeSnapshot, GraphEdgeSnapshot } from "./differ.js";
   ```

2. **Call `diffGraph()` in `runDigest()`** -- insert between resolve and load:
   ```ts
   const changeset = await diffGraph(req.url, allSymbols, resolveResult.imports, callsEdges);
   ```
   All three inputs are available at `digest.ts` lines 303, 354, 344.

3. **Iterate changeset for temporal writes:**
   ```ts
   for (const nodeChange of changeset.nodes) {
     switch (nodeChange.changeType) {
       case "created":  // nodeChange.new is GraphNodeSnapshot
       case "modified": // nodeChange.old and nodeChange.new are GraphNodeSnapshot
       case "deleted":  // nodeChange.old is GraphNodeSnapshot
     }
   }
   ```
   Same pattern for `changeset.edges`.

4. **Access identity keys for Neo4j MATCH:**
   - Node identity key format: `"{filePath}::{name}"` -- must be parsed to get `file_path` and `name` for Cypher MATCH
   - Edge identity key format varies:
     - IMPORTS: `"IMPORTS::{fromPath}->{toPath}"`
     - CALLS: `"CALLS::{callerFile}::{callerName}->{calleeFile}::{calleeName}"`

5. **Combine with commit metadata:**
   The changeset does NOT contain temporal fields. Phase 4 must supply `commitSha`, `commitTs`, `author`, `message` from `CommitMeta` (exported from `commit-ingester.ts`). Reminder from Phase 2 forward checkpoint: `ingestCommitHistory` currently does NOT return `CommitMeta[]` -- this must be fixed before Phase 4 can work (see Phase 2 Mismatch 1).

6. **Stats are pre-computed:**
   `changeset.stats` provides `nodesCreated`, `nodesModified`, `nodesDeleted`, etc. -- can be used directly in `DigestResult` without re-counting.

### Phase 4 (Orchestrator) branching logic:

In `runDigest()`, the temporal path must:
- Skip `purgeImportEdges()` and `purgeCallsEdges()` (the differ handles transitions)
- Skip the existing `loadSymbolsToNeo4j()` / `loadImportsToNeo4j()` / `loadCallsToNeo4j()` calls
- Call `temporalLoad(changeset, commitMeta)` instead
- File-level loading (`loadToNeo4j` for File nodes) still needs to happen -- the differ does NOT diff File nodes themselves, only symbols within files

### Important: File node handling gap

The differ diffs **symbol nodes** (Function, Class, TypeDef, Constant) and **edges** (IMPORTS, CALLS), but does NOT diff **File nodes**. The existing pipeline creates File nodes in `loadToNeo4j()`. Phase 4 must either:
- Continue using `loadToNeo4j()` for File nodes (MERGE is fine since File identity doesn't change)
- Or add File node diffing to the differ

Recommendation: Continue MERGEing File nodes as today. File nodes don't need versioning the same way symbols do -- a file existing vs not existing is captured implicitly by whether it has any CONTAINS edges to active symbol nodes.

---

## New Opportunities

1. **`changeset.stats` eliminates re-counting.** Phase 4 orchestrator can pass stats directly to `DigestResult` without filtering the arrays again.

2. **`fetchPreviousGraphState` is exported.** Phase 5 (Backfill) could call it independently if needed for debugging or validation, without going through the full `diffGraph()` pipeline.

3. **The flat-array-with-discriminator pattern is iteration-friendly.** Phase 4 temporal loader can process all changes in a single pass, batching Cypher operations by change type, rather than making three separate passes over created/modified/deleted buckets.

4. **Identity key format is deterministic.** Phase 4 can parse keys with `key.split("::")` to extract file_path and name for Cypher MATCH clauses, rather than carrying extra fields.

---

## Recommended Plan Updates

### 1. Update Contract 5 (Diff Engine -> Temporal Loader)
Replace the `GraphChangeset` structure in Contract 5 with:
```
GraphChangeset: {
  nodes: NodeChange<GraphNodeSnapshot>[],  // each has identityKey, old?, new?, changeType
  edges: EdgeChange[],                      // each has identityKey, edgeType, old?, new?, changeType
  stats: { nodesCreated, nodesModified, nodesDeleted, edgesCreated, edgesModified, edgesDeleted }
}
```
Remove references to `VersionedNode` and `VersionedEdge`. Use `GraphNodeSnapshot` and `GraphEdgeSnapshot` throughout.

### 2. Update Contract 4 (Resolve Stage -> Diff Engine)
Replace the function signature with:
```
diffGraph(repoUrl: string, currentSymbols: ParsedSymbol[], currentImports: EnrichedResolvedImport[], currentCalls: CallsEdge[]): Promise<GraphChangeset>
```
Note that the differ fetches previous state internally -- caller only provides current state.

### 3. Update Phase 4 Checklist
- Replace references to `VersionedNode` with `GraphNodeSnapshot`
- Replace references to `VersionedEdge` with `GraphEdgeSnapshot`
- Add import list: `GraphChangeset, NodeChange, EdgeChange, GraphNodeSnapshot, GraphEdgeSnapshot` from `differ.js`
- Add note: iterate `changeset.nodes` and `changeset.edges` with `changeType` switch, not pre-bucketed sub-objects
- Add note: File nodes are NOT in the changeset -- continue using existing `loadToNeo4j()` for File MERGE

### 4. Decide on DIRECTLY_IMPORTS edge versioning
The differ does NOT diff DIRECTLY_IMPORTS edges. Two options:
- **(a) Add it:** Extend `diffGraph()` with a 4th param `currentDirectImports: DirectlyImportsEdge[]`, populate the existing `directImportsEdges` map in `fetchPreviousGraphState`, and add a diff section. ~40 lines of code.
- **(b) Skip it:** Document that DIRECTLY_IMPORTS edges are not temporally versioned. They'll be purged-and-recreated each digest as today. Phase 6 tools work with IMPORTS edges for history.

Recommendation: Option (b) for now -- DIRECTLY_IMPORTS are a denormalization of IMPORTS for query convenience. Their history can be inferred. Add later if users need per-symbol import history.

### 5. Phase 5 Sequential Constraint
Add to Phase 5 design: The backfill per-commit loop MUST be sequential. Each iteration calls `diffGraph()` which queries Neo4j for current state, so the previous iteration's `temporalLoad()` must have committed before `diffGraph()` runs again.

### 6. Carry Forward Phase 2 Mismatch 1
Still unresolved from Phase 2: `ingestCommitHistory` must return `CommitMeta[]` so Phase 4 can populate temporal fields on versioned nodes. This is BLOCKING for Phase 4.

---

## Summary

| Item | Status |
|------|--------|
| `GraphChangeset` type | Built, but different structure than plan (flat arrays vs nested buckets) |
| `diffGraph()` signature | Built, 4 positional params (not bundled resolve output) |
| Node diffing (Function/Class/TypeDef/Constant) | Complete |
| IMPORTS edge diffing | Complete |
| CALLS edge diffing | Complete |
| DIRECTLY_IMPORTS edge diffing | NOT IMPLEMENTED (type imported but unused) |
| File node diffing | NOT IMPLEMENTED (by design -- File nodes continue to MERGE) |
| Backward compat (no previous temporal state) | Handled -- all nodes report as "created" |
| Identity key functions | Implemented but not exported |

**Phase 4 readiness: READY**, provided:
1. Phase 4 builder uses the actual type names (`GraphNodeSnapshot`, not `VersionedNode`)
2. Phase 4 builder iterates flat arrays with `changeType` discriminator
3. `ingestCommitHistory` is updated to return `CommitMeta[]` (Phase 2 carry-forward fix)
