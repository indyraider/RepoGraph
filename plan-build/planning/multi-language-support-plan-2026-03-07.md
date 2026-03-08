# Build Plan: Multi-Language Support (SCIP Refactor + Rust)
**Created:** 2026-03-07
**Brainstorm:** ../brainstorm/multi-language-support-brainstorm-2026-03-07.md
**Status:** Draft

## Overview
Refactor the SCIP pipeline from hardcoded TypeScript to a generic language adapter pattern, then add Rust as the first new language across all pipeline stages (parsing, SCIP enrichment, import resolution, dependency indexing, stack trace parsing). After this, adding future languages requires only small adapter modules.

## Component Inventory

| # | Component | File(s) | Type | Effort |
|---|-----------|---------|------|--------|
| 1 | SCIP Language Adapter Interface + Registry | `scip/runner.ts` | New interface + refactor | Medium |
| 2 | Generic SCIP Runner | `scip/runner.ts` | Refactor | Medium |
| 3 | SCIP Orchestrator Multi-Language Dispatch | `scip/index.ts` | Modify | Medium |
| 4 | SCIP Symbol ID Multi-Scheme Parser | `scip/parser.ts` | Modify | Low |
| 5 | SCIP Types Update | `scip/types.ts` | Modify | Trivial |
| 6 | Rust Tree-Sitter Parser Walker | `parser.ts` | New function | Medium |
| 7 | Rust Import Resolver | `resolver.ts` | New strategy | Medium-High |
| 8 | Cargo.toml Lockfile Parser | `deps/lockfile.ts` | New function | Low |
| 9 | Rust Stack Trace Regex | `runtime/stack-parser.ts` | Add regex | Trivial |
| 10 | Resolver Language Dispatch | `resolver.ts` | Refactor entry | Low |

All paths relative to `packages/backend/src/pipeline/`.

## Integration Contracts

### Contract 1: Parser → Digest Orchestrator
```
parseFile(filePath, content, "rust") → ParseResult
  What flows:     ParseResult { symbols, imports, exports, barrel: null }
  How it flows:   Direct function call from digest.ts:337 loop
  Auth/Config:    None
  Error path:     try/catch in digest.ts increments parseFailures counter, logs warning, continues
```
**Wire check**: `digest.ts:335` calls `isSupportedLanguage(file.language)` — must add "rust" to the supported set.

### Contract 2: SCIP Adapter → SCIP Runner
```
ScipLanguageAdapter → runScipIndexer(adapter, repoPath, outputPath)
  What flows:     Adapter config (binary path, args, env) → ScipRunResult
  How it flows:   Generic runner spawns child process using adapter config
  Auth/Config:    Adapter's binary must be on PATH or resolvable
  Error path:     Returns ScipRunResult with success=false, error describes failure
```
**Wire check**: Each adapter's `resolveBinary()` must return a valid path or the runner returns `not_installed`.

### Contract 3: SCIP Orchestrator → Adapter Registry
```
runScipStage(input) → getAdaptersForLanguages(detectedLanguages)
  What flows:     Array of language strings from allFiles → deduplicated ScipLanguageAdapter[]
  How it flows:   Orchestrator extracts languages from input.allFiles, queries registry
  Auth/Config:    None
  Error path:     Unknown languages return no adapter (gracefully skipped)
```
**Wire check**: Registry must map "rust" → rustAdapter.

### Contract 4: SCIP Orchestrator → SCIP Runner (multi-language loop)
```
for each adapter: runScipIndexer(adapter, repoPath, outputPath) → ScipRunResult
  What flows:     Per-adapter indexing producing separate .scip files → merged ScipIndexData
  How it flows:   Sequential loop (one indexer at a time to avoid resource contention)
  Auth/Config:    Each adapter's binary availability checked before running
  Error path:     If one adapter fails, log warning and continue with others. Partial results are valid.
```

### Contract 5: SCIP Symbol ID Parser ← Symbol Table Builder
```
parseScipSymbolId(symbolId) → { filePath, name, containerName } | null
  What flows:     Raw SCIP symbol ID string (format varies by indexer) → parsed components
  How it flows:   Called from symbol-table.ts:51 during symbol matching
  Auth/Config:    None
  Error path:     Returns null for unparseable symbols (caller skips them)
```
**Wire check**: Must handle prefix schemes: `scip-typescript npm`, `rust-analyzer cargo`, `scip-python python`, `scip-java maven`.

### Contract 6: Resolver Language Dispatch
```
resolveImports(parsedImports, repoPath, ...) dispatches by file language
  What flows:     ParsedImport[] (with filePath indicating language) → ResolveResult
  How it flows:   Main function checks file extension/language, routes to TS or Rust resolver
  Auth/Config:    None (Rust: needs Cargo.toml for crate name; TS: needs tsconfig.json)
  Error path:     Unknown language imports fall through to existing bare-specifier → external package logic
```

### Contract 7: Lockfile → Deps Indexer
```
parseLockfiles(repoPath) → ParsedDependency[] (now includes registry: "cargo")
  What flows:     Cargo.toml [dependencies] → ParsedDependency[]
  How it flows:   parseLockfiles() checks for Cargo.toml, calls parseCargoToml()
  Auth/Config:    None
  Error path:     File parse errors caught, returns empty array for that lockfile
```
**Wire check**: `ParsedDependency.registry` union type must include `"cargo"`.

### Contract 8: Stack Trace Parser (Rust frames)
```
parseStackTrace(stackTrace) → ParsedFrame[] (now includes Rust panic frames)
  What flows:     Raw stack trace string → structured frames
  How it flows:   New RUST_FRAME regex tried in sequence with existing patterns
  Auth/Config:    None
  Error path:     Unmatched lines are silently skipped (existing behavior)
```

## End-to-End Flows

### Flow 1: Digest a Rust Repository
1. User triggers digest for a Rust repo
2. `digest.ts` → `scanRepo()` scans files, maps `.rs` → `"rust"` ✓ (already works)
3. `digest.ts:335` → `isSupportedLanguage("rust")` → **must return true** (NEW)
4. `digest.ts:337` → `parseFile(path, content, "rust")` → `parseRust()` walker runs (NEW)
5. Returns `ParseResult` with Rust symbols (fn, struct, enum, trait, const, use/mod imports)
6. `digest.ts:358` → `runScipStage(input)` → orchestrator detects Rust files
7. Orchestrator → `getAdaptersForLanguages(["rust"])` → returns `[rustAdapter]` (NEW)
8. Orchestrator → `isAdapterAvailable(rustAdapter)` checks `rust-analyzer` on PATH
9. **If available**: `runScipIndexer(rustAdapter, repoPath, outputPath)` → `rust-analyzer scip`
10. **If not available**: Log warning, skip SCIP enrichment (Rust still gets tree-sitter symbols)
11. SCIP parser → `parseScipIndex()` (unchanged, format is universal)
12. Symbol table builder → `parseScipSymbolId()` handles `rust-analyzer cargo` prefix (NEW)
13. Node enricher → enriches Rust symbols with types (unchanged, works on SCIP data)
14. Calls extractor → extracts Rust CALLS edges (unchanged)
15. `digest.ts:379` → `resolveImports()` → detects Rust files, routes to Rust resolver (NEW)
16. Rust resolver handles `use crate::`, `use super::`, `mod` declarations → file paths
17. `digest.ts:388` → `indexDependencies()` → `parseLockfiles()` → finds `Cargo.toml` (NEW)
18. Parses `[dependencies]` section → `ParsedDependency[]` with `registry: "cargo"`
19. `digest.ts:394` → loads everything to Neo4j + Supabase (unchanged)
20. Temporal pipeline runs automatically (unchanged)

### Flow 2: Digest a Mixed TS + Rust Repository
1. Scanner finds both `.ts` and `.rs` files
2. Parser processes both — `parseTypeScript()` and `parseRust()` walkers
3. SCIP orchestrator → `getAdaptersForLanguages(["typescript", "rust"])` → `[tsAdapter, rustAdapter]`
4. Runs `scip-typescript` first, then `rust-analyzer scip` (sequential)
5. Merges SCIP results from both indexers into one combined dataset
6. Resolver processes TS imports with TS resolver, Rust imports with Rust resolver
7. Lockfile parser finds both `package.json` and `Cargo.toml`
8. Cross-language imports (e.g., Rust FFI calling TS via napi) are not resolved (marked external)

### Flow 3: Runtime Error Trace with Rust Stack
1. Runtime log collector ingests a Rust panic backtrace
2. `parseStackTrace()` → RUST_FRAME regex matches `src/main.rs:42` format (NEW)
3. `trace_error` MCP tool maps frames to code graph nodes (unchanged)
4. Returns source context + callers + resolution hints (unchanged)

### Error Flow: rust-analyzer Not Installed
1. Orchestrator calls `isAdapterAvailable(rustAdapter)` → returns `false`
2. Logs: `[scip] rust-analyzer not found — skipping SCIP enrichment for Rust files`
3. SCIP stage returns `skipped` status for Rust (TS SCIP may still succeed independently)
4. Rust files still get tree-sitter parsing, import resolution, and dependency indexing
5. They just won't have SCIP type enrichment (resolvedSignature, paramTypes, CALLS edges)
6. This is a **graceful degradation**, not a failure

## Issues Found

### Issue 1: `isSupportedLanguage()` Gate (parser.ts:90)
The hardcoded array `["typescript", "tsx", "javascript", "python", "go"]` blocks Rust files from being parsed. Must add `"rust"` to this array and the `SupportedLanguage` union type.

### Issue 2: `resolveImports()` is Fully TS/JS-Centric (resolver.ts:442-630)
The entire function assumes JS/TS conventions: tsconfig paths, barrel unwinding, `.js→.ts` rewriting, node builtins. Rust imports (and future Python/Go imports) need a separate code path. The function needs a language-aware dispatch at the top level.

**Solution**: Detect language from file extension of the importing file. Route Rust files to a `resolveRustImports()` function. Keep existing logic for TS/JS. Python and Go currently fall through to basic relative/external classification which is acceptable for now.

### Issue 3: SCIP Index Merge Strategy (scip/index.ts)
Currently the orchestrator runs one indexer and returns one result. With multiple indexers, we need to merge `ScipIndexData` from multiple runs. The SCIP protobuf format uses `documents[]` keyed by `relativePath` — documents from different indexers won't overlap (TS files vs Rust files), so merging is a simple concatenation of the `documents` arrays.

### Issue 4: `ParsedDependency.registry` Union Type (deps/lockfile.ts:8)
Currently `"npm" | "pypi" | "go"`. Must add `"cargo"` for Rust dependencies.

### Issue 5: SCIP Protobuf Import (scip/parser.ts:7)
Currently imports from `@sourcegraph/scip-typescript/dist/src/scip.js`. This works because the SCIP protobuf definition is bundled with scip-typescript. If scip-typescript is not installed but rust-analyzer is, this import will fail. **Solution**: The SCIP protobuf module should be a direct dependency (`@anthropic/scip-proto` or similar), OR we keep the current import since scip-typescript is already a project dependency and will remain installed regardless of which other indexers are added.

**Decision**: Keep current import — scip-typescript stays as a dependency. The protobuf format is the same regardless of which indexer produced it.

### Issue 6: `parseScipSymbolId()` Prefix Assumptions (scip/parser.ts:180-191)
The "4th space" heuristic works for `scip-typescript npm <pkg> <ver> <path>` but rust-analyzer uses a different scheme: `rust-analyzer cargo <crate> <ver> <path>`. The 4-space heuristic still works since both have 4 tokens before the path. However, other indexers may vary. **Solution**: Make the space-counting more robust — find the backtick and work backward to extract the path, rather than counting from the front.

## Wiring Checklist

### Phase 1: SCIP Runner Refactor (no new language yet)
- [ ] Define `ScipLanguageAdapter` interface in `scip/runner.ts`
- [ ] Create `typescriptAdapter` implementing the interface (extracts existing logic)
- [ ] Create `rustAdapter`, `pythonAdapter`, `javaAdapter` stubs
- [ ] Create adapter registry with `getAdaptersForLanguages()`
- [ ] Create `isAdapterAvailable(adapter)` generic check
- [ ] Create `runScipIndexer(adapter, repoPath, outputPath)` generic runner
- [ ] Keep `runScipTypescript()` as backward-compat wrapper
- [ ] Keep `isScipAvailable()` as backward-compat wrapper
- [ ] Update `scip/index.ts` to use multi-language dispatch loop
- [ ] Update `scip/index.ts` to merge SCIP results from multiple indexers
- [ ] Update `parseScipSymbolId()` to handle multiple symbol ID schemes
- [ ] Update `ScipStats.scipStatus` type to include `"partial"` for multi-adapter mixed results
- [ ] Verify existing TypeScript SCIP flow still works identically (backward compat)

### Phase 2: Rust Tree-Sitter Parser
- [ ] Install `tree-sitter-rust` npm package
- [ ] Add Rust language binding import to `parser.ts`
- [ ] Add `"rust"` to `SupportedLanguage` union type
- [ ] Add `"rust"` case to `getParser()` switch
- [ ] Add `"rust"` to `isSupportedLanguage()` array
- [ ] Add `"rust"` case to `parseFile()` dispatch switch
- [ ] Implement `parseRust()` walker function:
  - [ ] `function_item` → ParsedSymbol (kind: "function")
  - [ ] `impl_item` methods → ParsedSymbol (kind: "function", name: "Type.method")
  - [ ] `struct_item` → ParsedSymbol (kind: "class")
  - [ ] `enum_item` → ParsedSymbol (kind: "class")
  - [ ] `trait_item` → ParsedSymbol (kind: "type")
  - [ ] `type_item` (type alias) → ParsedSymbol (kind: "type")
  - [ ] `const_item` / `static_item` → ParsedSymbol (kind: "constant")
  - [ ] `use_declaration` → ParsedImport
  - [ ] `mod_item` → ParsedImport (mod foo → foo.rs or foo/mod.rs)
  - [ ] `pub` visibility → ParsedExport
  - [ ] Docstring extraction from `///` and `//!` comments

### Phase 3: Rust Import Resolver
- [ ] Add `resolveRustImports()` function to `resolver.ts`
- [ ] Detect Rust files by extension in `resolveImports()` and dispatch
- [ ] Handle `use crate::path::to::module` → resolve from crate root
- [ ] Handle `use super::module` → resolve relative to parent
- [ ] Handle `use self::module` → resolve relative to current module
- [ ] Handle `mod foo;` declarations → `foo.rs` or `foo/mod.rs`
- [ ] Handle `use external_crate::thing` → mark as external, extract crate name
- [ ] Handle `use std::*` → skip standard library imports
- [ ] Parse `Cargo.toml` `[package] name` for crate root identification
- [ ] Create `DirectlyImportsEdge` entries for named imports (`use crate::foo::Bar`)

### Phase 4: Cargo.toml + Stack Traces
- [ ] Add `"cargo"` to `ParsedDependency.registry` union type
- [ ] Add `parseCargoToml()` function to `deps/lockfile.ts`
- [ ] Parse `[dependencies]` section for direct deps
- [ ] Parse `[dev-dependencies]` section
- [ ] Handle version formats: `"1.0"`, `{ version = "1.0", features = [...] }`
- [ ] Add Cargo.toml detection in `parseLockfiles()`
- [ ] Add `RUST_FRAME` regex to `stack-parser.ts`
- [ ] Handle format: `   N: module::function\n             at src/file.rs:42:13`
- [ ] Handle format: `thread 'main' panicked at src/main.rs:10:5`
- [ ] Skip frames from `.cargo/registry/` (external crate frames)

## Build Order

**Phase 1: SCIP Runner Refactor** — Foundation that everything else depends on
- Files: `scip/runner.ts`, `scip/index.ts`, `scip/parser.ts`, `scip/types.ts`
- Checkpoint: Existing TS digest produces identical results (backward compat test)

**Phase 2: Rust Tree-Sitter Parser** — Core parsing, depends on nothing from Phase 1
- Files: `parser.ts`, `package.json` (add tree-sitter-rust)
- Checkpoint: Can parse a Rust file and extract symbols/imports/exports

**Phase 3: Rust Import Resolver** — Depends on Phase 2 parser output format
- Files: `resolver.ts`
- Checkpoint: Can resolve `use crate::` and `mod` declarations to file paths

**Phase 4: Cargo.toml + Stack Traces** — Independent, can run parallel with Phase 3
- Files: `deps/lockfile.ts`, `runtime/stack-parser.ts`
- Checkpoint: Parses Cargo.toml deps, parses Rust panic backtraces

**Phase 5: Integration Test** — After all phases, run full digest on a Rust repo
- Verify end-to-end: scan → parse → SCIP → resolve → deps → load
- Verify Rust symbols appear in Neo4j with correct relationships
- Verify mixed TS+Rust repos work correctly
- Verify graceful degradation when rust-analyzer is not installed
