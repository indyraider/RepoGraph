# Forward Planning Checkpoint: Phase 2 Complete
**Date:** 2026-03-06
**Phase completed:** Phase 2 -- Resolver Enhancement
**Files built:** `resolver.ts`, `digest.ts` (updated)

---

## 1. Interface Extraction from resolver.ts

### Exported Types

**ResolvedImport** (lines 7-13) -- unchanged base type:
```typescript
export interface ResolvedImport {
  fromFile: string;
  toFile: string | null;
  toPackage: string | null;
  symbols: string[];
  defaultImport: string | null;
}
```

**ResolutionStatus** (line 17):
```typescript
export type ResolutionStatus = "resolved" | "external" | "unresolvable" | "dynamic";
```

**EnrichedResolvedImport** (lines 19-24):
```typescript
export interface EnrichedResolvedImport extends ResolvedImport {
  resolutionStatus: ResolutionStatus;
  resolvedPath: string | null;
  barrelHops: number;
  unresolvedSymbols: string[];
}
```

**DirectlyImportsEdge** (lines 26-32):
```typescript
export interface DirectlyImportsEdge {
  fromFile: string;
  targetSymbolName: string;
  targetFilePath: string;
  importKind: "named" | "default" | "namespace";
  alias?: string;
}
```

**ResolveResult** (lines 34-47):
```typescript
export interface ResolveResult {
  imports: EnrichedResolvedImport[];
  directImports: DirectlyImportsEdge[];
  stats: {
    total: number;
    resolved: number;
    external: number;
    unresolvable: number;
    dynamic: number;
    unresolvedSymbols: number;
    barrelCycles: number;
    barrelDepthExceeded: number;
  };
}
```

### Exported Function

**resolveImports** (lines 416-604):
```typescript
export function resolveImports(
  parsedImports: ParsedImport[],
  repoPath: string,
  allExports?: ParsedExport[],
  allSymbols?: ParsedSymbol[],
  barrelMap?: Map<string, BarrelInfo>
): ResolveResult
```

Note: `allExports`, `allSymbols`, and `barrelMap` are all **optional** parameters. This preserves backward compatibility -- callers that pass only `(parsedImports, repoPath)` will get a `ResolveResult` with empty `directImports` and zero-valued enrichment fields.

### Types match plan exactly?

| Plan type | Actual type | Match? |
|-----------|------------|--------|
| EnrichedResolvedImport fields | Exact match | YES |
| DirectlyImportsEdge fields | Exact match | YES |
| ResolveResult.stats fields | Exact match | YES |
| resolveImports return type | ResolveResult | YES |

---

## 2. Mismatch Detection for Phase 3

### MISMATCH 1 (CRITICAL): loadImportsToNeo4j accepts ResolvedImport[], not ResolveResult

**Current signature** (loader.ts line 220):
```typescript
export async function loadImportsToNeo4j(
  repoUrl: string,
  resolvedImports: ResolvedImport[]
): Promise<number>
```

**What digest.ts currently passes** (lines 306, 322):
```typescript
importEdges = await loadImportsToNeo4j(req.url, resolveResult.imports);
```

**Status:** `resolveResult.imports` is `EnrichedResolvedImport[]`, which extends `ResolvedImport`. TypeScript structural typing means this **will compile without error** -- `EnrichedResolvedImport` is a superset of `ResolvedImport`. However, the loader currently only reads `fromFile`, `toFile`, `toPackage`, and `symbols`. It does NOT write the new enrichment fields to Neo4j.

**Phase 3 must:**
1. Change `loadImportsToNeo4j` to accept `ResolveResult` (or at minimum `EnrichedResolvedImport[]` + `DirectlyImportsEdge[]`).
2. Update the internal IMPORTS Cypher to SET `resolution_status`, `resolved_path`, `barrel_hops`, `unresolved_symbols`.
3. Add a new batch loop for `directImports` to write `DIRECTLY_IMPORTS` edges.

### MISMATCH 2 (CRITICAL): digest.ts does NOT pass directImports to loader

**Current call sites** (digest.ts lines 306, 322):
```typescript
importEdges = await loadImportsToNeo4j(req.url, resolveResult.imports);
```

The `resolveResult.directImports` array is **never passed to the loader**. Phase 3 must change these calls to pass the full `resolveResult` (or both `.imports` and `.directImports`).

### MISMATCH 3 (CRITICAL): purgeImportEdges does NOT delete DIRECTLY_IMPORTS

**Current implementation** (loader.ts lines 400-418):
```typescript
export async function purgeImportEdges(repoUrl: string): Promise<void> {
  // Only deletes IMPORTS edges:
  MATCH (f:File {repo_url: $repoUrl})-[r:IMPORTS]->() DELETE r
  MATCH ()-[r:IMPORTS]->(f:File {repo_url: $repoUrl}) DELETE r
}
```

**Phase 3 must add:**
```cypher
MATCH (f:File {repo_url: $repoUrl})-[r:DIRECTLY_IMPORTS]->() DELETE r
```

Without this, stale `DIRECTLY_IMPORTS` edges will accumulate on incremental re-digest.

### MISMATCH 4 (MODERATE): IMPORTS edge Cypher missing enrichment SET clauses

**Current Cypher** (loader.ts lines 241-248):
```cypher
MERGE (from)-[r:IMPORTS]->(to)
SET r.symbols = imp.symbols
```

**Plan requires:**
```cypher
SET r.symbols = imp.symbols,
    r.resolution_status = imp.resolution_status,
    r.resolved_path = imp.resolved_path,
    r.barrel_hops = imp.barrel_hops,
    r.unresolved_symbols = imp.unresolved_symbols
```

The `EnrichedResolvedImport` fields map cleanly to these Cypher parameters:
- `resolutionStatus` -> `resolution_status` (snake_case)
- `resolvedPath` -> `resolved_path`
- `barrelHops` -> `barrel_hops`
- `unresolvedSymbols` -> `unresolved_symbols`

No shape issues -- just need the mapping added in the batch data prep.

### MISMATCH 5 (NONE): DirectlyImportsEdge fields vs DIRECTLY_IMPORTS Cypher

**Plan Cypher expects:**
```
di.from_path, di.repo_url, di.symbol_name, di.target_file_path, di.import_kind, di.alias
```

**DirectlyImportsEdge provides:**
```
fromFile, targetSymbolName, targetFilePath, importKind, alias?
```

The field mapping is straightforward (camelCase -> snake_case), plus `repo_url` is added by the loader (same pattern as IMPORTS). No structural mismatch.

**Cypher node matching:**
```cypher
MATCH (sym {name: di.symbol_name, file_path: di.target_file_path, repo_url: di.repo_url})
WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
```

This matches against the same node labels that `loadSymbolsToNeo4j` creates (Function, Class, TypeDef, Constant), each with `name`, `file_path`, `repo_url` properties. Confirmed correct.

### OBSERVATION 6: digest.ts stats do NOT include resolution stats

**Current stats** (digest.ts lines 336-346):
```typescript
importCount: resolveResult.imports.length,
```

The plan says Phase 3 should add:
- `resolvedImports`, `unresolvedImports`, `dynamicImports`, `directImportEdges`, `barrelCycles`, `barrelDepthExceeded`

These are all available from `resolveResult.stats` but are not currently written. Phase 3 must add them to the stats object and the `DigestResult.stats` interface.

---

## 3. Mismatch Detection for Phase 4

### BACKWARD COMPAT: MCP tools must use OPTIONAL MATCH for DIRECTLY_IMPORTS

All four MCP tools currently use `IMPORTS` only. Repos digested before this feature ships will have no `DIRECTLY_IMPORTS` edges. The plan correctly identifies this (Issue #6).

**Required pattern for all MCP queries:**
```cypher
OPTIONAL MATCH (from:File)-[di:DIRECTLY_IMPORTS]->(sym)
```

Not `MATCH` -- `OPTIONAL MATCH`. This is consistent with the plan.

### NODE LABELS for DIRECTLY_IMPORTS targets

`DirectlyImportsEdge` points from a **File** node to a symbol node that is one of:
- `Function` (has `name`, `file_path`, `repo_url`)
- `Class` (has `name`, `file_path`, `repo_url`)
- `TypeDef` (has `name`, `file_path`, `repo_url`)
- `Constant` (has `name`, `file_path`, `repo_url`)

The `trace_imports` tool plan changes the path pattern to `[:IMPORTS|DIRECTLY_IMPORTS*1..N]`. Since `DIRECTLY_IMPORTS` points to symbol nodes (not File nodes), the variable-length path traversal will reach symbol nodes as intermediate/terminal nodes. The Cypher CASE expression in the plan handles this correctly with `WHEN n:Function OR n:Class...` branches.

### No issues found for Phase 4 tool updates

The resolver output shapes are clean for MCP consumption. No further mismatches detected.

---

## 4. Hook Points: Exact Signatures Phase 3 Must Match

### loader.ts -- loadImportsToNeo4j (must change to):

```typescript
export async function loadImportsToNeo4j(
  repoUrl: string,
  resolveResult: ResolveResult   // was: resolvedImports: ResolvedImport[]
): Promise<number>
```

Or alternatively, accept two separate arrays:
```typescript
export async function loadImportsToNeo4j(
  repoUrl: string,
  enrichedImports: EnrichedResolvedImport[],
  directImports: DirectlyImportsEdge[]
): Promise<number>
```

**Recommendation:** Accept `ResolveResult` directly -- it is the single source of truth and avoids the caller needing to destructure.

### loader.ts -- purgeImportEdges (must add DIRECTLY_IMPORTS deletion):

```typescript
export async function purgeImportEdges(repoUrl: string): Promise<void>
// Add third Cypher statement:
// MATCH (f:File {repo_url: $repoUrl})-[r:DIRECTLY_IMPORTS]->() DELETE r
```

### digest.ts -- call sites to update (lines 306, 322):

```typescript
// FROM:
importEdges = await loadImportsToNeo4j(req.url, resolveResult.imports);

// TO:
importEdges = await loadImportsToNeo4j(req.url, resolveResult);
```

### Cypher Parameter Shapes

**Internal IMPORTS batch item:**
```typescript
{
  from_path: string,      // from EnrichedResolvedImport.fromFile
  to_path: string,        // from EnrichedResolvedImport.toFile (non-null for internal)
  symbols: string[],      // from EnrichedResolvedImport.symbols
  resolution_status: string,  // from EnrichedResolvedImport.resolutionStatus
  resolved_path: string | null,  // from EnrichedResolvedImport.resolvedPath
  barrel_hops: number,    // from EnrichedResolvedImport.barrelHops
  unresolved_symbols: string[],  // from EnrichedResolvedImport.unresolvedSymbols
  repo_url: string,       // from repoUrl parameter
}
```

**DIRECTLY_IMPORTS batch item:**
```typescript
{
  from_path: string,          // from DirectlyImportsEdge.fromFile
  symbol_name: string,        // from DirectlyImportsEdge.targetSymbolName
  target_file_path: string,   // from DirectlyImportsEdge.targetFilePath
  import_kind: string,        // from DirectlyImportsEdge.importKind
  alias: string | undefined,  // from DirectlyImportsEdge.alias
  repo_url: string,           // from repoUrl parameter
}
```

---

## 5. Summary of Required Phase 3 Changes

| File | Change | Severity |
|------|--------|----------|
| `loader.ts` line 5 | Change import from `ResolvedImport` to `ResolveResult, EnrichedResolvedImport, DirectlyImportsEdge` | CRITICAL |
| `loader.ts` line 220 | Change `loadImportsToNeo4j` signature to accept `ResolveResult` | CRITICAL |
| `loader.ts` lines 229-248 | Add enrichment fields to internal IMPORTS batch data and Cypher SET | CRITICAL |
| `loader.ts` after line 276 | Add new batch loop for DIRECTLY_IMPORTS edges | CRITICAL |
| `loader.ts` lines 400-418 | Add DIRECTLY_IMPORTS deletion to `purgeImportEdges` | CRITICAL |
| `digest.ts` lines 306, 322 | Pass full `resolveResult` to `loadImportsToNeo4j` | CRITICAL |
| `digest.ts` lines 336-346 | Add resolution stats to output stats object | MODERATE |
| `digest.ts` lines 24-35 | Extend `DigestResult.stats` interface with new fields | MODERATE |
| `neo4j.ts` | Add Constant name index | LOW (existing indexes may suffice) |

## 6. Summary of Required Phase 4 Changes

| File | Change | Severity |
|------|--------|----------|
| `mcp-server/src/index.ts` (get_symbol) | Add OPTIONAL MATCH for DIRECTLY_IMPORTS | MODERATE |
| `mcp-server/src/index.ts` (get_dependencies) | Add second query for DIRECTLY_IMPORTS inbound | MODERATE |
| `mcp-server/src/index.ts` (trace_imports) | Change relationship pattern to `[:IMPORTS\|DIRECTLY_IMPORTS*]`, add symbol node CASE | MODERATE |
| `mcp-server/src/runtime-tools.ts` (trace_error) | Add DIRECTLY_IMPORTS query section | MODERATE |
| All MCP tools | Use OPTIONAL MATCH for backward compat with pre-resolution digests | MODERATE |

---

## 7. Risks and Edge Cases

1. **Neo4j type coercion for `unresolved_symbols`**: The Cypher SET will write a string array. Neo4j handles this natively, but empty arrays `[]` may be stored as null in some Neo4j versions. Phase 3 should use `COALESCE(imp.unresolved_symbols, [])` or ensure the array is always non-empty or omitted.

2. **`barrel_hops` as integer**: Neo4j will store this as a Long. The value `0` (default for non-barrel imports) is fine. No coercion needed.

3. **`alias` field on DIRECTLY_IMPORTS**: The `alias` is optional (`string | undefined`). In the Cypher SET clause `r.alias = di.alias`, if `di.alias` is `undefined`/`null`, Neo4j will set the property to null (or not set it). This is acceptable but Phase 3 should confirm Neo4j handles `undefined` in UNWIND parameters correctly -- it may need to be converted to `null` explicitly in the batch data mapping.

4. **Symbol node existence race**: The plan notes (Contract 6 error path) that if a symbol node doesn't exist in Neo4j when the DIRECTLY_IMPORTS Cypher runs, the edge should be silently skipped. The planned Cypher uses `MATCH` (not `MERGE`), so missing symbol nodes will simply produce no edge. This is correct behavior.
