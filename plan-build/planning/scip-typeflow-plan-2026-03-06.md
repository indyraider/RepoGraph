# Build Plan: SCIP Type Flow via scip-typescript

**Created:** 2026-03-06
**Brainstorm:** ../brainstorm/scip-typeflow-brainstorm-2026-03-06.md
**PRD:** ../../repograph-scip-typeflow-prd.md
**Status:** Draft

## Overview

Add a SCIP stage to the digest pipeline between Parse and Resolve that runs `scip-typescript` against cloned TypeScript repos, ingests the emitted index, and enriches graph nodes (Function, Class) with resolved type signatures and graph edges (CALLS, DIRECTLY_IMPORTS) with argument types and mismatch flags. Also creates CALLS edges (which don't exist today) from SCIP occurrence data. Deferred to v2: async SCIP for large repos, OVERRIDES/IMPLEMENTS_METHOD edges.

**Key decisions:**
- CALLS edges created by SCIP from occurrence data (TS only for v1)
- Async worker deferred to v2 — synchronous with 5-min hard timeout
- SCIP stage runs between Parse and Resolve (per PRD)

---

## Component Inventory

| Component | Inputs | Outputs | Dependencies |
|---|---|---|---|
| **SCIP Subprocess Runner** | repoPath, jobId, commitSha | `.scip` file path or error | `scip-typescript` CLI on PATH |
| **SCIP Index Parser** | `.scip` file path | symbols[], occurrences[], diagnostics[] | `@sourcegraph/scip` npm package |
| **Symbol Table Builder** | SCIP symbols, ParsedSymbol[] | `Map<scipSymbolId, ParsedSymbol>` | In-memory join (no Neo4j) |
| **Node Enricher** | symbol table, SCIP symbol info | Mutated ParsedSymbol[] with type fields | — |
| **CALLS Edge Extractor** | SCIP occurrences, symbol table, ParsedSymbol[] | CallsEdge[] array | — |
| **Edge Enricher** | SCIP occurrences, CALLS edges, DirectlyImportsEdge[] | Enriched edges with arg_types, resolved_type | — |
| **Diagnostic Collector** | SCIP diagnostics, symbol table | DiagnosticInfo[] for stats + node attachment | — |
| **Loader Extensions** | Enriched symbols, CALLS edges, enriched DI edges, diagnostics | Neo4j writes | Existing loader.ts |
| **`get_type_info` MCP Tool** | name, file, repo, include_callers | Type info response | Neo4j queries |
| **MCP Tool Updates** | Existing queries + new properties | Enriched responses | — |
| **SCIP Cache** | commitSha, scan diff | Skip/run decision | File system |

---

## Integration Contracts

### Contract 1: Digest Orchestrator → SCIP Stage
```
Source: digest.ts runDigest() (after Parse, before Resolve)
Target: scip.ts runScipStage()

What flows:
  IN:  { repoPath: string, jobId: string, commitSha: string,
         allFiles: ScannedFile[], allSymbols: ParsedSymbol[],
         allExports: ParsedExport[] }
  OUT: { enrichedSymbols: ParsedSymbol[],  // mutated with type fields
         callsEdges: CallsEdge[],
         diagnostics: DiagnosticInfo[],
         stats: ScipStats,
         skipped: boolean }

How: Direct function call in digest.ts between Parse and Resolve stages.
Error path: If SCIP fails at any point, return { skipped: true } with
            original symbols unchanged. Log failure to console + stats.
```

### Contract 2: SCIP Runner → Child Process
```
Source: scip-runner.ts runScipTypescript()
Target: scip-typescript CLI (child_process.spawn)

What flows:
  IN:  repoPath, outputPath (temp .scip file)
  OUT: { success: boolean, indexPath: string, durationMs: number,
         error?: string }

How: child_process.spawn('scip-typescript', ['index', '--cwd', repoPath,
     '--output', outputPath, '--infer-tsconfig'])
Auth: None (local CLI tool)
Error path: Non-zero exit → capture stderr, return { success: false, error }.
            Timeout (5 min) → kill process, return { success: false, error: 'timeout' }.
            Binary not found → return { success: false, error: 'not_installed' }.
```

### Contract 3: SCIP Parser → Index Data
```
Source: scip-parser.ts parseScipIndex()
Target: @sourcegraph/scip protobuf parser

What flows:
  IN:  indexPath: string (path to .scip file)
  OUT: { symbols: ScipSymbol[], occurrences: ScipOccurrence[],
         diagnostics: ScipDiagnostic[] }

ScipSymbol: { symbol: string, documentation: string[],
              signatureDocumentation: { language: string, text: string },
              relationships: ScipRelationship[] }

ScipOccurrence: { range: [startLine, startChar, endLine, endChar],
                  symbol: string, symbolRoles: number,
                  overrideDocumentation: string[] }

ScipDiagnostic: { severity: number, code: string, message: string,
                  source: string, range: [startLine, startChar, endLine, endChar] }

How: fs.readFileSync(indexPath) → scip.Index.decode(buffer) → iterate documents
Error path: Malformed protobuf → throw, caught by SCIP stage → skipped.
```

### Contract 4: Symbol Table → In-Memory Join
```
Source: symbol-table.ts buildSymbolTable()
Target: ParsedSymbol[] (from Parse stage)

What flows:
  IN:  scipSymbols: ScipSymbol[], parsedSymbols: ParsedSymbol[]
  OUT: Map<string, { parsed: ParsedSymbol, scip: ScipSymbol }>

How: For each SCIP symbol, extract file path from the SCIP symbol identifier
     and symbol name. Match against ParsedSymbol[] by filePath + name.
     SCIP symbol IDs follow a structured format:
       `npm package_name version_string path/to/file.ts/SymbolName.`
     Parse the file path and name from this ID.

Error path: Unmatched symbols logged as stats.unmatchedScipSymbols count.
```

### Contract 5: Node Enricher → ParsedSymbol Mutation
```
Source: node-enricher.ts enrichSymbols()
Target: ParsedSymbol[] (mutated in place)

What flows:
  IN:  symbolTable: Map, scipSymbols with type info
  OUT: ParsedSymbol objects gain new optional fields:
       { resolved_signature?: string, param_types?: string[],
         return_type?: string, type_errors?: DiagnosticInfo[],
         is_generic?: boolean, type_params?: string[] }

How: For each entry in symbol table, extract type signature from
     ScipSymbol.signatureDocumentation.text. Parse param types and
     return type from the signature string.
Error path: Unparseable signature → leave fields undefined.
```

### Contract 6: CALLS Edge Extractor → CallsEdge[]
```
Source: calls-extractor.ts extractCallsEdges()
Target: New CallsEdge[] array passed to loader

What flows:
  IN:  scipOccurrences: ScipOccurrence[] (filtered to references at call sites),
       symbolTable: Map,
       parsedSymbols: ParsedSymbol[] (for containing-function lookup)
  OUT: CallsEdge[]

CallsEdge: { callerFilePath: string, callerName: string,
             calleeFilePath: string, calleeName: string,
             callSiteLine: number, argTypes?: string[] }

How: For each SCIP occurrence with role=reference:
  1. Find which ParsedSymbol (function) the occurrence line falls within
     (caller: startLine <= occurrenceLine <= endLine)
  2. Resolve the occurrence's symbol ID to the target function via symbol table
  3. Create a CallsEdge from caller → callee with call site position
  4. If the occurrence has type info, attach arg_types

Error path: Occurrence outside any function range → skip (module-level call).
            Target symbol not in symbol table → skip (external call).
```

### Contract 7: Loader → Neo4j (CALLS edges)
```
Source: loader.ts loadCallsToNeo4j() (NEW function)
Target: Neo4j CALLS relationship

Cypher:
  UNWIND $calls AS c
  MATCH (caller:Function {name: c.caller_name, file_path: c.caller_file, repo_url: $repoUrl})
  MATCH (callee:Function {name: c.callee_name, file_path: c.callee_file, repo_url: $repoUrl})
  MERGE (caller)-[r:CALLS]->(callee)
  SET r.call_site_line = c.call_site_line,
      r.arg_types = c.arg_types
  RETURN count(r) AS cnt

Error path: Unmatched caller/callee → MATCH fails silently, no edge created.
```

### Contract 8: Loader → Neo4j (Type Properties on Nodes)
```
Source: loader.ts loadSymbolsToNeo4j() (MODIFIED)
Target: Neo4j Function/Class nodes

What changes: ParsedSymbol objects now carry optional type fields.
The existing MERGE + SET in loadSymbolsToNeo4j gains new SET clauses:

  SET fn.resolved_signature = s.resolved_signature,
      fn.param_types = s.param_types,
      fn.return_type = s.return_type,
      fn.type_errors = s.type_errors,
      fn.is_generic = s.is_generic

Same pattern for Class nodes with type_params.

How: No new function needed — extend existing batch insert.
     Null/undefined values → Neo4j stores null (no-op on read).
```

### Contract 9: Loader → Neo4j (Type Properties on DIRECTLY_IMPORTS edges)
```
Source: loader.ts loadImportsToNeo4j() (MODIFIED)
Target: Neo4j DIRECTLY_IMPORTS relationship

What changes: DirectlyImportsEdge gains optional resolved_type field.
The existing MERGE + SET gains:

  SET r.resolved_type = di.resolved_type

How: Extend existing batch insert. Null when SCIP was skipped.
```

### Contract 10: Loader → Neo4j (Type Mismatch on CALLS edges)
```
Source: Edge enricher populates has_type_mismatch and type_mismatch_detail
        on CallsEdge objects before they reach the loader.
Target: Neo4j CALLS relationship properties

Properties:
  has_type_mismatch: boolean (true if any arg type incompatible with param type)
  type_mismatch_detail: string (human-readable description)

How: During edge enrichment, compare each CallsEdge.argTypes[i] against
     the callee's param_types[i]. Use SCIP diagnostics at the call site
     as the authoritative mismatch signal (not string comparison).
```

### Contract 11: MCP get_type_info → Neo4j
```
Source: mcp-server/src/index.ts (NEW tool handler)
Target: Neo4j query

Cypher:
  MATCH (f:File)-[:CONTAINS]->(sym:Function {name: $name})
  WHERE f.path = $file OR $file IS NULL
  OPTIONAL MATCH (caller:Function)-[c:CALLS]->(sym)
  OPTIONAL MATCH (cf:File)-[:CONTAINS]->(caller)
  RETURN sym.name, sym.resolved_signature, sym.param_types,
         sym.return_type, sym.type_errors, sym.is_generic,
         f.path,
         CASE WHEN $includeCallers THEN
           collect(DISTINCT {caller: caller.name, file: cf.path,
                             arg_types: c.arg_types,
                             has_mismatch: c.has_type_mismatch})
         ELSE [] END AS callers

Response format:
  ## Type Info: functionName
  File: path/to/file.ts:42
  Resolved Signature: (order: Order) => Promise<PaymentResult>
  Parameters:
    - order: Order
  Return Type: Promise<PaymentResult>
  Generic: no

  Type Errors:
    - TS2345: Argument of type 'null' is not assignable... (line 48)

  Callers with type mismatches:
    - handleCheckout in checkout.ts passes [Order | null] (MISMATCH)
```

### Contract 12: MCP get_symbol → Enriched Response
```
Source: mcp-server/src/index.ts get_symbol handler (MODIFIED)
Target: Response text

What changes: Include type fields when present.
  After existing output, append:
    if (sym.resolved_signature) text += `Resolved Type: ${sym.resolved_signature}\n`;
    if (sym.param_types) text += `Param Types: ${sym.param_types.join(', ')}\n`;
    if (sym.return_type) text += `Return Type: ${sym.return_type}\n`;
    if (sym.type_errors?.length) {
      text += `\nType Errors:\n`;
      sym.type_errors.forEach(e => text += `  - ${e.code}: ${e.message}\n`);
    }

  Cypher changes: Add to RETURN clause:
    sym.resolved_signature, sym.param_types, sym.return_type, sym.type_errors

  Also include CALLS edge type data in callers section:
    For each caller, show arg_types and has_type_mismatch if available.
```

### Contract 13: MCP trace_error → Type Mismatch Context
```
Source: runtime-tools.ts trace_error handler (MODIFIED)
Target: Response text

What changes: After finding callers via CALLS edges, include type mismatch info.

  Modified callers query:
    MATCH (fn:Function {name: $fnName})<-[c:CALLS]-(caller:Function)<-[:CONTAINS]-(f:File)
    RETURN caller.name, f.path, caller.start_line,
           c.arg_types, c.has_type_mismatch, c.type_mismatch_detail

  Response addition:
    ### Callers (3)
    - handleCheckout in checkout.ts:18
      Args: [Order | null]  ← TYPE MISMATCH: param expects Order, got Order | null
    - processOrder in orders.ts:45
      Args: [Order]

  Also include containing function's type info:
    ### Containing Function
    - **Name:** processPayment
    - **Resolved Signature:** (order: Order) => Promise<PaymentResult>
    - **Param Types:** [Order]
    - **Return Type:** Promise<PaymentResult>
```

---

## End-to-End Flows

### Flow 1: Happy Path — TypeScript Repo Digest with SCIP

```
1.  User triggers digest (manual or webhook)
2.  digest.ts creates job, status='running', stage='cloning'
3.  Clone stage: clone repo, get commitSha
4.  Scan stage: walk filesystem → ScannedFile[]
5.  Parse stage: tree-sitter → ParsedSymbol[], ParsedImport[], ParsedExport[]
6.  ── NEW: SCIP stage ──
7.  digest.ts calls runScipStage({ repoPath, jobId, commitSha, allFiles, allSymbols, allExports })
8.  updateJobStage(jobId, "scip")
9.  SCIP Cache: check if commitSha matches cached index
10. If cache miss: runScipTypescript(repoPath, outputPath)
11. scip-typescript spawns, runs TypeScript compiler, emits .scip file
12. If exit code != 0: log error, return { skipped: true }, continue to Resolve
13. parseScipIndex(outputPath) → { symbols, occurrences, diagnostics }
14. buildSymbolTable(scipSymbols, allSymbols) → symbolTable Map
15. enrichSymbols(symbolTable) → mutates ParsedSymbol[] with type fields
16. extractCallsEdges(occurrences, symbolTable, allSymbols) → CallsEdge[]
17. enrichEdges(occurrences, callsEdges, directImports) → adds arg_types, resolved_type
18. collectDiagnostics(diagnostics, symbolTable) → DiagnosticInfo[]
19. Clean up temp .scip file
20. Return { enrichedSymbols, callsEdges, diagnostics, stats, skipped: false }
21. ── END SCIP stage ──
22. Resolve stage: resolveImports() (can now use type data for disambiguation)
23. Deps stage: indexDependencies()
24. Load stage:
    a. loadToNeo4j() — Repository + File nodes (unchanged)
    b. loadSymbolsToNeo4j() — now writes type properties on Function/Class nodes
    c. loadImportsToNeo4j() — now writes resolved_type on DIRECTLY_IMPORTS
    d. loadCallsToNeo4j() — NEW: writes CALLS edges with arg_types + mismatch flags
    e. loadDependenciesToNeo4j() (unchanged)
25. Write SCIP stats to digest_jobs.stats (merge with existing stats)
26. Mark job complete
```

### Flow 2: SCIP Skipped — Non-TypeScript Repo or scip-typescript Not Installed

```
1-5.  Same as Flow 1
6.    SCIP stage: check if any .ts/.tsx files exist in allFiles
7.    No TS files OR scip-typescript not on PATH → log warning
8.    Return { skipped: true, enrichedSymbols: allSymbols (unchanged),
              callsEdges: [], diagnostics: [], stats: { skipped: true, reason: '...' } }
9.    Pipeline continues: Resolve, Deps, Load — all unchanged from current behavior
10.   No type properties written, no CALLS edges created
11.   MCP tools return structural data only (type_data_available: false)
```

### Flow 3: SCIP Subprocess Timeout

```
1-10. Same as Flow 1 through subprocess launch
11.   scip-typescript runs for >5 minutes
12.   Hard timeout fires: process.kill(), log timeout error
13.   Return { skipped: true, reason: 'timeout' }
14.   Pipeline continues without type data
15.   stats include { scip_status: 'timeout', scip_duration_ms: 300000 }
```

### Flow 4: trace_error with Type Mismatch Data

```
1.  Claude calls trace_error({ error_id: "..." })
2.  MCP tool fetches log entry from Supabase → stack trace
3.  Parse stack trace → top frame: checkout.ts:42
4.  Neo4j: Find containing function → processPayment (lines 30-55)
5.  Neo4j: Find callers via CALLS edges:
      MATCH (fn:Function {name: 'processPayment'})<-[c:CALLS]-(caller)<-[:CONTAINS]-(f:File)
      RETURN caller.name, f.path, c.arg_types, c.has_type_mismatch, c.type_mismatch_detail
6.  Results: handleCheckout passes [Order | null], has_type_mismatch: true
7.  Neo4j: Get processPayment's param_types → [Order]
8.  Assemble response with type mismatch context:
      "handleCheckout passes Order | null to processPayment which expects Order"
9.  Return to Claude with full debugging context
```

### Flow 5: Incremental Digest with SCIP Cache Hit

```
1-4. Same as Flow 1 through Scan
5.   SCIP Cache: commitSha matches cached .scip index
6.   Skip subprocess, reuse cached index
7.   Re-run ingestion passes (symbol table, enrichment) against fresh ParsedSymbol[]
8.   Continue to Resolve → Deps → Load
9.   Stats: scip_status: 'cache_hit', scip_duration_ms: 0
```

### Flow 6: Incremental Digest — Only Non-TS Files Changed

```
1-4. Same as Flow 1 through Scan
5.   Diff shows only .md, .json, .css files changed — no .ts/.tsx
6.   SCIP stage: skip entirely (type data can't have changed)
7.   Reuse existing type annotations on Neo4j nodes (don't clear them)
8.   Stats: scip_status: 'skipped_no_ts_changes'
```

---

## Issues Found

### Dead End: CALLS Edges — Queried but Never Created
- **What:** `get_symbol` (index.ts:258,271), `trace_error` (runtime-tools.ts:421) query `[:CALLS]` edges
- **Impact:** These queries always return empty results today — "Called by" section is always empty
- **Fix:** CALLS Edge Extractor creates them from SCIP data. Loader gains `loadCallsToNeo4j()`.

### Missing Source: CALLS Edge Purge on Re-Digest
- **What:** `purgeImportEdges()` deletes IMPORTS and DIRECTLY_IMPORTS but not CALLS
- **Impact:** On incremental re-digest, stale CALLS edges would persist
- **Fix:** Add CALLS edge deletion to `purgeImportEdges()` (rename to `purgeEdges()`)

### Missing Source: ParsedSymbol Type Fields
- **What:** `ParsedSymbol` interface has no type-related fields
- **Impact:** Loader can't write type properties unless the interface is extended
- **Fix:** Add optional fields: `resolved_signature?`, `param_types?`, `return_type?`, `type_errors?`, `is_generic?`, `type_params?`

### Missing Config: SCIP Timeout and Memory Limit
- **What:** No configuration mechanism for SCIP timeout (default 5 min) or Node.js memory limit for the subprocess
- **Impact:** Hardcoded defaults may not suit all environments
- **Fix:** Add to `config.ts`: `scip: { timeout: 300000, maxMemoryMb: 4096, enabled: true }`

### Missing Package: `@sourcegraph/scip`
- **What:** Not in package.json
- **Impact:** Can't parse SCIP index without it
- **Fix:** `npm install @sourcegraph/scip` in packages/backend

### Missing Binary: `scip-typescript`
- **What:** Not installed in dev environment or Docker
- **Impact:** SCIP stage can't run
- **Fix:** `npm install -g @sourcegraph/scip-typescript`, add to Dockerfile

### Phantom Dependency: DirectlyImportsEdge resolved_type
- **What:** Edge enricher needs to match SCIP import occurrences to DirectlyImportsEdge objects
- **Impact:** No line number on DI edges — must match by fromFile + targetSymbolName
- **Fix:** Match by file path + symbol name (both are already on DirectlyImportsEdge)

---

## Wiring Checklist

### Phase 1: Foundation (no SCIP yet — types & infrastructure)

- [ ] Install `@sourcegraph/scip` package in packages/backend
- [ ] Install `scip-typescript` globally (or document as prerequisite)
- [ ] Add SCIP config to `config.ts`: `scip.timeout`, `scip.maxMemoryMb`, `scip.enabled`
- [ ] Extend `ParsedSymbol` interface with optional type fields
- [ ] Define `CallsEdge` interface in a new `packages/backend/src/pipeline/scip/types.ts`
- [ ] Define `ScipStats`, `DiagnosticInfo` interfaces
- [ ] Add `"scip"` to the stage enum in `updateJobStage()`

### Phase 2: SCIP Subprocess & Parser

- [ ] Create `packages/backend/src/pipeline/scip/runner.ts`
  - [ ] `runScipTypescript(repoPath, outputPath, timeoutMs)` → spawn child process
  - [ ] Handle: not installed, non-zero exit, timeout, success
  - [ ] Stream stderr to console for debugging
- [ ] Create `packages/backend/src/pipeline/scip/parser.ts`
  - [ ] `parseScipIndex(indexPath)` → { symbols, occurrences, diagnostics } per file
  - [ ] Handle malformed protobuf gracefully
- [ ] Create `packages/backend/src/pipeline/scip/cache.ts`
  - [ ] `checkCache(repoUrl, commitSha)` → cached index path or null
  - [ ] `cacheIndex(repoUrl, commitSha, indexPath)` → copy to cache dir
  - [ ] Cache dir: `{tempDir}/scip-cache/{repoUrl-hash}/{commitSha}.scip`

### Phase 3: Symbol Table & Node Enrichment

- [ ] Create `packages/backend/src/pipeline/scip/symbol-table.ts`
  - [ ] `buildSymbolTable(scipSymbols, parsedSymbols)` → Map
  - [ ] Parse SCIP symbol IDs to extract file path + name
  - [ ] Log unmatched symbol count
- [ ] Create `packages/backend/src/pipeline/scip/node-enricher.ts`
  - [ ] `enrichSymbols(symbolTable)` → mutate ParsedSymbol[] in place
  - [ ] Extract resolved_signature from SCIP signatureDocumentation
  - [ ] Parse param_types and return_type from signature string
  - [ ] Set is_generic based on type parameters
  - [ ] For Class symbols: extract type_params

### Phase 4: CALLS Edges & Edge Enrichment

- [ ] Create `packages/backend/src/pipeline/scip/calls-extractor.ts`
  - [ ] `extractCallsEdges(occurrences, symbolTable, parsedSymbols)` → CallsEdge[]
  - [ ] For each reference occurrence: find containing function, resolve target
  - [ ] Determine arg types from SCIP occurrence context
- [ ] Create `packages/backend/src/pipeline/scip/edge-enricher.ts`
  - [ ] `enrichCallsEdges(callsEdges, symbolTable)` → add has_type_mismatch, type_mismatch_detail
  - [ ] Use SCIP diagnostics at call site as authoritative mismatch signal
  - [ ] `enrichDirectImports(directImports, occurrences, symbolTable)` → add resolved_type
- [ ] Create `packages/backend/src/pipeline/scip/diagnostics.ts`
  - [ ] `collectDiagnostics(scipDiagnostics, symbolTable)` → DiagnosticInfo[]
  - [ ] Group by severity (error, warning, info) — store errors only for v1

### Phase 5: Pipeline Integration & Loader

- [ ] Create `packages/backend/src/pipeline/scip/index.ts` — stage orchestrator
  - [ ] `runScipStage(input)` → ScipStageResult
  - [ ] Wire: cache check → runner → parser → symbol table → enricher → calls → diagnostics
  - [ ] Fail-open at every level
- [ ] Modify `digest.ts`:
  - [ ] Import `runScipStage`
  - [ ] Add SCIP stage call between Parse and Resolve (after line 263)
  - [ ] Pass enriched symbols to Resolve and Load
  - [ ] Pass callsEdges to new loader function
  - [ ] Merge SCIP stats into digest_jobs.stats
  - [ ] Add `updateJobStage(job.id, "scip")` call
- [ ] Modify `loader.ts`:
  - [ ] `loadSymbolsToNeo4j()` — add SET clauses for type properties
  - [ ] `loadImportsToNeo4j()` — add SET for resolved_type on DIRECTLY_IMPORTS
  - [ ] New: `loadCallsToNeo4j(repoUrl, callsEdges)` — batch insert CALLS edges
  - [ ] New: `purgeCallsEdges(repoUrl)` — delete CALLS edges on re-digest
  - [ ] Update `purgeImportEdges()` to also purge CALLS edges

### Phase 6: MCP Tool Updates

- [ ] New tool: `get_type_info` in `packages/mcp-server/src/index.ts`
  - [ ] Register with McpServer
  - [ ] Schema: name (required), file (optional), repo (optional), include_callers (optional)
  - [ ] Cypher query for type properties + optional caller arg types
  - [ ] Format response with type info sections
- [ ] Modify `get_symbol` handler:
  - [ ] Add type fields to RETURN clause
  - [ ] Append type info to response text when present
  - [ ] Include arg_types and has_type_mismatch on callers (from CALLS edges)
- [ ] Modify `get_dependencies` handler:
  - [ ] Include resolved_type on DIRECTLY_IMPORTS edges in response
  - [ ] Include arg_types on CALLS edges when direction="in"
- [ ] Modify `trace_error` handler (runtime-tools.ts):
  - [ ] Add resolved_signature, param_types to containing function output
  - [ ] Add arg_types, has_type_mismatch to callers query
  - [ ] Format type mismatch detail in response
- [ ] Modify `trace_imports` handler:
  - [ ] Include resolved_type on DIRECTLY_IMPORTS edges in response

### Phase 7: Testing & Validation

- [ ] Create test fixture: small TS repo with known type mismatches
- [ ] Unit test: SCIP runner (mock child_process)
- [ ] Unit test: SCIP parser (use fixture .scip file)
- [ ] Unit test: Symbol table builder (in-memory, no Neo4j)
- [ ] Unit test: CALLS edge extractor
- [ ] Unit test: Type mismatch detection
- [ ] Integration test: Full digest with SCIP on fixture repo
- [ ] Integration test: Digest without scip-typescript installed (graceful skip)
- [ ] Integration test: get_type_info returns correct data
- [ ] Integration test: trace_error includes type mismatch context
- [ ] Validate against target codebase: spot-check param_types, has_type_mismatch

---

## Build Order

### Phase 1: Foundation
**Files:** `parser.ts` (interface changes), `config.ts`, `scip/types.ts`
**Why first:** Everything downstream depends on the type interfaces and config.
**Risk:** Low — interface additions, no behavior changes.

### Phase 2: SCIP Subprocess & Parser
**Files:** `scip/runner.ts`, `scip/parser.ts`, `scip/cache.ts`
**Why second:** The runner and parser are self-contained modules with no downstream dependencies beyond producing data. Can be tested in isolation.
**Risk:** Medium — depends on `scip-typescript` and `@sourcegraph/scip` package behavior.

### Phase 3: Symbol Table & Node Enrichment
**Files:** `scip/symbol-table.ts`, `scip/node-enricher.ts`
**Why third:** Depends on parser output format from Phase 2. Produces enriched symbols consumed by Phase 5.
**Risk:** Medium — SCIP symbol ID parsing and matching is the trickiest part.

### Phase 4: CALLS Edges & Edge Enrichment
**Files:** `scip/calls-extractor.ts`, `scip/edge-enricher.ts`, `scip/diagnostics.ts`
**Why fourth:** Depends on symbol table from Phase 3. CALLS extraction is the highest-value piece.
**Risk:** High — position correlation, containing-function lookup, mismatch detection all have edge cases.

### Phase 5: Pipeline Integration & Loader
**Files:** `scip/index.ts`, `digest.ts`, `loader.ts`
**Why fifth:** Wires all SCIP components into the pipeline and graph. Depends on all prior phases.
**Risk:** Medium — cross-cutting changes to the orchestrator and loader.

### Phase 6: MCP Tool Updates
**Files:** `mcp-server/src/index.ts`, `mcp-server/src/runtime-tools.ts`
**Why sixth:** Depends on graph data being correctly written (Phase 5). Can't test until data exists.
**Risk:** Low — additive changes to existing queries and response formatting.

### Phase 7: Testing & Validation
**Why last:** Integration tests need the full pipeline wired.
**Risk:** This is where unknown-unknowns surface. Budget extra time.
