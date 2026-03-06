# Brainstorm: Name Resolution at Digest Time
**Created:** 2026-03-06
**Status:** Draft
**PRD:** repograph-name-resolution-prd.md

## Vision

Upgrade the Resolve stage of the digest pipeline so that `IMPORTS` edges carry semantically resolved references instead of syntactic strings. Today the graph knows that `api.ts` imports "something called `processPayment`" — after this feature it knows it imports *the specific `processPayment` function at `src/payments.ts:128`*. This eliminates three failure modes — ambiguous symbol origins, barrel file opacity, and path alias blindness — and makes `get_symbol`, `get_dependencies`, and `trace_imports` materially more accurate on non-trivial TypeScript codebases.

## Existing Context

### Monorepo Structure
- `packages/backend` — Express API + 6-stage digest pipeline
- `packages/frontend` — React + Vite dashboard
- `packages/mcp-server` — MCP server exposing graph query tools to Claude Code

### Current Pipeline
```
Clone → Scan → Parse → Resolve → Deps → Load
```

### What Already Exists in the Resolve Stage (`resolver.ts`)
The current resolver already handles:
- **tsconfig alias loading** — reads `compilerOptions.paths` and `baseUrl` from `tsconfig.json`
- **Alias expansion** — matches import paths against alias prefixes, substitutes mapped paths
- **Relative path resolution** — resolves `./foo` relative to importing file's directory
- **Extension appending** — tries `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`
- **Index file lookup** — tries `index.ts`, `index.tsx`, etc. for directory imports
- **External package detection** — bare specifiers without alias matches → `toPackage`
- **Node builtin skipping** — `fs`, `path`, `crypto`, etc.

### What Does NOT Exist Yet (Gaps This Feature Fills)
1. **No `extends` chain following** — only reads top-level `tsconfig.json`, ignores `extends`
2. **No barrel detection or unwinding** — resolved paths terminate at barrel/index files
3. **No symbol-level resolution** — only creates File → File edges, never File → Symbol
4. **No `DIRECTLY_IMPORTS` edge type** — no way to express "this file imports this specific function"
5. **No resolution status tracking** — no `resolved`/`external`/`unresolvable`/`dynamic` annotation
6. **No enriched edge properties** — no `resolved_path`, `barrel_hops`, `unresolved_symbols`

### Current Graph Schema (Relevant Subset)
**Nodes:** Repository, File, Function, Class, TypeDef, Constant, Package, PackageExport
**Edges:**
- `CONTAINS_FILE` — Repository → File
- `CONTAINS` — File → Function/Class/TypeDef/Constant
- `EXPORTS` — File → Symbol (has `is_default: boolean`)
- `IMPORTS` — File → File | Package (has `symbols: string[]`)
- `DEPENDS_ON` — Repository → Package
- `PROVIDES` — Package → PackageExport

### Current Loader (`loader.ts`) — How IMPORTS Edges Are Written
```typescript
// Internal: File → File
MATCH (from:File {path: imp.from_path, repo_url: imp.repo_url})
MATCH (to:File {path: imp.to_path, repo_url: imp.repo_url})
MERGE (from)-[r:IMPORTS]->(to)
SET r.symbols = imp.symbols

// External: File → Package
MATCH (from:File {path: imp.from_path, repo_url: imp.repo_url})
MERGE (pkg:Package {name: imp.package_name})
MERGE (from)-[r:IMPORTS]->(pkg)
SET r.symbols = imp.symbols
```

### Current Parse Stage (`parser.ts`) — What It Already Provides
- `ParsedSymbol[]` — functions, classes, types, constants with name, signature, lines
- `ParsedImport[]` — source path, named symbols, default import name
- `ParsedExport[]` — symbol name, `isDefault` flag
- Creates `EXPORTS` edges with `is_default` property during Load

### MCP Tools That Benefit
| Tool | Current Limitation | After Name Resolution |
|---|---|---|
| `get_symbol` | Returns all same-named symbols; ambiguous | Filters by reachability via `DIRECTLY_IMPORTS` |
| `get_dependencies` (in) | Returns barrel importers, not true consumers | Queries `DIRECTLY_IMPORTS` for precise reverse lookup |
| `trace_imports` | Stops at barrels, wrong turns on aliases | Follows verified canonical paths end-to-end |
| `trace_error` | Import context incomplete behind barrels | Both `IMPORTS` and `DIRECTLY_IMPORTS` for full picture |

## Components Identified

### 1. tsconfig Parser (Enhanced)
- **Responsibility**: Load tsconfig.json, follow `extends` chains, return merged alias map
- **Upstream (receives from)**: Repo root path from Clone stage
- **Downstream (sends to)**: Alias map consumed by Path Resolver
- **External dependencies**: File system access to repo; JSON parsing with comment stripping
- **Hands test**: PASS — existing `loadTsConfig()` in resolver.ts already works for the simple case; needs extension for `extends` chains and cycle detection

### 2. Path Resolver (Enhanced)
- **Responsibility**: Transform import path strings into canonical absolute file paths
- **Upstream (receives from)**: ParsedImport source strings, alias map from tsconfig parser, known file paths from Scan stage
- **Downstream (sends to)**: Resolved file paths to Barrel Unwinder and Symbol Resolver
- **External dependencies**: File set from Scanner (already available as `ScannedFile[]`)
- **Hands test**: PASS — existing `resolveRelativePath()` and `resolveAliasPath()` handle the core logic; needs to return resolution status enum instead of just `string | null`

### 3. Barrel Detector & Unwinder (NEW)
- **Responsibility**: Classify files as barrels; follow re-export chains to terminal definitions
- **Upstream (receives from)**: Resolved file path from Path Resolver; ParsedExport data from Parse stage
- **Downstream (sends to)**: Terminal file path + hop count to Symbol Resolver; barrel flag stored on File node
- **External dependencies**: Parse stage AST data (already available as `ParseResult`)
- **Hands test**: PASS — all inputs exist. Parser already extracts exports. Needs: (a) barrel classification logic added to Parse stage output, (b) recursive chain follower with cycle detection and depth limit, (c) memoization cache for already-unwound barrels

### 4. Symbol Resolver (NEW)
- **Responsibility**: Map imported names to specific graph nodes (Function, Class, TypeDef, Constant)
- **Upstream (receives from)**: Named import list from ParsedImport; resolved terminal file path from Barrel Unwinder; export data from Parse stage
- **Downstream (sends to)**: `DIRECTLY_IMPORTS` edge data to Loader; unresolved symbol annotations to IMPORTS edge enrichment
- **External dependencies**: ParsedExport and ParsedSymbol data from Parse stage (already available)
- **Hands test**: PASS — Parser already creates `ParsedExport[]` with `symbolName` and `isDefault`. Symbol nodes are already created during Load. The resolver matches import names against export names for the target file, then the Loader creates the `DIRECTLY_IMPORTS` edges pointing at the symbol nodes in Neo4j.

### 5. Resolve Stage Integration
- **Responsibility**: Wire the four modules above into the existing Resolve stage loop as two sub-passes
- **Upstream (receives from)**: `ParseResult` (symbols, imports, exports) from Parse stage; `ScannedFile[]` from Scan stage
- **Downstream (sends to)**: Enriched `ResolvedImport[]` with resolution status + `DirectlyImportsEdge[]` to Loader
- **External dependencies**: None beyond existing pipeline interfaces
- **Hands test**: PASS — the existing `resolveImports()` function is the integration point. It currently returns `ResolvedImport[]`. Needs to return an enriched version that includes resolution status, barrel hops, resolved symbols, and the new directly-imports edge data.

### 6. Loader Extension
- **Responsibility**: Write enriched `IMPORTS` edges and new `DIRECTLY_IMPORTS` edges to Neo4j
- **Upstream (receives from)**: Enriched ResolvedImport data + DirectlyImportsEdge data from Resolve stage
- **Downstream (sends to)**: Neo4j graph (consumed by MCP tools)
- **External dependencies**: Neo4j connection (already configured)
- **Hands test**: PASS — existing `loadImportsToNeo4j()` handles batched Cypher writes. Needs: (a) additional SET clauses for new IMPORTS properties, (b) new MERGE statements for DIRECTLY_IMPORTS edges, (c) new index on DIRECTLY_IMPORTS relationship type

### 7. Neo4j Schema Updates
- **Responsibility**: Add indexes/constraints for new edge type and properties
- **Upstream (receives from)**: Schema migration runs at app startup
- **Downstream (sends to)**: Query performance for MCP tools
- **External dependencies**: Neo4j (`neo4j.ts` — `ensureIndexes()` function)
- **Hands test**: PASS — `ensureIndexes()` already runs CREATE INDEX statements at startup. Add new index statements.

### 8. MCP Tool Updates
- **Responsibility**: Update Cypher queries in `get_symbol`, `get_dependencies`, `trace_imports`, `trace_error` to leverage `DIRECTLY_IMPORTS` edges
- **Upstream (receives from)**: Neo4j graph with new edge types and properties
- **Downstream (sends to)**: Claude Code (via MCP protocol)
- **External dependencies**: Neo4j queries in `packages/mcp-server/src/index.ts` and `runtime-tools.ts`
- **Hands test**: PASS — tools already query Neo4j. Queries need updating but interfaces don't change.

### 9. Digest Stats Extension
- **Responsibility**: Aggregate resolution stats (resolved/external/unresolvable/dynamic counts, unresolved symbols, barrel cycles) into `digest_jobs.stats`
- **Upstream (receives from)**: Resolution results from Resolve stage
- **Downstream (sends to)**: Supabase `digest_jobs` table; surfaced in frontend UI
- **External dependencies**: Supabase (already configured); digest orchestrator already writes stats
- **Hands test**: PASS — `digest.ts` already collects and writes stats to Supabase. Just needs additional fields.

## Rough Dependency Map

```
                  tsconfig.json
                       │
              ┌────────▼────────┐
              │  tsconfig Parser │
              │  (enhanced)      │
              └────────┬────────┘
                       │ alias map
                       ▼
ParsedImport[] ──► Path Resolver ◄── ScannedFile[] (known file paths)
                  (enhanced)
                       │ resolved file path + resolution status
                       ▼
                  Barrel Unwinder ◄── ParsedExport[] (re-export data)
                  (NEW)
                       │ terminal file path + barrel hops
                       ▼
                  Symbol Resolver ◄── ParsedExport[] + ParsedSymbol[]
                  (NEW)
                       │ matched symbols + unresolved symbols
                       ▼
              ┌────────────────────┐
              │ Resolve Stage      │ ← Integration point
              │ Integration        │   (enriched ResolvedImport[] +
              └────────┬───────────┘    DirectlyImportsEdge[])
                       │
                       ▼
              ┌────────────────────┐
              │ Loader Extension   │──► Neo4j (IMPORTS enriched +
              └────────┬───────────┘    DIRECTLY_IMPORTS new edges)
                       │
                       ▼
              ┌────────────────────┐
              │ MCP Tool Updates   │──► Claude Code
              └────────────────────┘
```

## Open Questions

1. **Barrel definition strictness** — The PRD recommends strict (all exports are re-exports). Should we validate this against the target codebase first, or ship strict and add hybrid handling only if needed?

2. **Extension resolution order** — `.ts` before `.js` is the current behavior. For mixed JS/TS repos where both `utils.js` and `utils.ts` exist, is TypeScript-first acceptable as a hard assumption?

3. **Barrel depth limit** — Default 10 hops. Should this be configurable per-repo in digest config, or hardcoded for v1?

4. **Incremental re-digest on tsconfig change** — Full invalidation (re-resolve all files) is safe but slow. Is this acceptable for v1?

5. **Unresolved symbol tolerance** — What percentage is acceptable before surfacing a warning in the UI?

## Risks and Concerns

1. **Performance on large repos** — Barrel unwinding with deep chains on repos with 5000+ files could add significant digest time. Memoization is critical. The 20% overhead target needs validation.

2. **Parse stage barrel classification** — Adding barrel detection to the parser means the parser needs to inspect export statements more carefully. This is a change to an existing stage, not just the Resolve stage.

3. **Incremental mode complexity** — The current incremental strategy purges ALL import edges and reloads them. Name resolution doesn't change this, but the expanded re-resolution set (files whose upstream imports changed) adds complexity to the diff logic.

4. **Existing resolver refactoring** — The current `resolveImports()` function returns `ResolvedImport[]` with a specific shape. Enriching this means changing the return type, which affects the Loader. This is a coordinated change across two files.

5. **MCP tool backward compatibility** — If a digest was run before name resolution was deployed, `DIRECTLY_IMPORTS` edges won't exist. MCP queries must gracefully handle their absence (use OPTIONAL MATCH or fall back to IMPORTS-only).
