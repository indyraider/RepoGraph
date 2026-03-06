# Phase 4 Forward Plan Review
**Phase completed:** MCP Tool Updates (Final Phase)
**Date:** 2026-03-06
**Plan updates needed:** NO

## Actual Interfaces Built

### get_symbol (index.ts lines 253-282)

**Cypher query pattern (both repo-scoped and unscoped variants):**
```cypher
MATCH (f:File)-[:CONTAINS]->(sym{labelFilter} {name: $name})
OPTIONAL MATCH (caller:Function)-[:CALLS]->(sym)
OPTIONAL MATCH (cf:File)-[:CONTAINS]->(caller)
OPTIONAL MATCH (importer:File)-[imp:IMPORTS]->(f)
WHERE $name IN imp.symbols
OPTIONAL MATCH (directImporter:File)-[di:DIRECTLY_IMPORTS]->(sym)
RETURN sym.name AS name, labels(sym)[0] AS kind,
       sym.signature AS signature, sym.docstring AS docstring,
       sym.start_line AS start_line, sym.end_line AS end_line,
       f.path AS file_path,
       collect(DISTINCT {caller: caller.name, file: cf.path}) AS callers,
       collect(DISTINCT importer.path) AS imported_by,
       collect(DISTINCT {file: directImporter.path, kind: di.import_kind, alias: di.alias}) AS directly_imported_by
```

**New output fields:** `directly_imported_by` array of `{file, kind, alias}`
**Graceful degradation:** Uses `OPTIONAL MATCH` for DIRECTLY_IMPORTS -- old digests with no DIRECTLY_IMPORTS edges return empty arrays.
**Output formatting:** New section "Directly imported by:" with format `- {file} ({kind}{alias})`

**Properties read from DIRECTLY_IMPORTS edge:** `di.import_kind`, `di.alias`

### get_dependencies (index.ts lines 399-413)

**New Cypher query (inbound direction only):**
```cypher
MATCH (source:File)-[di:DIRECTLY_IMPORTS]->(sym)<-[:CONTAINS]-(f:File {path: $path})
WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
RETURN source.path AS source_path, sym.name AS symbol_name,
       di.import_kind AS import_kind, di.alias AS alias
```

**New output fields:** `source_path`, `symbol_name`, `import_kind`, `alias`
**Graceful degradation:** Separate query with `MATCH` (not `OPTIONAL MATCH`), but results are additive -- if no DIRECTLY_IMPORTS edges exist, the section simply does not appear.
**Output formatting:** Section "Directly imports (symbol-level):" with format `<- {source_path} -> {symbol_name} ({import_kind}{alias})`

**Properties read from DIRECTLY_IMPORTS edge:** `di.import_kind`, `di.alias`

### trace_imports (index.ts lines 450-522)

**File-level chain query (unchanged):**
```cypher
MATCH path = (start:File {path: $startPath}){dir}-[:IMPORTS*1..${depth}]-{dirEnd}(target)
RETURN [...] AS chain, [...] AS symbols, 'file' AS trace_type
LIMIT 50
```

**New symbol-level query (upstream direction):**
```cypher
MATCH (start:File {path: $startPath})-[di:DIRECTLY_IMPORTS]->(sym)
WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
OPTIONAL MATCH (f:File)-[:CONTAINS]->(sym)
RETURN sym.name AS symbol_name, labels(sym)[0] AS symbol_kind,
       f.path AS target_file, di.import_kind AS import_kind, di.alias AS alias
```

**New symbol-level query (downstream direction):**
```cypher
MATCH (source:File)-[di:DIRECTLY_IMPORTS]->(sym)<-[:CONTAINS]-(start:File {path: $startPath})
WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
RETURN sym.name AS symbol_name, labels(sym)[0] AS symbol_kind,
       source.path AS source_file, di.import_kind AS import_kind, di.alias AS alias
```

**Graceful degradation:** Two separate queries -- file-level chains via IMPORTS, and symbol-level via DIRECTLY_IMPORTS. Either or both can be empty. The "No import chains found" message triggers only when both return 0 records.
**Output formatting:** Two sections: "File-level chains" and "Symbol-level direct imports" with format `{start} -> {sym} ({kind}) in {target}{alias}`

**Properties read from DIRECTLY_IMPORTS edge:** `di.import_kind`, `di.alias`

**Plan deviation:** The plan suggested using `[:IMPORTS|DIRECTLY_IMPORTS*1..${depth}]` for a combined traversal. The actual implementation uses two separate queries instead. This is a **better** approach because DIRECTLY_IMPORTS edges point to symbol nodes (Function/Class/TypeDef/Constant), not File nodes, making a combined variable-length path traversal semantically incorrect -- you cannot chain IMPORTS (File->File) with DIRECTLY_IMPORTS (File->Symbol) in a single multi-hop path.

### trace_error (runtime-tools.ts lines 457-474)

**New Cypher query:**
```cypher
MATCH (f:File {path: $filePath})-[di:DIRECTLY_IMPORTS]->(sym)
WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
OPTIONAL MATCH (tf:File)-[:CONTAINS]->(sym)
RETURN sym.name AS symbol_name, labels(sym)[0] AS symbol_kind,
       tf.path AS target_file, di.import_kind AS import_kind, di.alias AS alias
```

**New output fields:** `symbol_name`, `symbol_kind`, `target_file`, `import_kind`, `alias`
**Graceful degradation:** Separate query -- if no DIRECTLY_IMPORTS edges exist, the section simply does not appear.
**Output formatting:** Section "Direct symbol imports from {filePath}:" with format `- -> {symbol_name} ({symbol_kind}) in {target_file}{alias}`

**Properties read from DIRECTLY_IMPORTS edge:** `di.import_kind`, `di.alias`

---

## End-to-End Verification

### Parser -> Resolver (Contract 1)
- **Parser** (parser.ts): `parseTypeScript` produces `BarrelInfo` with `kind` ("strict"|"hybrid") and `reExports` array containing `{symbols, source, isWildcard}`. Returned as `barrel` field on `ParseResult`.
- **Digest** (digest.ts line 249): Collects barrel info into `barrelMap: Map<string, BarrelInfo>`.
- **VERIFIED:** Types match. Parser produces BarrelInfo, digest aggregates into a Map, resolver consumes it.

### Resolver -> Loader (Contract 5)
- **Resolver** (resolver.ts): Returns `ResolveResult` containing `imports: EnrichedResolvedImport[]` and `directImports: DirectlyImportsEdge[]`.
- **DirectlyImportsEdge** fields: `fromFile`, `targetSymbolName`, `targetFilePath`, `importKind`, `alias` (optional).
- **VERIFIED:** Types match between resolver output and loader input.

### Loader -> Neo4j (Contract 6) -- DIRECTLY_IMPORTS edge write

**Loader writes (loader.ts lines 307-316):**
```cypher
MERGE (from)-[r:DIRECTLY_IMPORTS]->(sym)
SET r.import_kind = di.import_kind, r.alias = di.alias
```

**Properties written to DIRECTLY_IMPORTS edge:**
| Property | Source field |
|----------|------------|
| `import_kind` | `di.importKind` (mapped to `di.import_kind` at line 299) |
| `alias` | `di.alias` (mapped, null-coalesced at line 300) |

**Loader writes (loader.ts lines 252-262) -- enriched IMPORTS edge:**
```cypher
SET r.symbols = imp.symbols,
    r.resolution_status = imp.resolution_status,
    r.resolved_path = imp.resolved_path,
    r.barrel_hops = imp.barrel_hops,
    r.unresolved_symbols = imp.unresolved_symbols
```

### MCP Tools read from Neo4j -- Property alignment check

**DIRECTLY_IMPORTS edge properties:**

| Property | Written by Loader | Read by get_symbol | Read by get_dependencies | Read by trace_imports | Read by trace_error |
|----------|:-:|:-:|:-:|:-:|:-:|
| `import_kind` | YES (line 315) | YES (`di.import_kind`) | YES (`di.import_kind`) | YES (`di.import_kind`) | YES (`di.import_kind`) |
| `alias` | YES (line 315) | YES (`di.alias`) | YES (`di.alias`) | YES (`di.alias`) | YES (`di.alias`) |

**RESULT: EXACT MATCH.** All MCP tools read the exact same two properties (`import_kind`, `alias`) that the loader writes. No phantom property reads.

### Loader -> Neo4j -- DIRECTLY_IMPORTS node matching

**Loader MATCH pattern (line 310-311):**
```cypher
OPTIONAL MATCH (sym {name: di.symbol_name, file_path: di.target_file_path, repo_url: di.repo_url})
WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
```

**MCP tools MATCH pattern (consistent across all 4 tools):**
```cypher
WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
```

**RESULT: CONSISTENT.** The loader uses `OPTIONAL MATCH` (graceful skip if symbol node doesn't exist). All MCP tools reading DIRECTLY_IMPORTS also include the same `WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant` label filter where they traverse into symbol nodes.

### Digest orchestration (Contract 8 & 9)
- **digest.ts line 266:** `resolveImports(allImports, scanPath, allExports, allSymbols, barrelMap)` -- passes all required data.
- **digest.ts line 317:** `loadImportsToNeo4j(req.url, resolveResult)` -- passes full ResolveResult.
- **digest.ts line 333:** Same for full-reload path.
- **digest.ts line 347-358:** Stats include all resolution stats: `directImportCount`, `resolvedImports`, `unresolvedImports`, `dynamicImports`, `externalImports`, `unresolvedSymbols`, `barrelCycles`, `barrelDepthExceeded`.
- **VERIFIED:** Complete wiring.

### Purge (Contract 7)
- **loader.ts lines 461-465:** `purgeImportEdges` deletes both `IMPORTS` and `DIRECTLY_IMPORTS` edges.
- **VERIFIED:** Both edge types are purged on re-digest.

---

## Completeness Check

### MCP tools NOT updated (verification they don't need DIRECTLY_IMPORTS)

| Tool | File | Queries IMPORTS? | Needs DIRECTLY_IMPORTS? | Rationale |
|------|------|:-:|:-:|-----------|
| `search_code` | index.ts:55 | NO (Supabase only) | NO | Full-text search against file contents, no graph queries |
| `get_file` | index.ts:109 | NO (Supabase only) | NO | Retrieves file content from Supabase |
| `get_repo_structure` | index.ts:164 | NO | NO | File tree query (CONTAINS_FILE edges only) |
| `get_upstream_dep` | index.ts:533 | NO | NO | Queries Package/PackageExport nodes, not file imports |
| `query_graph` | index.ts:625 | Passthrough (raw Cypher) | NO | Users can query DIRECTLY_IMPORTS via raw Cypher if desired |
| `get_recent_logs` | runtime-tools.ts:61 | NO (Supabase only) | NO | Runtime log queries |
| `search_logs` | runtime-tools.ts:117 | NO (Supabase only) | NO | Runtime log search |
| `get_deploy_errors` | runtime-tools.ts:181 | NO (Supabase only) | NO | Deployment error queries |
| `get_deployment_history` | runtime-tools.ts:273 | NO (Supabase only) | NO | Deployment history |

**RESULT:** No tools were missed. All tools that query IMPORTS edges (get_symbol, get_dependencies, trace_imports, trace_error) have been updated.

### Enriched IMPORTS edge properties -- surfaced vs. available

| IMPORTS Property | Written by Loader | Surfaced by MCP tools? | Notes |
|------------------|:-:|:-:|-------|
| `symbols` | YES | YES (all tools that read IMPORTS) | Pre-existing |
| `resolution_status` | YES | NO | **Opportunity** -- could filter/display import health |
| `resolved_path` | YES | NO | **Opportunity** -- could show barrel-resolved target |
| `barrel_hops` | YES | NO | **Opportunity** -- could surface barrel depth info |
| `unresolved_symbols` | YES | NO | **Opportunity** -- could surface failed symbol matches |

These four enriched IMPORTS properties are written to Neo4j but NOT currently surfaced by any MCP tool. This is not a bug -- the DIRECTLY_IMPORTS edges provide the primary value. The enriched IMPORTS properties are more useful for diagnostics/observability.

---

## New Opportunities

### Immediate (low-effort, high-value)

1. **"Find all importers of symbol X" first-class query.** With DIRECTLY_IMPORTS edges, `get_symbol` already shows this. A dedicated tool or query_graph example could make it more discoverable. Example Cypher: `MATCH (f:File)-[di:DIRECTLY_IMPORTS]->(sym {name: $name}) RETURN f.path, di.import_kind`

2. **Surface `resolution_status` in get_dependencies.** The outbound IMPORTS query could show which imports are `resolved` vs `unresolvable` vs `external` vs `dynamic`. This helps developers identify broken imports.

3. **Surface `barrel_hops` in get_dependencies outbound.** When a file imports through barrel files, showing `barrel_hops: 3` tells the developer their import passes through 3 re-export layers.

### Medium-term (moderate effort)

4. **Impact analysis tool.** "If I change function X, what files are affected?" Query: `MATCH (f:File)-[:DIRECTLY_IMPORTS]->(sym:Function {name: $name}) RETURN f.path` gives precise answers without the false positives of file-level IMPORTS.

5. **Dead export detection.** Find exported symbols with zero incoming DIRECTLY_IMPORTS edges: `MATCH (f:File)-[:EXPORTS]->(sym) WHERE NOT (()-[:DIRECTLY_IMPORTS]->(sym)) RETURN sym.name, f.path`

6. **Barrel complexity report.** Surface barrel_hops statistics to identify deeply nested re-export chains that slow build times: `MATCH ()-[r:IMPORTS]->() WHERE r.barrel_hops > 2 RETURN r.resolved_path, r.barrel_hops ORDER BY r.barrel_hops DESC`

### Future (larger scope)

7. **Cross-repo DIRECTLY_IMPORTS.** When multiple repos are digested, DIRECTLY_IMPORTS could be extended to link to upstream package symbols (Package -> PackageExport) for full cross-boundary tracing.

8. **Namespace import resolution.** Currently, `import * as X` creates a DIRECTLY_IMPORTS edge with `import_kind: "namespace"` pointing at the target file. Future enhancement: when CALLS edges reference `X.method`, resolve those to specific symbol nodes.

---

## Summary

Phase 4 is **complete and correct**. All four MCP tools (get_symbol, get_dependencies, trace_imports, trace_error) have been updated to query DIRECTLY_IMPORTS edges alongside existing IMPORTS edges.

**Key findings:**

1. **Property alignment is exact.** The loader writes `import_kind` and `alias` to DIRECTLY_IMPORTS edges. All four MCP tools read exactly these two properties. No mismatches.

2. **Graceful degradation is properly implemented.** All tools use either `OPTIONAL MATCH` or separate additive queries for DIRECTLY_IMPORTS, ensuring backward compatibility with pre-resolution digests.

3. **One positive deviation from plan.** `trace_imports` uses two separate queries (file-level IMPORTS chains + symbol-level DIRECTLY_IMPORTS) instead of the plan's suggested combined `[:IMPORTS|DIRECTLY_IMPORTS*1..N]` traversal. This is correct because the two edge types connect different node types (File->File vs File->Symbol), making combined multi-hop traversal semantically invalid.

4. **No tools were missed.** The five remaining tools (search_code, get_file, get_repo_structure, get_upstream_dep, query_graph) and five runtime tools (get_recent_logs, search_logs, get_deploy_errors, get_deployment_history) do not query import edges and do not need updates.

5. **End-to-end pipeline is fully wired.** Parser produces BarrelInfo -> digest aggregates into barrelMap -> resolver consumes it for barrel unwinding and symbol resolution -> produces ResolveResult with directImports -> loader writes DIRECTLY_IMPORTS edges to Neo4j with import_kind + alias -> MCP tools read these exact properties.

6. **Four enriched IMPORTS properties** (resolution_status, resolved_path, barrel_hops, unresolved_symbols) are written to Neo4j but not yet surfaced by MCP tools. These represent future enhancement opportunities, not blockers.
