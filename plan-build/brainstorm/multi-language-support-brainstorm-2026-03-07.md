# Brainstorm: Multi-Language Support (SCIP Refactor + Rust)
**Created:** 2026-03-07
**Status:** Draft

## Vision
Refactor RepoGraph's SCIP pipeline from hardcoded TypeScript-only to a language adapter pattern, then add Rust as the first new language. This closes the biggest competitive gap vs CodeGraphContext (18 languages vs our 3) while preserving our depth advantages (type-aware CALLS edges, temporal tracking, runtime logs). After this refactor, adding future languages (Java, Kotlin, Python SCIP, Go SCIP) becomes a matter of writing small adapter modules rather than touching core pipeline logic.

## Existing Context

### Pipeline Architecture (via RepoGraph MCP analysis)
The digest pipeline has 6 stages: Clone → Scan → Parse → SCIP → Resolve → Deps → Load.

**Language-agnostic layers (zero work per language):**
- Digest orchestrator (`packages/backend/src/pipeline/digest.ts`) — dispatches stages, no language logic
- Temporal pipeline (`temporal-loader.ts`, `commit-ingester.ts`, `differ.ts`) — operates on graph nodes/edges
- Complexity metrics (`complexity.ts`) — queries graph topology
- Neo4j/Supabase loader (`loader.ts`) — works on `ParsedSymbol[]` interface
- SCIP downstream (`scip/symbol-table.ts`, `scip/node-enricher.ts`, `scip/calls-extractor.ts`, `scip/edge-enricher.ts`) — operates on standardized SCIP protobuf format

**Language-specific layers (need adapter per language):**
- Tree-sitter parser (`parser.ts`) — per-language AST walker function
- Import resolver (`resolver.ts`) — per-language module resolution strategy
- SCIP runner (`scip/runner.ts`) — currently hardcoded to `scip-typescript`
- SCIP symbol ID parser (`scip/parser.ts:parseScipSymbolId()`) — assumes `scip-typescript npm` prefix

**Partially generic (trivial to extend):**
- Scanner (`scanner.ts`) — already maps `.rs` → `"rust"` in `EXTENSION_LANGUAGE_MAP`
- Lockfile parser (`deps/lockfile.ts`) — already supports npm/pypi/go, needs `Cargo.toml`
- Stack trace parser (`runtime/stack-parser.ts`) — already has Node/Python/Go regexes, needs Rust panic format

### Key Interfaces (from source)
All parsers return `ParseResult { symbols: ParsedSymbol[], imports: ParsedImport[], exports: ParsedExport[], barrel: BarrelInfo | null }` — this interface is stable.

All resolvers return `ResolveResult { imports: EnrichedResolvedImport[], directImports: DirectlyImportsEdge[], stats }` — this interface is stable.

SCIP stage takes `ScipStageInput` and returns `ScipStageResult` — both are language-agnostic interfaces.

### SCIP Indexer Ecosystem (Sourcegraph)
Available SCIP indexers that emit the same `.scip` protobuf format:
- `scip-typescript` — current, via npm
- `rust-analyzer scip` — built into rust-analyzer, emits SCIP directly
- `scip-python` — via npm or pip
- `scip-java` — via coursier, also handles Kotlin
- `scip-go` — via go install

All produce the same binary protobuf format. The downstream SCIP pipeline (`parser.ts`, `symbol-table.ts`, `node-enricher.ts`, `calls-extractor.ts`, `edge-enricher.ts`) works on any of them unchanged. Only the runner and symbol ID parser need per-language adaptation.

## Components Identified

### 1. SCIP Language Adapter Interface (NEW)
- **Responsibility**: Define a common interface for language-specific SCIP indexer configuration
- **Upstream (receives from)**: Nothing — it's a type/interface definition
- **Downstream (sends to)**: SCIP runner (generic), SCIP orchestrator
- **External dependencies**: None
- **Hands test**: PASS — pure type definition

### 2. SCIP Runner Refactor (MODIFY `scip/runner.ts`)
- **Responsibility**: Replace `runScipTypescript()` with a generic `runScipIndexer()` that takes an adapter. Keep `runScipTypescript()` as a backward-compat wrapper.
- **Upstream (receives from)**: SCIP orchestrator passes adapter + repoPath + outputPath
- **Downstream (sends to)**: Returns `ScipRunResult` (unchanged interface)
- **External dependencies**: Each adapter's binary must be on PATH or resolvable
- **Hands test**: PASS — spawns child process same as before, just parameterized

### 3. SCIP Adapter Registry (NEW, in `scip/runner.ts`)
- **Responsibility**: Map language strings to their SCIP adapter. Provide `getAdaptersForLanguages()` to deduplicate (TS/TSX/JS all map to one adapter).
- **Upstream (receives from)**: Language strings from scanned files
- **Downstream (sends to)**: SCIP orchestrator uses this to decide which indexers to run
- **External dependencies**: None
- **Hands test**: PASS — pure lookup

### 4. SCIP Orchestrator Update (MODIFY `scip/index.ts`)
- **Responsibility**: Replace TS-only language gate with multi-language dispatch. For each adapter with matching files, check binary availability and run the indexer.
- **Upstream (receives from)**: `ScipStageInput` with `allFiles` (already has language field)
- **Downstream (sends to)**: `ScipStageResult` (unchanged), merges results from multiple indexers
- **External dependencies**: None
- **Hands test**: PASS — calls runner which spawns processes

### 5. SCIP Symbol ID Parser Update (MODIFY `scip/parser.ts:parseScipSymbolId()`)
- **Responsibility**: Handle different SCIP symbol ID prefixes: `scip-typescript npm`, `rust-analyzer cargo`, `scip-python python`, `scip-java maven`
- **Upstream (receives from)**: `buildSymbolTable()` in `symbol-table.ts`
- **Downstream (sends to)**: Returns `{ filePath, name, containerName }` (unchanged)
- **External dependencies**: None
- **Hands test**: PASS — pure string parsing

### 6. Rust Tree-Sitter Parser (NEW function in `parser.ts`)
- **Responsibility**: Walk Rust AST and extract functions, structs/enums/traits, type aliases, constants, use/mod imports, pub exports
- **Upstream (receives from)**: `parseFile()` dispatches based on language
- **Downstream (sends to)**: Returns `ParseResult` (same interface as TS/Python/Go)
- **External dependencies**: `tree-sitter-rust` npm package (must be installed)
- **Hands test**: PASS if `tree-sitter-rust` is in dependencies

### 7. Rust Import Resolver (NEW strategy in `resolver.ts`)
- **Responsibility**: Resolve Rust `use` statements and `mod` declarations to file paths
- **Upstream (receives from)**: `resolveImports()` dispatches based on file language
- **Downstream (sends to)**: Returns `ResolveResult` (same interface)
- **External dependencies**: None — resolves against filesystem
- **Hands test**: PASS — Rust module resolution is filesystem-based (`mod.rs` convention)

### 8. Cargo.toml Parser (NEW function in `deps/lockfile.ts`)
- **Responsibility**: Parse `Cargo.toml` for direct dependencies
- **Upstream (receives from)**: `parseLockfiles()` checks for `Cargo.toml` existence
- **Downstream (sends to)**: Returns `ParsedDependency[]` with `registry: "cargo"`
- **External dependencies**: None
- **Hands test**: PASS — file parsing

### 9. Rust Stack Trace Regex (ADD to `stack-parser.ts`)
- **Responsibility**: Parse Rust panic backtraces: `at src/main.rs:42:13` and `<module>::function` format
- **Upstream (receives from)**: `parseStackTrace()` tries each regex pattern
- **Downstream (sends to)**: Returns `ParsedFrame[]` (same interface)
- **External dependencies**: None
- **Hands test**: PASS — regex matching

### 10. SCIP Types Update (MODIFY `scip/types.ts`)
- **Responsibility**: Update `ScipStats.scipStatus` to include multi-language statuses
- **Upstream (receives from)**: Nothing — type definition
- **Downstream (sends to)**: Used by SCIP orchestrator and digest
- **External dependencies**: None
- **Hands test**: PASS — pure types

## Rough Dependency Map

```
Scanner (already maps .rs)
    ↓
Parser (parseFile → parseRust)  ←  tree-sitter-rust npm package
    ↓
SCIP Orchestrator (index.ts)
    ↓ uses
SCIP Adapter Registry → SCIP Language Adapter Interface
    ↓ dispatches to
SCIP Runner (generic runScipIndexer)  ←  rust-analyzer binary
    ↓ produces .scip file
SCIP Parser (parseScipIndex — already generic)
    ↓
SCIP Symbol ID Parser (parseScipSymbolId — needs multi-scheme)
    ↓
SCIP Downstream (symbol-table → node-enricher → calls-extractor → edge-enricher)
    [ALL LANGUAGE-AGNOSTIC — NO CHANGES]
    ↓
Resolver (resolveImports → resolveRustImports)
    ↓
Deps (parseLockfiles → parseCargoToml)
    ↓
Loader → Neo4j + Supabase  [NO CHANGES]
    ↓
Temporal Pipeline  [NO CHANGES]
    ↓
Runtime Stack Parser (add Rust regex)
```

## Open Questions
1. **rust-analyzer SCIP output location**: Does `rust-analyzer scip` support `--output` flag, or does it always write to `index.scip` in the project dir? Need to verify and handle either way.
2. **Cargo workspace support**: Should we handle multi-crate Cargo workspaces in the initial implementation, or start with single-crate repos?
3. **Rust edition detection**: Does tree-sitter-rust handle all Rust editions (2015, 2018, 2021, 2024) or do we need edition-specific parsing?
4. **npm package availability**: Is `tree-sitter-rust` published and compatible with our tree-sitter version?

## Risks and Concerns
1. **rust-analyzer availability**: Unlike `scip-typescript` which is an npm dep we control, `rust-analyzer` must be installed on the host system. The SCIP runner should gracefully skip if not available (which the adapter pattern handles).
2. **Rust module resolution complexity**: Rust's module system has edge cases (`#[path = "..."]` attributes, conditional compilation with `#[cfg()]`, proc macros generating modules). Initial implementation should handle the 90% case (standard `mod`/`use` with filesystem convention) and flag the rest as unresolvable.
3. **SCIP symbol ID format variance**: Different indexers use different symbol ID schemes. The parser needs to be robust against unknown formats (return null rather than crash).
4. **Test coverage**: Each new component needs unit tests, especially the Rust parser walker and import resolver which have many edge cases.
