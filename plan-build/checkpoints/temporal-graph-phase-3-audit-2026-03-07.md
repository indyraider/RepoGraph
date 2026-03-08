# Phase 3 Audit: Diff Engine
**Date:** 2026-03-07
**File:** `packages/backend/src/pipeline/differ.ts`
**Plan:** `plan-build/planning/temporal-graph-plan-2026-03-07.md`
**Verdict:** PASS WITH ISSUES (5 issues: 1 bug, 2 gaps, 2 minor)

---

## Checklist Verification

| Checklist Item | Status | Notes |
|---|---|---|
| Create `differ.ts` | DONE | File exists at expected path |
| Define `GraphChangeset` type | DONE | Lines 41-52; uses flat `NodeChange[]`/`EdgeChange[]` arrays with `changeType` discriminator — differs from Contract 5 structure (see Issue 1) |
| Define `VersionedNode` type | REPLACED | Plan said `VersionedNode`; implementation uses `GraphNodeSnapshot` instead. Functionally equivalent — captures symbol identity + tracked properties. Acceptable. |
| Define `VersionedEdge` type | REPLACED | Plan said `VersionedEdge`; implementation uses `GraphEdgeSnapshot`. Same rationale. Acceptable. |
| `fetchPreviousGraphState(repoUrl)` | DONE | Lines 85-186; queries nodes, IMPORTS edges, CALLS edges |
| `diffNodes(...)` | DONE (inline) | Logic is inlined in `diffGraph()` rather than a separate function. Acceptable. |
| `diffEdges(...)` | DONE (inline) | Same — inlined for IMPORTS and CALLS edges |
| Identity matching edge cases (overloaded functions, re-exports) | NOT HANDLED | See Issue 4 |
| Return `GraphChangeset` from `diffGraph()` | DONE | Line 336 |
| Wire into `runDigest()` | NOT DONE | See Issue 3 |
| Unit tests | NOT DONE | See Issue 5 |

---

## Issue 1 (STRUCTURAL MISMATCH): `GraphChangeset` shape differs from Contract 5

**Severity:** Medium — will require Phase 4 to adapt

**Contract 5 specifies:**
```typescript
GraphChangeset: {
  created: { nodes: VersionedNode[], edges: VersionedEdge[] },
  modified: { nodes: { old: VersionedNode, new: VersionedNode }[], edges: ... },
  deleted: { nodes: VersionedNode[], edges: VersionedEdge[] }
}
```

**Actual implementation:**
```typescript
GraphChangeset: {
  nodes: NodeChange<GraphNodeSnapshot>[],   // flat array, changeType discriminator
  edges: EdgeChange[],                       // flat array, changeType discriminator
  stats: { nodesCreated, nodesModified, ... }
}
```

The actual structure is a flat list with `changeType: "created" | "modified" | "deleted"` on each entry, plus `old?` and `new?` optional fields. This is actually a reasonable design — the temporal loader in Phase 4 can filter by `changeType`. But the contract and implementation disagree.

**Impact:** Phase 4's `temporalLoad()` must consume the flat-list shape, not the nested shape from Contract 5. This is fine as long as the Phase 4 author reads the actual types, not just the plan.

**Recommendation:** Update Contract 5 in the plan to match reality, or note that the flat shape is the authoritative version.

---

## Issue 2 (BUG): DIRECTLY_IMPORTS edges are NOT diffed

**Severity:** High — data loss for temporal tracking of symbol-level imports

The `PreviousGraphState` type declares `directImportsEdges: Map<string, GraphEdgeSnapshot>` (line 77), and the `directImportsEdgeKey()` helper exists (line 64), and `DirectlyImportsEdge` is imported from resolver.ts (line 3).

**However:**
1. `fetchPreviousGraphState()` never queries DIRECTLY_IMPORTS edges from Neo4j — no Cypher query for them. The `directImportsEdges` map is initialized empty and stays empty.
2. `diffGraph()` accepts `currentImports: EnrichedResolvedImport[]` and `currentCalls: CallsEdge[]` but does NOT accept `DirectlyImportsEdge[]` as a parameter.
3. No diff logic exists for DIRECTLY_IMPORTS edges anywhere in the function.

The `DirectlyImportsEdge` import on line 3 is unused — it exists as if the author intended to add support but didn't.

**Impact:** In temporal mode, DIRECTLY_IMPORTS edges will not be versioned. They'll continue to use the purge-and-reload strategy from the existing loader, destroying temporal history for symbol-level import edges.

**Fix required:** Add a fourth parameter `currentDirectImports: DirectlyImportsEdge[]` to `diffGraph()`, add a Cypher query to `fetchPreviousGraphState()` fetching DIRECTLY_IMPORTS edges, and add diff logic parallel to the IMPORTS edge diff. The identity key helper already exists.

---

## Issue 3 (GAP): Not wired into `runDigest()`

**Severity:** Expected — the checklist says "Wire into `runDigest()` — call after resolve, before load" but the plan also places this in Phase 3's checklist.

Grep confirms `diffGraph` and `GraphChangeset` are not referenced anywhere in `digest.ts`. The function exists in isolation.

**Assessment:** The plan is ambiguous — the wiring checklist item is under Phase 3, but the Build Order section says Phase 4 handles "Temporal Loader + Orchestrator" including `digest.ts` modifications. This is likely intentional deferral to Phase 4. However, this means Phase 3 cannot be integration-tested until Phase 4 wires it in.

---

## Issue 4 (MINOR): No overloaded function handling

**Severity:** Low — edge case, acceptable for initial implementation

The checklist says "Handle identity matching edge cases: overloaded functions (use signature as tiebreaker), re-exports."

`symbolIdentityKey()` uses `${filePath}::${name}` — no signature component. If a file has two functions with the same name (e.g., TypeScript overload declarations), they'll collide on the same key and only the last one processed will survive.

In practice, the parser likely emits separate `ParsedSymbol` entries for overloads. With the current key, the Map will silently overwrite earlier entries for the same name in the same file, causing phantom "modified" changes or missed deletes.

**Assessment:** This is a known limitation. TypeScript function overloads sharing a name in the same file are uncommon in the wild. Adding signature to the key would require the same change in loader.ts's MERGE keys, which would be a larger change. Acceptable to defer, but should be documented.

---

## Issue 5 (GAP): No unit tests

**Severity:** Medium — the checklist explicitly requires them

The checklist says: "Unit tests: synthetic graph states with known diffs (add/modify/delete function, add/remove import)."

No test files found:
- No `differ.test.ts` or `differ.spec.ts` anywhere in the repo
- No test directory entries matching differ

**Assessment:** The diff engine is the highest-risk component (plan says "4-5 hours, highest risk — needs thorough testing"). The lack of tests means correctness is unverified except by code review. The pure diff logic (comparing Maps, building changesets) is highly testable — `diffGraph()` could be tested by mocking `fetchPreviousGraphState()`.

---

## Execution Chain Verification

### Import verification

| Import | Module exists? | Symbol exported? | Used correctly? |
|---|---|---|---|
| `getSession` from `../db/neo4j.js` | Yes | Yes (`getSession()`) | Yes — returns `Session`, used for `.run()` and `.close()` |
| `ParsedSymbol` from `./parser.js` | Yes | Yes (interface) | Yes — `diffGraph()` reads `kind`, `name`, `filePath`, `signature`, `docstring`, `startLine`, `endLine`, `resolvedSignature` — all exist on `ParsedSymbol` |
| `EnrichedResolvedImport` from `./resolver.js` | Yes | Yes (interface) | Yes — `diffGraph()` reads `fromFile`, `toFile`, `symbols`, `resolutionStatus` — all exist on `EnrichedResolvedImport` |
| `DirectlyImportsEdge` from `./resolver.js` | Yes | Yes (interface) | **UNUSED** — imported but never referenced in any function body (see Issue 2) |
| `CallsEdge` from `./scip/types.js` | Yes | Yes (interface) | Yes — `diffGraph()` reads `callerFilePath`, `callerName`, `calleeFilePath`, `calleeName`, `callSiteLine` — all exist on `CallsEdge` |

### Identity key compatibility with loader.ts

| Key function in differ.ts | MERGE key in loader.ts | Match? |
|---|---|---|
| `symbolIdentityKey(filePath, name)` → `"path::name"` | `MERGE (fn:Function {name, file_path, repo_url})` | **Partial** — differ key omits `repo_url`. This is safe because `fetchPreviousGraphState()` already filters by `repo_url` in the WHERE clause, so all returned nodes are scoped to one repo. The keys are unique within a single repo's context. |
| `importsEdgeKey(fromPath, toPath)` | `MERGE (from)-[r:IMPORTS]->(to)` matched by `File {path, repo_url}` | Compatible — same from/to path identity |
| `callsEdgeKey(callerFile, callerName, calleeFile, calleeName)` | `MERGE (caller)-[r:CALLS]->(callee)` matched by `{name, file_path, repo_url}` | Compatible — same 4-field identity |

### Cypher query verification

| Query | Property names correct? | Schema match? |
|---|---|---|
| Node query: `sym.valid_to`, `sym.name`, `sym.file_path`, `sym.signature`, `sym.definition`, `sym.value_preview`, `sym.docstring`, `sym.start_line`, `sym.end_line`, `sym.resolved_signature` | Yes | All match loader.ts SET clauses. `coalesce(sym.signature, sym.definition, sym.value_preview, '')` correctly handles TypeDef (uses `definition`) and Constant (uses `value_preview`) |
| IMPORTS query: `r.valid_to`, `from.path`, `to.path`, `r.symbols`, `r.resolution_status` | Yes | Match loader.ts line 274-278 SET clauses |
| CALLS query: `r.valid_to`, `caller.file_path`, `caller.name`, `callee.file_path`, `callee.name`, `r.call_site_line` | Yes | Match loader.ts line 556-559 SET clauses |
| Temporal filter: `valid_to IS NULL OR NOT EXISTS(valid_to)` | Yes | Correct for backward compat with non-temporal repos |

### Data flow: ParsedSymbol → GraphNodeSnapshot mapping

Line-by-line verification of `diffGraph()` lines 226-235:
- `sym.kind` → `curr.kind` — direct mapping, same type
- `sym.name` → `curr.name` — direct mapping
- `sym.filePath` → `curr.filePath` — direct mapping
- `sym.signature` → `curr.signature` — direct mapping
- `sym.docstring` → `curr.docstring` — direct mapping
- `sym.startLine` → `curr.startLine` — direct mapping
- `sym.endLine` → `curr.endLine` — direct mapping
- `sym.resolvedSignature` → `curr.resolvedSignature` — direct mapping, both optional

All fields exist on `ParsedSymbol` (parser.ts lines 14-28). No type mismatch.

### Comparison to Neo4j-fetched snapshots

The `fetchPreviousGraphState` Cypher uses `coalesce(sym.signature, sym.definition, sym.value_preview, '')` to normalize across node types into a single `signature` field. The current pipeline's `ParsedSymbol.signature` holds `definition` for TypeDefs and `value_preview` for Constants at the parser level — so `coalesce` correctly aligns them.

However: the `symbolChanged()` comparison (line 191-198) will flag TypeDef/Constant as "modified" if the graph stores `definition`/`value_preview` but the parser produces a slightly different string in `signature`. This should work correctly since the coalesce picks the right field.

---

## Stubs and Placeholders

None found. All functions have complete implementations. No TODO/FIXME comments in the file. No empty function bodies.

---

## Summary of Required Actions

1. **[BUG] Add DIRECTLY_IMPORTS edge diffing** — fetch from Neo4j, accept in `diffGraph()`, diff against current `DirectlyImportsEdge[]`. The plumbing (type, key function, Map field) is already scaffolded but not wired.
2. **[GAP] Write unit tests** — mock `fetchPreviousGraphState()`, test add/modify/delete scenarios for nodes and all three edge types.
3. **[DOCUMENTATION] Update Contract 5** — note that `GraphChangeset` uses flat arrays with `changeType` discriminator, not nested `created/modified/deleted` groups. Phase 4 must consume the actual shape.
4. **[DEFERRED] Wiring into `runDigest()`** — expected to happen in Phase 4 per Build Order. Acceptable.
5. **[DEFERRED] Overloaded function handling** — acceptable to defer, document the limitation.
