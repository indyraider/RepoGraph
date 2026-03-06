# Phase 3 Forward-Plan Checkpoint: Interface Extraction + Phase 4 Mismatch Detection

**Date:** 2026-03-06
**Phase completed:** Phase 3 (Loader + Neo4j Schema + Digest Orchestrator)
**Next phase:** Phase 4 (MCP Tool Updates)

---

## 1. Exact Interfaces Written by Phase 3

### 1a. IMPORTS Edge Properties (loader.ts lines 252-263)

Written by `loadImportsToNeo4j()` via Cypher `SET` on `MERGE (from)-[r:IMPORTS]->(to)`:

| Property | Source field | Type | Notes |
|----------|-------------|------|-------|
| `r.symbols` | `imp.symbols` | `string[]` | Already existed pre-Phase 3 |
| `r.resolution_status` | `imp.resolution_status` | `string` | Values: `"resolved"`, `"external"`, `"unresolvable"`, `"dynamic"` |
| `r.resolved_path` | `imp.resolved_path` | `string \| null` | Canonical path after barrel unwinding |
| `r.barrel_hops` | `imp.barrel_hops` | `number` (default `0`) | Count of barrel files traversed |
| `r.unresolved_symbols` | `imp.unresolved_symbols` | `string[]` (default `[]`) | Symbol names that couldn't be matched |

Fallback for pre-enrichment data (loader.ts lines 236-246): when receiving a plain `ResolvedImport[]`, the loader coerces via `as any` with defaults: `resolutionStatus || "resolved"`, `resolvedPath || null`, `barrelHops || 0`, `unresolvedSymbols || []`.

### 1b. DIRECTLY_IMPORTS Edge Properties (loader.ts lines 307-316)

Written by `loadImportsToNeo4j()` via Cypher:

```cypher
MATCH (from:File {path: di.from_path, repo_url: di.repo_url})
OPTIONAL MATCH (sym {name: di.symbol_name, file_path: di.target_file_path, repo_url: di.repo_url})
WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
WITH from, sym, di
WHERE sym IS NOT NULL
MERGE (from)-[r:DIRECTLY_IMPORTS]->(sym)
SET r.import_kind = di.import_kind, r.alias = di.alias
```

| Property | Source field | Type | Notes |
|----------|-------------|------|-------|
| `r.import_kind` | `di.import_kind` | `string` | Values: `"named"`, `"default"`, `"namespace"` |
| `r.alias` | `di.alias` | `string \| null` | Only set for `import * as x` |

### 1c. Node Labels DIRECTLY_IMPORTS Can Point To

The Cypher WHERE clause constrains targets to exactly these labels:
- `Function`
- `Class`
- `TypeDef`
- `Constant`

These are matched via labelless `OPTIONAL MATCH (sym {...})` with a `WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant` guard. The edge is only created when `sym IS NOT NULL` (i.e., the symbol node exists in Neo4j).

### 1d. Neo4j Indexes (neo4j.ts lines 36-47)

New index added in Phase 3:
```
CREATE INDEX constant_name IF NOT EXISTS FOR (c:Constant) ON (c.name)
```

Pre-existing indexes that support DIRECTLY_IMPORTS queries:
- `File.path` (index)
- `Function.name`, `Class.name`, `TypeDef.name`, `Constant.name` (indexes)

Note: Symbol nodes are MERGEd with a composite key of `{name, file_path, repo_url}`, but the indexes are only on `name`. This means Cypher MATCH on `{name, file_path, repo_url}` uses the name index + property filter. Adequate for current scale.

### 1e. Purge (loader.ts lines 445-468)

`purgeImportEdges()` now deletes both relationship types:
1. `MATCH (f:File {repo_url})-[r:IMPORTS]->() DELETE r`
2. `MATCH ()-[r:IMPORTS]->(f:File {repo_url}) DELETE r`
3. `MATCH (f:File {repo_url})-[r:DIRECTLY_IMPORTS]->() DELETE r` (new)

---

## 2. Mismatch Detection for Phase 4

### 2a. get_symbol: OPTIONAL MATCH for DIRECTLY_IMPORTS

**Plan says (Phase 4 checklist):**
> Add `OPTIONAL MATCH (importer:File)-[di:DIRECTLY_IMPORTS]->(sym)` alongside existing IMPORTS query. Collect `directly_imported_by`.

**Current Cypher (index.ts lines 254-267, repo-scoped variant):**
```cypher
MATCH (f:File {repo_url: repoUrl})-[:CONTAINS]->(sym {name: $name})
OPTIONAL MATCH (caller:Function)-[:CALLS]->(sym)
OPTIONAL MATCH (cf:File)-[:CONTAINS]->(caller)
OPTIONAL MATCH (importer:File)-[imp:IMPORTS]->(f)
WHERE $name IN imp.symbols
RETURN ... collect(DISTINCT importer.path) AS imported_by
```

**Required change:** Add after the existing OPTIONAL MATCHes:
```cypher
OPTIONAL MATCH (directImporter:File)-[di:DIRECTLY_IMPORTS]->(sym)
```
Then collect: `collect(DISTINCT directImporter.path) AS directly_imported_by`

**STATUS: COMPATIBLE.** The `sym` variable from the initial MATCH is the exact target of DIRECTLY_IMPORTS edges. The OPTIONAL MATCH pattern `(File)-[:DIRECTLY_IMPORTS]->(sym)` will correctly traverse incoming DIRECTLY_IMPORTS edges to the symbol node. No type mismatch.

**Backward compat:** OPTIONAL MATCH returns null rows when no DIRECTLY_IMPORTS edges exist, so pre-resolution repos will simply show an empty `directly_imported_by` list. SAFE.

### 2b. get_dependencies inbound: DIRECTLY_IMPORTS query

**Plan says:**
```cypher
MATCH (source:File)-[r:DIRECTLY_IMPORTS]->(sym)<-[:CONTAINS]-(f:File {path: $path})
RETURN source.path AS source_path, sym.name AS symbol_name, r.import_kind AS import_kind
```

**Verification against actual graph structure:**
- Loader writes: `(File)-[:DIRECTLY_IMPORTS]->(Function|Class|TypeDef|Constant)`
- Loader writes: `(File)-[:CONTAINS]->(Function|Class|TypeDef|Constant)` (loadSymbolsToNeo4j, lines 100-186)
- So the pattern `(source:File)-[:DIRECTLY_IMPORTS]->(sym)<-[:CONTAINS]-(f:File {path: $path})` correctly joins through the symbol node.

**STATUS: COMPATIBLE.** The join pattern `source -[DIRECTLY_IMPORTS]-> sym <-[CONTAINS]- f` correctly traverses the graph. The `sym` node is the same node pointed to by both CONTAINS (from the defining file) and DIRECTLY_IMPORTS (from the importing file).

**Edge property available:** `r.import_kind` is written by the loader as `di.import_kind`. MATCHES.

**Backward compat:** When no DIRECTLY_IMPORTS edges exist, this MATCH returns zero rows. The plan says to "merge results with existing IMPORTS-based inbound query" so the tool still returns IMPORTS-based results. SAFE.

### 2c. trace_imports: Mixed relationship traversal `[:IMPORTS|DIRECTLY_IMPORTS*1..N]`

**Plan says:**
> Change relationship pattern to `[:IMPORTS|DIRECTLY_IMPORTS*1..${depth}]`

**Current Cypher (index.ts line 419):**
```cypher
MATCH path = (start:File {path: $startPath})-[:IMPORTS*1..${depth}]->(target)
```

**ISSUE FOUND: Mixed node types in variable-length path.**

The current IMPORTS edges connect:
- `File -> File` (internal imports)
- `File -> Package` (external imports)

The new DIRECTLY_IMPORTS edges connect:
- `File -> Function|Class|TypeDef|Constant`

If we use `[:IMPORTS|DIRECTLY_IMPORTS*1..N]`, a path could be:
```
File -[IMPORTS]-> File -[DIRECTLY_IMPORTS]-> Function
```
This terminates at a Function node. The next hop would need an outgoing IMPORTS or DIRECTLY_IMPORTS from a Function node, which doesn't exist. So the path naturally terminates. This is correct behavior.

However, a path could also try:
```
File -[DIRECTLY_IMPORTS]-> Function -[???]->
```
Function nodes have no outgoing IMPORTS or DIRECTLY_IMPORTS edges, so this is a dead-end at hop 1. The traversal would return 1-hop paths that are just `File -> Symbol`.

**CONCERN:** This could cause an explosion of short paths (every DIRECTLY_IMPORTS edge produces a 1-hop path) mixed in with the meaningful multi-hop File->File chains. The results become noisy.

**RECOMMENDATION:** Instead of mixing relationship types in the variable-length pattern, keep the traversal as `[:IMPORTS*1..N]` for the multi-hop chain, and add a separate non-recursive query for DIRECTLY_IMPORTS on the start file only. OR use a more selective approach:
```cypher
MATCH path = (start:File {path: $startPath})-[:IMPORTS*1..${depth}]->(target)
RETURN ...
UNION
MATCH (start:File {path: $startPath})-[di:DIRECTLY_IMPORTS]->(sym)
MATCH (symFile:File)-[:CONTAINS]->(sym)
RETURN [start.path, sym.name + ' in ' + symFile.path] AS chain, [[di.import_kind]] AS symbols
```

**The CASE formatting in the plan also needs verification:**
```cypher
CASE WHEN n:File THEN n.path
     WHEN n:Package THEN 'pkg:' + n.name
     WHEN n:Function OR n:Class OR n:TypeDef OR n:Constant THEN n.name + ' in ' + n.file_path
     ELSE n.name END
```
This is valid Cypher syntax. The `n.file_path` property exists on all symbol nodes (loader writes `file_path` as a MERGE key). COMPATIBLE.

**STATUS: FUNCTIONAL BUT NOISY.** The mixed traversal will work without errors but will produce short dead-end paths for every DIRECTLY_IMPORTS edge. Consider the UNION approach instead.

### 2d. trace_error: Separate DIRECTLY_IMPORTS query

**Plan says:**
```cypher
MATCH (f:File {path: $filePath})-[r:DIRECTLY_IMPORTS]->(sym)
MATCH (symFile:File)-[:CONTAINS]->(sym)
RETURN sym.name AS symbol_name, symFile.path AS definition_file,
       labels(sym)[0] AS symbol_type, r.import_kind AS import_kind
```

**Current trace_error code (runtime-tools.ts lines 438-454):** The existing IMPORTS query is at lines 438-443. The plan adds the DIRECTLY_IMPORTS query after it.

**Verification against actual edge properties:**
- `r.import_kind` -- written by loader as `di.import_kind`. MATCHES.
- `labels(sym)[0]` -- symbol nodes have labels `Function`, `Class`, `TypeDef`, `Constant`. WORKS.
- `sym.name` -- exists on all symbol nodes. WORKS.
- `symFile.path` via `(symFile:File)-[:CONTAINS]->(sym)` -- CONTAINS edges are created in loadSymbolsToNeo4j. WORKS.

**One subtlety:** `labels(sym)[0]` returns the first label. Neo4j does not guarantee label order, but since each symbol node has exactly one label, this is safe.

**STATUS: FULLY COMPATIBLE.** No mismatches.

**Backward compat:** When no DIRECTLY_IMPORTS edges exist, the MATCH returns zero rows. The plan adds this under a new `### Direct Symbol Imports` section, so it simply won't appear. SAFE.

---

## 3. Hook Points Summary for Phase 4 Implementation

### 3a. Exact Cypher Relationship Patterns MCP Tools Need

| Tool | Pattern | Purpose |
|------|---------|---------|
| `get_symbol` | `OPTIONAL MATCH (di_file:File)-[di:DIRECTLY_IMPORTS]->(sym)` | Find direct importers of a symbol |
| `get_dependencies` (inbound) | `MATCH (source:File)-[r:DIRECTLY_IMPORTS]->(sym)<-[:CONTAINS]-(f:File {path: $path})` | Find files that directly import symbols defined in a file |
| `trace_imports` | See recommendation in 2c above | Multi-hop traversal with symbol awareness |
| `trace_error` | `MATCH (f:File {path: $filePath})-[r:DIRECTLY_IMPORTS]->(sym)` + `MATCH (symFile:File)-[:CONTAINS]->(sym)` | Show symbol-level imports of the error file |

### 3b. Exact Property Names on Edges

**IMPORTS edge properties (for reference in Phase 4 output formatting):**
- `r.symbols` (string[])
- `r.resolution_status` (string)
- `r.resolved_path` (string|null)
- `r.barrel_hops` (number)
- `r.unresolved_symbols` (string[])

**DIRECTLY_IMPORTS edge properties (used by Phase 4 queries):**
- `r.import_kind` (string: "named"|"default"|"namespace")
- `r.alias` (string|null)

### 3c. Backward Compatibility Summary

| Scenario | Behavior |
|----------|----------|
| Pre-resolution repo (no DIRECTLY_IMPORTS edges) | All OPTIONAL MATCH / separate MATCH queries return zero rows. Tools fall back to IMPORTS-only results. |
| Pre-resolution repo (no enriched IMPORTS properties) | `r.resolution_status`, `r.resolved_path`, `r.barrel_hops`, `r.unresolved_symbols` will be null/missing. MCP tools should not depend on these unless checking. |
| Mixed repo (partial re-digest) | `purgeImportEdges()` deletes all IMPORTS + DIRECTLY_IMPORTS before reloading, so no stale edges survive a re-digest. |

---

## 4. Risks and Recommendations

### Risk 1: trace_imports noise from mixed traversal (MEDIUM)
As detailed in 2c, using `[:IMPORTS|DIRECTLY_IMPORTS*1..N]` will produce short dead-end paths for every DIRECTLY_IMPORTS edge. **Recommend:** Use UNION approach or keep variable-length traversal on IMPORTS only and add a supplementary DIRECTLY_IMPORTS query for the start node.

### Risk 2: get_symbol label filter gap (LOW)
The current `get_symbol` tool only accepts `kind` values of `"function"`, `"class"`, `"type"` -- mapping to `Function`, `Class`, `TypeDef` labels. There is no option for `"constant"`. Since DIRECTLY_IMPORTS can point to `Constant` nodes, a user looking up a constant by name cannot use `get_symbol` with a kind filter. This is a pre-existing limitation, not introduced by Phase 3, but worth noting for Phase 4.

### Risk 3: OPTIONAL MATCH cartesian product in get_symbol (LOW)
Adding another OPTIONAL MATCH to get_symbol's already-chained query increases the risk of cartesian product explosion when a symbol has many callers AND many importers AND many direct importers. The `collect(DISTINCT ...)` aggregation mitigates this, but consider using `WITH` clauses to aggregate intermediate results before the next OPTIONAL MATCH to prevent row multiplication.

---

## 5. Verdict

**Phase 3 output is compatible with Phase 4 requirements.** All property names, edge directions, node labels, and join patterns match between what the loader writes and what the planned MCP queries expect. The one actionable finding is the `trace_imports` mixed-traversal noise issue (Risk 1), which should be addressed during Phase 4 implementation by using a UNION query approach rather than a single mixed variable-length path pattern.
