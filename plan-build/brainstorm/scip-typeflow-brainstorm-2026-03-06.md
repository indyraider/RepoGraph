# Brainstorm: SCIP Type Flow via scip-typescript

**Created:** 2026-03-06
**Status:** Draft
**PRD:** repograph-scip-typeflow-prd.md

## Vision

Add semantic type information to the RepoGraph graph by running `scip-typescript` during the digest pipeline and ingesting the emitted SCIP index. Today the graph knows *that* `handleCheckout` calls `processPayment` — after SCIP it also knows *what types* flow across that call, whether they're compatible, and where the TypeScript compiler flagged mismatches. This turns `trace_error` from "here's where the error happened" into "here's *why* the types diverged."

## Existing Context

**Pipeline:** `Clone → Scan → Parse → Resolve → Deps → Load` orchestrated by `digest.ts` (407 lines). Each stage is a discrete module in `packages/backend/src/pipeline/`.

**Graph storage:** Neo4j for structure (nodes: Repository, File, Function, Class, TypeDef, Constant, Package, PackageExport; edges: CONTAINS_FILE, CONTAINS, EXPORTS, IMPORTS, DIRECTLY_IMPORTS, DEPENDS_ON, PROVIDES). Supabase for file contents, job tracking, runtime logs.

**MCP tools:** 13 tools across `packages/mcp-server/src/index.ts` (graph queries) and `runtime-tools.ts` (logs/errors). Key tools for this feature: `get_symbol`, `get_dependencies`, `trace_imports`, `trace_error`, `query_graph`.

**Current type handling:** Tree-sitter extracts raw signature strings (first line of declaration). `deps/types-fetcher.ts` pulls `.d.ts` type definitions for npm packages. No resolved type information exists on graph nodes or edges today.

**Digest job state:** `digest_jobs` table tracks status (`running`/`complete`/`failed`) and stage (`cloning`/`scanning`/`parsing`/`resolving`/`deps`/`loading`/`done`). Stats stored as JSONB.

---

## Components Identified

### 1. SCIP Subprocess Runner
- **Responsibility**: Execute `scip-typescript index` against the cloned repo, manage timeout/cleanup, return path to `.scip` index file.
- **Upstream (receives from)**: Cloned repo path (from Clone stage), job ID (from digest orchestrator), commit SHA (for cache check).
- **Downstream (sends to)**: `.scip` index file path → SCIP Index Parser.
- **External dependencies**: `scip-typescript` CLI must be installed globally or on PATH. Node.js `child_process` for subprocess management.
- **Hands test**: **PASS** — runs a subprocess and produces a file. Straightforward I/O.

### 2. SCIP Index Parser
- **Responsibility**: Read binary `.scip` protobuf file, expose structured iterators for symbols, occurrences, and diagnostics.
- **Upstream (receives from)**: `.scip` file path from subprocess runner.
- **Downstream (sends to)**: Structured data (symbols, occurrences, diagnostics) → Symbol Table Builder, Node/Edge Enrichment Writers, Diagnostic Storage.
- **External dependencies**: `@sourcegraph/scip` npm package for protobuf parsing.
- **Hands test**: **PASS** — reads a file, returns plain objects. No external calls.

### 3. Symbol Table Builder
- **Responsibility**: Build in-memory `Map<scip_symbol_id, neo4j_node_id>` by matching SCIP symbols to existing graph nodes by file path + symbol name.
- **Upstream (receives from)**: SCIP symbols from parser, existing ParsedSymbol[] from Parse stage.
- **Downstream (sends to)**: Symbol map used by Node Enrichment Writer and Edge Enrichment Writer.
- **External dependencies**: Neo4j queries (batch lookups by file path + name).
- **Hands test**: **CONDITIONAL** — depends on whether matching runs against Neo4j (post-Load) or against in-memory ParsedSymbol[] (pre-Load). If pre-Load, this can be a pure in-memory join. If post-Load, needs Neo4j session. **The PRD places SCIP between Parse and Resolve, meaning Neo4j nodes don't exist yet.** The symbol table must match against the in-memory ParsedSymbol[] array, not Neo4j. This is actually simpler.

### 4. Node Enrichment Writer
- **Responsibility**: Annotate Function and Class nodes with `resolved_signature`, `param_types`, `return_type`, `type_errors`, `is_generic`, `type_params`.
- **Upstream (receives from)**: Symbol table map, SCIP symbol info from parser.
- **Downstream (sends to)**: Enriched symbol data flows into the Load stage → Neo4j node properties.
- **External dependencies**: None if enrichment happens pre-Load (modify ParsedSymbol objects in memory). Neo4j batch writes if post-Load.
- **Hands test**: **PASS** — but the mechanism depends on pipeline placement (see "Pipeline Placement" in Open Questions).

### 5. Edge Enrichment Writer
- **Responsibility**: Annotate CALLS edges with `arg_types`, `has_type_mismatch`, `type_mismatch_detail`. Annotate DIRECTLY_IMPORTS edges with `resolved_type`.
- **Upstream (receives from)**: SCIP occurrences (call sites, import sites) from parser, symbol table map.
- **Downstream (sends to)**: Enriched edge data → Load stage or direct Neo4j writes.
- **External dependencies**: Position correlation — matching SCIP occurrence line numbers to existing edge properties (`call_site_line` on CALLS edges).
- **Hands test**: **FAIL — CRITICAL.** CALLS edges do not exist in the current pipeline. The loader (`loader.ts`) creates CONTAINS, EXPORTS, IMPORTS, DIRECTLY_IMPORTS, DEPENDS_ON, PROVIDES — but **never creates CALLS edges**. Three MCP tools query for `[:CALLS]` relationships (`get_symbol` lines 258/271, `trace_error` line 421), but these queries return empty results today. **The PRD assumes CALLS edges exist and wants to annotate them. They must be created first.** This is the single biggest gap in the plan — SCIP can detect call sites and provide type info for them, but there's no edge to hang that data on.

### 6. CALLS Edge Creator (NEW — not in PRD)
- **Responsibility**: Create `CALLS` edges between Function nodes based on SCIP occurrence data (or tree-sitter call expression analysis).
- **Upstream (receives from)**: SCIP occurrences of type "reference" at call sites, symbol table map.
- **Downstream (sends to)**: CALLS edges in Neo4j, consumed by Edge Enrichment Writer, `get_symbol`, `trace_error`.
- **External dependencies**: SCIP occurrence positions, function node start/end line ranges (to determine which function a call site lives in).
- **Hands test**: **PASS** — SCIP provides the data; this component creates the edges. But it means CALLS edges only exist when SCIP runs. For non-TypeScript repos, CALLS edges still won't exist.

### 7. Diagnostic Storage
- **Responsibility**: Store SCIP diagnostics (type errors, warnings) on relevant graph nodes and in `digest_jobs.stats`.
- **Upstream (receives from)**: SCIP diagnostics from parser, symbol table map (for node attachment).
- **Downstream (sends to)**: `type_errors` property on Function/Class nodes, `type_diagnostics` in digest_jobs stats, UI display.
- **External dependencies**: Supabase for stats update.
- **Hands test**: **PASS** — writes data to existing storage.

### 8. `get_type_info` MCP Tool
- **Responsibility**: New MCP tool for explicit type queries. Returns resolved signature, param types, return type, type errors, optionally caller arg types.
- **Upstream (receives from)**: User query via MCP protocol.
- **Downstream (sends to)**: Claude Code via MCP response.
- **External dependencies**: Neo4j queries against enriched nodes/edges.
- **Hands test**: **PASS** — queries existing data and returns it.

### 9. Existing MCP Tool Enrichment
- **Responsibility**: Update `get_symbol`, `get_dependencies`, `trace_imports`, `trace_error` to include type data in responses when available.
- **Upstream (receives from)**: Existing tool queries + new type properties on nodes/edges.
- **Downstream (sends to)**: Claude Code via enriched MCP responses.
- **External dependencies**: None beyond the graph data existing.
- **Hands test**: **PASS** — but responses should include `type_data_available: false` when SCIP was skipped, so Claude knows the absence is intentional.

### 10. Async SCIP Worker
- **Responsibility**: For large repos (SCIP > 60s), detach subprocess, mark job as `type_data_pending`, apply enrichment when complete.
- **Upstream (receives from)**: SCIP subprocess timing, digest job state.
- **Downstream (sends to)**: Updated graph nodes/edges, updated job status.
- **External dependencies**: Background worker infrastructure, polling mechanism.
- **Hands test**: **CONDITIONAL** — needs a background job runner. The current pipeline is synchronous. This requires new infrastructure (polling loop, or a queue like BullMQ). The PRD describes polling every 10 seconds, but **no background worker infrastructure exists today.**

### 11. SCIP Caching Layer
- **Responsibility**: Cache `.scip` index by commit SHA. Skip re-running when HEAD hasn't changed or only non-TS files changed.
- **Upstream (receives from)**: Commit SHA from Clone stage, file diff from Scan stage.
- **Downstream (sends to)**: Decision to skip/run SCIP subprocess.
- **External dependencies**: File system (cached index storage) or Supabase Storage.
- **Hands test**: **PASS** — file I/O and simple comparison logic.

### 12. Loader Updates
- **Responsibility**: Extend `loader.ts` to write new node properties and edge types to Neo4j.
- **Upstream (receives from)**: Enriched symbols and edges from SCIP processing.
- **Downstream (sends to)**: Neo4j graph.
- **External dependencies**: Updated Cypher queries, new Neo4j indexes.
- **Hands test**: **PASS** — extends existing batch write patterns.

### 13. Dockerfile / Infrastructure Updates
- **Responsibility**: Install `scip-typescript` in container, add health check.
- **Upstream (receives from)**: Docker build.
- **Downstream (sends to)**: Runtime availability of `scip-typescript` binary.
- **External dependencies**: npm registry, Dockerfile in repo.
- **Hands test**: **PASS** — standard Docker layer.

---

## Rough Dependency Map

```
                    Clone (repo path, commit SHA)
                           │
                         Scan (file diff)
                           │
                         Parse (ParsedSymbol[], ParsedImport[], ParsedExport[])
                           │
                    ┌──────┴──────┐
                    │             │
            SCIP Runner     (parallel?)
                    │
             SCIP Parser
                    │
          ┌────────┼────────┬──────────┐
          │        │        │          │
    Symbol Table  Diags   Occurrences  │
     Builder       │        │          │
          │        │    ┌───┴───┐      │
          │        │    │       │      │
          │     Diag  CALLS   Edge    │
          │    Storage Creator Enricher│
          │        │    │       │      │
          │        │    └───┬───┘      │
          │        │        │          │
    Node Enricher  │        │          │
          │        │        │          │
          └────────┴────────┘          │
                    │                  │
                 Resolve ◄─────────────┘
                    │
                   Deps
                    │
                  Load (writes everything to Neo4j)
                    │
              MCP Tools (query enriched graph)
```

## Open Questions

### 1. Pipeline Placement: Between Parse and Resolve, or After Load?
The PRD says SCIP runs between Parse and Resolve so the resolver can use type info to disambiguate same-named functions. But this means all enrichment must happen in-memory against ParsedSymbol[] objects — Neo4j nodes don't exist yet. The alternative is running SCIP after Load and writing type data directly to Neo4j. **Trade-off:** pre-Load is cleaner (one write pass) but requires extending ParsedSymbol with type fields; post-Load is simpler (just SET properties) but means two write passes and resolver can't use type data.

### 2. CALLS Edges: Who Creates Them?
The biggest gap. Options:
- **Option A:** SCIP creates them from occurrence data (call-site references). Pro: SCIP has authoritative caller→callee mappings. Con: CALLS edges only exist for TS repos where SCIP runs.
- **Option B:** Tree-sitter creates them during Parse (analyze `call_expression` nodes). Pro: works for all languages. Con: significant Parse stage expansion, less accurate than compiler analysis.
- **Option C:** SCIP creates them for TS, tree-sitter creates them for other languages (separate effort). Pro: best accuracy per language. Con: two code paths.
- **Recommendation:** Option A for this feature. CALLS edges are most valuable when paired with type data. A follow-up can add tree-sitter-based CALLS for other languages.

### 3. Async Worker Infrastructure
The PRD calls for async SCIP execution for large repos with a polling worker. No such infrastructure exists. Options:
- **Option A:** Simple `setTimeout`-based polling in the Node.js process.
- **Option B:** Proper job queue (BullMQ + Redis).
- **Option C:** Defer async to v2 — always run synchronously, accept longer digest times.
- **Recommendation:** Option C for v1. The async pathway adds significant complexity for an edge case. Revisit if SCIP consistently exceeds 60s on target repos.

### 4. OVERRIDES / IMPLEMENTS_METHOD Edges
The PRD defines these new relationship types but doesn't detail how SCIP occurrence data maps to them. SCIP's `Relationship` entries include `implementation` and `reference` kinds. Need to verify what `scip-typescript` actually emits for class method overrides and interface implementations.

### 5. Memory Limits on Large Repos
The PRD mentions streaming fallback for large SCIP indexes. Need to understand typical index sizes for the target repos and whether the full in-memory approach is viable.

---

## Risks and Concerns

### Critical: CALLS Edges Don't Exist
This is the #1 risk. The entire value proposition of SCIP type flow depends on annotating CALLS edges with type information. These edges must be created as part of this feature or as an immediate prerequisite. Three MCP tools already query for them and get nothing.

### High: Pipeline Placement Complexity
Inserting SCIP between Parse and Resolve requires modifying the ParsedSymbol interface, the digest orchestrator, and the loader's understanding of what data to write. This is a cross-cutting change that touches every stage downstream.

### Medium: scip-typescript Reliability
`scip-typescript` may fail on repos without tsconfig, with complex monorepo setups, or with unusual compiler configurations. The fail-open design mitigates this, but validation against real repos is essential before committing to the architecture.

### Medium: Position Correlation for Edge Annotation
Matching SCIP occurrence positions (line:column) to existing edges requires that edges carry position data. CALLS edges will be created with position info (from SCIP), so this is self-consistent. But DIRECTLY_IMPORTS edges currently carry no line number — matching SCIP import occurrences to them requires matching by file path + symbol name instead of position.

### Low: `@sourcegraph/scip` Package Stability
This package wraps protobuf parsing. If the SCIP protocol version changes, the parser may need updates. Pinning the version mitigates this.
