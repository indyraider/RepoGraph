# Build Plan: Name Resolution at Digest Time
**Created:** 2026-03-06
**Brainstorm:** ../brainstorm/name-resolution-brainstorm-2026-03-06.md
**PRD:** ../../repograph-name-resolution-prd.md
**Status:** Draft

## Overview

Extend the Resolve stage of the digest pipeline to resolve `IMPORTS` edges from syntactic string references to semantically resolved canonical definitions. This adds barrel file unwinding (hybrid mode), tsconfig `extends` chain following, symbol-level `DIRECTLY_IMPORTS` edges, and enriched edge properties — then updates the four affected MCP tools to leverage the new precision.

**Key decisions:**
- Barrel handling: Hybrid (partial unwinding for files that mix local exports with re-exports)
- Barrel depth: Hardcoded at 10
- tsconfig invalidation: Full (re-resolve all files on tsconfig change)

---

## Component Inventory

| # | Component | File(s) | Type | Inputs | Outputs |
|---|---|---|---|---|---|
| 1 | tsconfig Parser (enhanced) | `resolver.ts` | Extend | Repo root path | `TsConfigPaths` with merged alias map |
| 2 | Path Resolver (enhanced) | `resolver.ts` | Extend | Import string, alias map, file set | `PathResolutionResult` |
| 3 | Barrel Classifier | `parser.ts` | Extend | AST export nodes | `isBarrel` flag on ParseResult |
| 4 | Barrel Unwinder | `resolver.ts` (new function) | New | Resolved file path, exports map, parse results | Terminal file path + hop count |
| 5 | Symbol Resolver | `resolver.ts` (new function) | New | Named imports, terminal file, exports data | Matched/unmatched symbols |
| 6 | Resolve Stage Integration | `resolver.ts` | Extend | ParseResult, ScannedFile[] | `EnrichedResolvedImport[]` + `DirectlyImportsEdge[]` |
| 7 | Loader Extension | `loader.ts` | Extend | Enriched imports + direct edges | Neo4j writes |
| 8 | Neo4j Schema | `neo4j.ts` | Extend | — | New indexes |
| 9 | Purge Extension | `loader.ts` | Extend | — | Purges DIRECTLY_IMPORTS alongside IMPORTS |
| 10 | Digest Orchestrator | `digest.ts` | Extend | — | Updated function call + stats |
| 11 | MCP: get_symbol | `mcp-server/index.ts` | Extend | — | Updated Cypher |
| 12 | MCP: get_dependencies | `mcp-server/index.ts` | Extend | — | Updated Cypher |
| 13 | MCP: trace_imports | `mcp-server/index.ts` | Extend | — | Updated Cypher |
| 14 | MCP: trace_error | `mcp-server/runtime-tools.ts` | Extend | — | Updated Cypher |

---

## Integration Contracts

### Contract 1: Parser → Resolver (barrel classification)

```
Source: parseFile() in parser.ts
Target: resolveImports() in resolver.ts
What flows: ParseResult now includes isBarrel flag per file
How:        ParseResult gains a new field: barrelFiles: Set<string>
            Built during parse by checking each file's exports:
            - File is barrel if ALL exports are re-exports (strict)
            - File is hybrid-barrel if SOME exports are re-exports (hybrid)
            Both types are included in the set with a discriminator
Auth/Config: None (in-process data)
Error path: If barrel classification fails for a file, default to non-barrel
```

**New types in parser.ts:**
```typescript
export interface BarrelInfo {
  filePath: string;
  kind: "strict" | "hybrid"; // strict = all re-exports, hybrid = mixed
  reExports: Array<{
    symbols: string[];       // re-exported symbol names
    source: string;          // re-export source path (as written)
    isWildcard: boolean;     // export * from '...'
  }>;
}
```

### Contract 2: tsconfig Parser → Path Resolver (alias map)

```
Source: loadTsConfig() in resolver.ts (enhanced)
Target: resolveAliasPath() in resolver.ts
What flows: TsConfigPaths (unchanged shape, but now merged from extends chain)
How:        loadTsConfig follows `extends` field recursively, merges paths
            Child values take precedence on conflict
            Visited set prevents circular extends
Auth/Config: File system access (already exists)
Error path: Malformed tsconfig in chain → warn, use what's collected so far
```

### Contract 3: Path Resolver → Barrel Unwinder

```
Source: resolveRelativePath() / resolveAliasPath() in resolver.ts
Target: unwindBarrel() in resolver.ts (new function)
What flows: Resolved file path + named import symbols needed
How:        Function call within resolveImports loop
            unwindBarrel(resolvedPath, importedSymbols, barrelMap, parseResults, repoPath)
Auth/Config: None
Error path: Max depth (10) exceeded → return last valid path + flag
            Cycle detected → return last valid path + flag
```

**New function signature:**
```typescript
interface UnwindResult {
  terminalPath: string;      // final resolved file path
  barrelHops: number;        // number of barrels traversed
  flag?: "barrel_depth_exceeded" | "barrel_cycle";
}

function unwindBarrel(
  filePath: string,
  importedSymbols: string[],
  barrelMap: Map<string, BarrelInfo>,
  repoPath: string,
  visited?: Set<string>
): UnwindResult
```

### Contract 4: Barrel Unwinder → Symbol Resolver

```
Source: unwindBarrel() in resolver.ts
Target: resolveSymbols() in resolver.ts (new function)
What flows: Terminal file path + list of named imports to match
How:        Function call after barrel unwinding completes
            resolveSymbols(terminalPath, importedSymbols, exportsMap)
Auth/Config: None
Error path: Symbol not found → add to unresolved_symbols list, continue
```

**New function signature:**
```typescript
interface SymbolResolutionResult {
  matched: Array<{
    symbolName: string;
    kind: "function" | "class" | "type" | "constant";
    importKind: "named" | "default" | "namespace";
    targetFilePath: string;  // file where symbol is defined
  }>;
  unresolved: string[];      // symbol names that couldn't be matched
}

function resolveSymbols(
  terminalPath: string,
  importedSymbols: string[],
  defaultImport: string | null,
  exportsMap: Map<string, ParsedExport[]>,
  symbolsMap: Map<string, ParsedSymbol[]>
): SymbolResolutionResult
```

### Contract 5: Resolver → Loader (enriched imports)

```
Source: resolveImports() in resolver.ts (enhanced return type)
Target: loadImportsToNeo4j() in loader.ts (enhanced)
What flows: EnrichedResolvedImport[] + DirectlyImportsEdge[]
How:        resolveImports returns new type; loader uses new fields
Auth/Config: None
Error path: If enrichment data missing, fall back to current behavior
```

**New/modified types in resolver.ts:**
```typescript
export interface EnrichedResolvedImport extends ResolvedImport {
  resolutionStatus: "resolved" | "external" | "unresolvable" | "dynamic";
  resolvedPath: string | null;    // canonical path after alias expansion + barrel unwinding
  barrelHops: number;
  unresolvedSymbols: string[];
}

export interface DirectlyImportsEdge {
  fromFile: string;           // importing file path
  targetSymbolName: string;   // symbol name in target file
  targetFilePath: string;     // file where symbol is defined
  importKind: "named" | "default" | "namespace";
  alias?: string;             // namespace alias for import * as x
}

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

### Contract 6: Loader → Neo4j (enriched IMPORTS + new DIRECTLY_IMPORTS)

```
Source: loadImportsToNeo4j() in loader.ts (enhanced)
Target: Neo4j graph
What flows:
  (a) IMPORTS edges with new properties: resolution_status, resolved_path, barrel_hops, unresolved_symbols
  (b) DIRECTLY_IMPORTS edges: File → Function|Class|TypeDef|Constant with import_kind property
How:        Batch Cypher MERGE statements (same pattern as existing)
Auth/Config: Neo4j connection (already configured)
Error path: If symbol node doesn't exist in Neo4j (race condition), skip that DIRECTLY_IMPORTS edge
```

**IMPORTS edge Cypher (enhanced):**
```cypher
UNWIND $imports AS imp
MATCH (from:File {path: imp.from_path, repo_url: imp.repo_url})
MATCH (to:File {path: imp.to_path, repo_url: imp.repo_url})
MERGE (from)-[r:IMPORTS]->(to)
SET r.symbols = imp.symbols,
    r.resolution_status = imp.resolution_status,
    r.resolved_path = imp.resolved_path,
    r.barrel_hops = imp.barrel_hops,
    r.unresolved_symbols = imp.unresolved_symbols
```

**DIRECTLY_IMPORTS edge Cypher (new):**
```cypher
UNWIND $directImports AS di
MATCH (from:File {path: di.from_path, repo_url: di.repo_url})
MATCH (sym {name: di.symbol_name, file_path: di.target_file_path, repo_url: di.repo_url})
WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
MERGE (from)-[r:DIRECTLY_IMPORTS]->(sym)
SET r.import_kind = di.import_kind, r.alias = di.alias
```

### Contract 7: Loader → Neo4j (purge extension)

```
Source: purgeImportEdges() in loader.ts
Target: Neo4j graph
What flows: DELETE for both IMPORTS and DIRECTLY_IMPORTS edges
How:        Add second DELETE statement for DIRECTLY_IMPORTS alongside existing IMPORTS purge
Auth/Config: Neo4j connection
Error path: Same as existing — if purge fails, digest fails
```

### Contract 8: Digest → Resolver (updated call site)

```
Source: runDigest() in digest.ts line 251
Target: resolveImports() in resolver.ts
What flows: ParsedImport[], repoPath, allExports, allSymbols, barrelMap
How:        Call signature changes from resolveImports(allImports, scanPath) to
            resolveImports(allImports, scanPath, allExports, allSymbols)
            Returns ResolveResult instead of ResolvedImport[]
Auth/Config: None
Error path: If resolve fails, digest catches and logs as before
```

### Contract 9: Digest → Loader (updated call site)

```
Source: runDigest() in digest.ts lines 302, 318
Target: loadImportsToNeo4j() in loader.ts
What flows: EnrichedResolvedImport[] + DirectlyImportsEdge[]
How:        Call signature changes to accept ResolveResult
Auth/Config: None
Error path: Same as existing
```

---

## End-to-End Flows

### Flow 1: Happy Path — Named Import Through Barrel

```
1. Parse stage processes all files, producing:
   - src/app.ts has ParsedImport: { source: "@/components", symbols: ["Button"], filePath: "src/app.ts" }
   - src/components/index.ts has ParsedExport: { symbolName: "Button", isDefault: false, filePath: "src/components/index.ts" }
     → re-export detected: export { Button } from './Button/Button'
   - src/components/Button/Button.tsx has ParsedExport: { symbolName: "Button", isDefault: false }
     and ParsedSymbol: { kind: "class", name: "Button", filePath: "src/components/Button/Button.tsx" }

2. Parser classifies src/components/index.ts as barrel (kind: "strict"):
   - All exports are re-exports → barrelMap.set("src/components/index.ts", { kind: "strict", reExports: [...] })

3. Resolve stage begins Pass 1 (Path Resolution):
   - loadTsConfig reads tsconfig.json: { paths: { "@/*": ["src/*"] }, baseUrl: "." }
   - Import "@/components" → alias expansion → "src/components"
   - resolveAliasPath → "src/components/index.ts" (directory with index file)
   - Resolution status: "resolved"

4. Resolve stage barrel check:
   - "src/components/index.ts" is in barrelMap → call unwindBarrel
   - unwindBarrel looks at re-exports for symbol "Button":
     → finds `export { Button } from './Button/Button'`
     → resolves './Button/Button' relative to src/components/ → "src/components/Button/Button.tsx"
     → src/components/Button/Button.tsx is NOT a barrel → terminal
   - Returns: { terminalPath: "src/components/Button/Button.tsx", barrelHops: 1 }

5. Resolve stage Pass 2 (Symbol Resolution):
   - resolveSymbols("src/components/Button/Button.tsx", ["Button"], null, exportsMap, symbolsMap)
   - Looks up exportsMap for "src/components/Button/Button.tsx" → finds "Button" export
   - Looks up symbolsMap for "src/components/Button/Button.tsx" → finds Class "Button"
   - Returns: { matched: [{ symbolName: "Button", kind: "class", importKind: "named", targetFilePath: "src/components/Button/Button.tsx" }], unresolved: [] }

6. Resolve output:
   - EnrichedResolvedImport: {
       fromFile: "src/app.ts", toFile: "src/components/index.ts", toPackage: null,
       symbols: ["Button"], defaultImport: null,
       resolutionStatus: "resolved", resolvedPath: "src/components/Button/Button.tsx",
       barrelHops: 1, unresolvedSymbols: []
     }
   - DirectlyImportsEdge: {
       fromFile: "src/app.ts", targetSymbolName: "Button",
       targetFilePath: "src/components/Button/Button.tsx", importKind: "named"
     }

7. Load stage writes to Neo4j:
   - IMPORTS edge: (src/app.ts)-[:IMPORTS {symbols: ["Button"], resolution_status: "resolved",
     resolved_path: "src/components/Button/Button.tsx", barrel_hops: 1}]->(src/components/index.ts)
   - DIRECTLY_IMPORTS edge: (src/app.ts)-[:DIRECTLY_IMPORTS {import_kind: "named"}]->(Class:Button in Button.tsx)

8. MCP tool get_symbol("Button") now:
   - Finds Class:Button in src/components/Button/Button.tsx
   - OPTIONAL MATCH for DIRECTLY_IMPORTS shows src/app.ts as a direct importer
   - No ambiguity — precise result
```

### Flow 2: Unresolvable Import

```
1. Parse: src/api.ts has import { magic } from './nonexistent'
2. Resolve Pass 1: resolveRelativePath("src/api.ts", "./nonexistent", repoPath) → null
   - Tried: nonexistent.ts, nonexistent.tsx, nonexistent.js, nonexistent.jsx → none exist
   - Tried: nonexistent/index.ts, etc. → none exist
3. Result: resolutionStatus = "unresolvable", toFile = null, toPackage = null
4. No IMPORTS edge created (no target file). No DIRECTLY_IMPORTS edge.
5. Stats: unresolvable count incremented by 1
6. digest_jobs.stats includes { unresolvable: 1 }
```

### Flow 3: Hybrid Barrel (Mixed Local + Re-exports)

```
1. Parse: src/utils/index.ts has:
   - export { formatDate } from './date'     (re-export)
   - export function capitalize(s) { ... }   (local definition)
   → Classified as hybrid barrel

2. Import: src/app.ts imports { formatDate, capitalize } from './utils'

3. Resolve: Path resolves to src/utils/index.ts → hybrid barrel
   - For "formatDate": follow re-export chain → terminal at src/utils/date.ts
   - For "capitalize": locally defined in src/utils/index.ts → no unwinding needed

4. Symbol resolution:
   - formatDate → matched to Function in src/utils/date.ts
   - capitalize → matched to Function in src/utils/index.ts

5. Output:
   - IMPORTS edge: app.ts → utils/index.ts (resolution_status: "resolved", barrel_hops: 1)
   - DIRECTLY_IMPORTS: app.ts → Function:formatDate in date.ts (named)
   - DIRECTLY_IMPORTS: app.ts → Function:capitalize in utils/index.ts (named)
```

### Flow 4: tsconfig extends Chain

```
1. tsconfig.json: { "extends": "./tsconfig.base.json", "compilerOptions": { "paths": { "@app/*": ["src/app/*"] } } }
2. tsconfig.base.json: { "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "@lib/*": ["src/lib/*"] } } }
3. loadTsConfig merges:
   - Start with base: { baseUrl: ".", paths: { "@/*": ["src/*"], "@lib/*": ["src/lib/*"] } }
   - Override with child: { baseUrl: ".", paths: { "@/*": ["src/*"], "@lib/*": ["src/lib/*"], "@app/*": ["src/app/*"] } }
   - If base had "@app/*" too, child's mapping wins
```

### Flow 5: Dynamic Import (Skipped)

```
1. Parse: const mod = await import(`./plugins/${name}`)
   - Parser detects template literal in import() → symbols: [], source contains template
2. Resolve: Detected as dynamic → resolutionStatus = "dynamic", skip entirely
3. No edges created. Stats: dynamic count incremented.
```

---

## Issues Found

### Dead Ends
1. **purgeImportEdges only deletes IMPORTS** — After adding `DIRECTLY_IMPORTS`, the purge function must also delete these edges during incremental re-digest. Without this, stale `DIRECTLY_IMPORTS` edges accumulate on re-digest.
   - Fix: Add `MATCH (f:File {repo_url: $repoUrl})-[r:DIRECTLY_IMPORTS]->() DELETE r` to `purgeImportEdges()`.

### Missing Sources
2. **resolveImports needs exports and symbols data** — Currently only receives `ParsedImport[]` and `repoPath`. Symbol resolution requires `ParsedExport[]` and `ParsedSymbol[]` from the parse stage.
   - Fix: Expand `resolveImports` signature to accept exports and symbols. The data already exists in `digest.ts` as `allExports` and `allSymbols`.

3. **Barrel classification data not currently produced** — The parser extracts exports but doesn't classify files as barrels.
   - Fix: Add barrel classification logic to `parseTypeScript` that inspects each file's export statements to determine if it's a barrel, hybrid-barrel, or non-barrel.

### Phantom Dependencies
4. **No index on DIRECTLY_IMPORTS relationship endpoints** — MCP queries against `DIRECTLY_IMPORTS` will perform full scans without indexes on the participating nodes. The current indexes on Function.name, Class.name, etc. help but a composite index may be needed.
   - Fix: Existing node indexes should suffice since Cypher MATCH starts from File nodes (indexed on path). Monitor query performance.

### One-Way Streets
5. **removeFilesFromNeo4j doesn't clean DIRECTLY_IMPORTS** — The function at `loader.ts:420-438` does `DETACH DELETE sym, f` which deletes all relationships of the symbol node, including incoming `DIRECTLY_IMPORTS` edges. This is correct by accident — `DETACH DELETE` removes all relationships. No fix needed, but worth noting.

### Backward Compatibility
6. **MCP tools must handle pre-resolution digests** — Repos digested before this feature ships won't have `DIRECTLY_IMPORTS` edges. MCP queries must use `OPTIONAL MATCH` for the new edges and fall back to `IMPORTS`-only results.
   - Fix: Use `OPTIONAL MATCH` for `DIRECTLY_IMPORTS` in all updated MCP queries.

---

## Wiring Checklist

### Phase 1: Parser Extension (barrel classification)

- [ ] Add `BarrelInfo` type to `parser.ts` exports
- [ ] Add `barrelFiles` field to parse result aggregation in `digest.ts`
- [ ] In `parseTypeScript`, after walking all nodes, classify file as barrel/hybrid/non-barrel:
  - Count re-export statements (export with source) vs local export declarations
  - If all exports are re-exports → strict barrel
  - If some exports are re-exports and some are local → hybrid barrel
  - Store re-export source paths and symbol lists in `BarrelInfo`
- [ ] Aggregate barrel info in digest.ts parse loop: build `Map<string, BarrelInfo>` alongside `allSymbols`, `allImports`, `allExports`

### Phase 2: Resolver Enhancement (tsconfig + path + barrel + symbol)

- [ ] Enhance `loadTsConfig` to follow `extends` chains:
  - Read `extends` field from parsed config
  - Recursively load parent configs
  - Merge paths with child taking precedence
  - Maintain visited set for cycle detection
  - Cap at 10 levels of extends
- [ ] Add `EnrichedResolvedImport`, `DirectlyImportsEdge`, and `ResolveResult` types
- [ ] Add `unwindBarrel()` function:
  - Accept resolved file path, imported symbols, barrel map, repo path
  - Check if file is in barrel map
  - For strict barrels: follow all re-export chains for requested symbols
  - For hybrid barrels: follow re-export chains only for symbols that are re-exported; short-circuit for locally defined symbols
  - Use `resolveRelativePath`/`resolveAliasPath` to resolve re-export source paths
  - Track visited set for cycle detection
  - Track hop count, cap at 10 (hardcoded `MAX_BARREL_DEPTH = 10`)
  - Memoize results: `Map<string, UnwindResult>` keyed by `filePath:symbolName`
- [ ] Add `resolveSymbols()` function:
  - Accept terminal file path, imported symbol names, default import name, exports map, symbols map
  - For each named import: look up in exports map for the terminal file → find matching symbol in symbols map
  - For default import: find export with `isDefault: true` in exports map → find matching symbol
  - Return matched symbols with their kind + unresolved list
- [ ] Refactor `resolveImports()`:
  - Accept additional params: `allExports: ParsedExport[]`, `allSymbols: ParsedSymbol[]`
  - Build internal lookup maps: `exportsMap: Map<filePath, ParsedExport[]>`, `symbolsMap: Map<filePath, ParsedSymbol[]>`, `barrelMap: Map<filePath, BarrelInfo>`
  - For each import, after path resolution:
    - Set `resolutionStatus` based on outcome
    - If resolved and target is a barrel → call `unwindBarrel`
    - After barrel unwinding → call `resolveSymbols`
    - Build `DirectlyImportsEdge` entries for matched symbols
  - Return `ResolveResult` instead of `ResolvedImport[]`
  - Accumulate stats (resolved/external/unresolvable/dynamic/barrel_cycles/etc.)

### Phase 3: Loader + Neo4j Schema + Digest Orchestrator

- [ ] Add indexes to `initNeo4jIndexes()` in `neo4j.ts`:
  - `CREATE INDEX constant_name IF NOT EXISTS FOR (c:Constant) ON (c.name)` (missing, needed for symbol matching)
- [ ] Enhance `loadImportsToNeo4j()` in `loader.ts`:
  - Accept `ResolveResult` instead of `ResolvedImport[]`
  - Internal imports Cypher: add SET for `resolution_status`, `resolved_path`, `barrel_hops`, `unresolved_symbols`
  - Add new batch loop for `directImports`: write `DIRECTLY_IMPORTS` edges using the Cypher in Contract 6
  - Return updated edge count (IMPORTS + DIRECTLY_IMPORTS)
- [ ] Enhance `purgeImportEdges()` in `loader.ts`:
  - Add: `MATCH (f:File {repo_url: $repoUrl})-[r:DIRECTLY_IMPORTS]->() DELETE r`
- [ ] Update `runDigest()` in `digest.ts`:
  - Pass `allExports` and `allSymbols` to `resolveImports()`
  - Destructure `ResolveResult` from resolver
  - Pass `resolveResult` to `loadImportsToNeo4j()` (both incremental and full-reload paths)
  - Add resolution stats to `digest_jobs.stats`:
    - `resolvedImports`, `unresolvedImports`, `dynamicImports`, `directImportEdges`, `barrelCycles`, `barrelDepthExceeded`

### Phase 4: MCP Tool Updates

- [ ] Update `get_symbol` in `mcp-server/index.ts` (lines 253-278):
  - Add `OPTIONAL MATCH (importer:File)-[di:DIRECTLY_IMPORTS]->(sym)` alongside existing IMPORTS query
  - Collect direct importers separately: `collect(DISTINCT importer.path) AS directly_imported_by`
  - Prefer `directly_imported_by` in output when available, fall back to `imported_by`
- [ ] Update `get_dependencies` in `mcp-server/index.ts` (lines 367-372):
  - For inbound direction, add second query:
    ```cypher
    MATCH (source:File)-[r:DIRECTLY_IMPORTS]->(sym)<-[:CONTAINS]-(f:File {path: $path})
    RETURN source.path AS source_path, sym.name AS symbol_name, r.import_kind AS import_kind
    ```
  - Merge results with existing IMPORTS-based inbound query
  - Display symbol-level granularity: `← src/app.ts {Button} (via DIRECTLY_IMPORTS)`
- [ ] Update `trace_imports` in `mcp-server/index.ts` (lines 418-426):
  - Change relationship pattern to include both types: `[:IMPORTS|DIRECTLY_IMPORTS*1..${depth}]`
  - In chain formatting, handle symbol nodes (not just File/Package):
    ```
    CASE WHEN n:File THEN n.path
         WHEN n:Package THEN 'pkg:' + n.name
         WHEN n:Function OR n:Class OR n:TypeDef OR n:Constant THEN n.name + ' in ' + n.file_path
         ELSE n.name END
    ```
- [ ] Update `trace_error` in `mcp-server/runtime-tools.ts` (lines 438-455):
  - After existing IMPORTS query, add:
    ```cypher
    MATCH (f:File {path: $filePath})-[r:DIRECTLY_IMPORTS]->(sym)
    MATCH (symFile:File)-[:CONTAINS]->(sym)
    RETURN sym.name AS symbol_name, symFile.path AS definition_file,
           labels(sym)[0] AS symbol_type, r.import_kind AS import_kind
    ```
  - Display under new section: `### Direct Symbol Imports`
  - Show: `- Button (Class) → defined in src/components/Button/Button.tsx`

---

## Build Order

| Phase | Components | Depends On | Estimated Scope |
|-------|-----------|------------|-----------------|
| **Phase 1** | Barrel Classifier (parser.ts extension) | Nothing — standalone | ~1 file, ~80 lines |
| **Phase 2** | tsconfig enhancement, Path Resolver, Barrel Unwinder, Symbol Resolver, Resolve Integration (all in resolver.ts) | Phase 1 (barrel map) | ~1 file, ~250 lines new + refactored |
| **Phase 3** | Loader extension, Neo4j schema, Purge extension, Digest orchestrator | Phase 2 (new types + return shape) | ~3 files, ~80 lines changed |
| **Phase 4** | MCP tool updates (4 tools across 2 files) | Phase 3 (data must be in Neo4j) | ~2 files, ~60 lines changed |

**Checkpoint gates:** Run phase checkpoint after each phase before proceeding to next.

**Total estimated new/modified code:** ~470 lines across 6 files.
