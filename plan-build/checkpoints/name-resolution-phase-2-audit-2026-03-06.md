# Phase 2 Audit: Resolver Enhancement
**Date:** 2026-03-06
**Auditor:** Claude Opus 4.6
**Files audited:**
- `/packages/backend/src/pipeline/resolver.ts` (entire file, 604 lines)
- `/packages/backend/src/pipeline/digest.ts` (updated call site, line 255)
- `/packages/backend/src/pipeline/loader.ts` (backward compat check, lines 220-282, 400-418)
- `/packages/backend/src/pipeline/parser.ts` (type definitions, lines 9-48)

---

## Wiring Checklist Verification

### 1. loadTsConfig follows extends chains with cycle detection
**STATUS: PASS**

- `loadTsConfig()` delegates to `loadTsConfigFromPath()` with a `visited: Set<string>` (line 62).
- `loadTsConfigFromPath()` resolves the config path to an absolute path via `path.resolve()` (line 70), checks the visited set (line 72), adds itself before recursing (line 73).
- Extends resolution (lines 87-101): reads `config.extends`, resolves relative to the current config's directory, tries with `.json` suffix if not found.
- Merge logic (lines 97-99): child `baseUrl` wins if present, otherwise parent's. Paths are spread with `{ ...parent.paths, ...result.paths }` so child keys override parent keys.
- No depth cap on extends chains (the plan says "Cap at 10 levels of extends"). The cycle detection prevents infinite loops, but a non-cyclic chain of 50 tsconfigs would be followed. This is unlikely in practice but technically deviates from the plan.
- **Merge correctness test** (base has `@/*`, child adds `@app/*`): `{ ...parent.paths, ...result.paths }` produces `{ "@/*": ["src/*"], "@app/*": ["src/app/*"] }`. Correct.
- **Override test** (both define `@/*`): child's value wins because it's on the right side of the spread. Correct.
- Errors in extends chain are silently caught by the outer `try/catch` on line 105 which returns `null`. This means a malformed parent config causes the entire config chain to return null, not just the parent. The plan says "warn, use what's collected so far" but the implementation drops everything.

### 2. EnrichedResolvedImport, DirectlyImportsEdge, and ResolveResult types
**STATUS: PASS**

- `EnrichedResolvedImport extends ResolvedImport` (line 19) correctly adds `resolutionStatus`, `resolvedPath`, `barrelHops`, `unresolvedSymbols`. All fields match the plan's Contract 5.
- `DirectlyImportsEdge` (lines 26-31) matches Contract 5.
- `ResolveResult` (lines 34-47) matches the plan's type definition exactly.

### 3. unwindBarrel() function
**STATUS: PASS with FINDINGS**

#### Strict barrel handling: PASS
- Iterates `barrel.reExports`, checks if any re-export provides the requested symbols (line 296 for named, line 279 for wildcard).

#### Hybrid barrel handling: PASS
- Lines 312-319: after failing to match re-exports, checks if the hybrid barrel's local exports match the requested symbols, and returns the barrel itself as terminal.

#### Wildcard export * handling: PASS with FINDING
- Lines 272-292: resolves the wildcard target path, checks if the target's exports include the requested symbols, and recursively unwinds.
- Lines 282-284: If the target doesn't directly export the symbol but IS itself a barrel, the code optimistically follows the chain (`providesRequestedSymbol = true`). This is a reasonable heuristic but could cause incorrect terminal paths if the nested barrel also doesn't provide the symbol.

#### Nested barrels: PASS
- Recursive call on lines 287-289 and 302-304 correctly passes through `currentVisited` and increments depth.

#### Cycle detection: PASS
- `currentVisited.has(filePath)` on line 255 catches cycles. Returns with `flag: "barrel_cycle"`.

#### Depth exceeded: PASS
- `currentDepth >= MAX_BARREL_DEPTH` on line 252 triggers early return with `flag: "barrel_depth_exceeded"`.

#### FINDING B1 (MEDIUM) - Memoization key is too coarse
- The memo key is just `filePath` (line 247), not `filePath:symbolName`. The plan explicitly says to key by `filePath:symbolName`.
- **Impact:** If file `index.ts` is a barrel re-exporting `Button` from `./Button` and `Icon` from `./Icon`, the first call `unwindBarrel("index.ts", ["Button"], ...)` caches `index.ts -> Button/Button.tsx`. A subsequent call `unwindBarrel("index.ts", ["Icon"], ...)` returns the cached result pointing to `Button/Button.tsx` instead of `Icon/Icon.tsx`.
- **Severity:** This is a correctness bug. Different symbols imported from the same barrel file will all resolve to whichever terminal was cached first.
- **Fix:** Change memo key to include the symbol(s): `const memoKey = \`${filePath}:${importedSymbols.sort().join(",")}\``.

### 4. resolveSymbols() function
**STATUS: PASS**

#### Named import found: PASS
- Lines 362-368: checks `exportNames.has(symName)`, then looks up in `symbolsByName` for the kind.

#### Named import not found: PASS
- Lines 375-377: pushes to `unresolved`.

#### Named import exported but no symbol node: PASS
- Lines 372-374: exported but no corresponding ParsedSymbol entry (e.g., type-only re-export). Correctly falls to unresolved.

#### Default import: PASS
- Lines 381-398: finds default export, matches symbol, builds `importKind: "default"`.

#### Namespace import: PASS
- Lines 400-402: namespace imports are skipped in `resolveSymbols` (comment says "resolved lazily"). The namespace handling is done in the caller at lines 575-586.

#### FINDING S1 (LOW) - symbolsByName Map overwrites duplicates
- Line 355: `new Map(fileSymbols.map((s) => [s.name, s]))` — if a file has two symbols with the same name (e.g., a function and a type), only the last one survives in the Map. In practice this is rare (TypeScript doesn't allow duplicate names in the same scope for most cases), but overloaded functions or declaration merging could trigger this.

### 5. resolveImports() main loop sequencing
**STATUS: PASS with CRITICAL FINDING**

#### Sequence: PASS
- Path resolution (lines 485-529) -> barrel unwinding (lines 531-552) -> symbol resolution (lines 554-587) -> enriched import construction (lines 589-601). Correct order.

#### FINDING R1 (CRITICAL) - Operator precedence bug
- Line 557: `if (allExports && allSymbols && namedSymbols.length > 0 || defaultImport)`
- JavaScript operator precedence: `&&` binds tighter than `||`.
- This evaluates as: `if ((allExports && allSymbols && namedSymbols.length > 0) || defaultImport)`
- **Impact:** When `defaultImport` is truthy but `allExports`/`allSymbols` are undefined/null (i.e., caller didn't pass them), the code enters the symbol resolution block and calls `resolveSymbols()` with empty maps. This won't crash (the maps default to empty via `|| []` inside resolveSymbols), but it will always produce unresolved results, inflating `stats.unresolvedSymbols`.
- **Likely author intent:** `if (allExports && allSymbols && (namedSymbols.length > 0 || defaultImport))` — gate the entire block on having the data, then check if there's anything to resolve.
- **Fix:** Add parentheses: `if (allExports && allSymbols && (namedSymbols.length > 0 || defaultImport))`

#### Node builtins skip path: no stats increment
- Lines 466-469: When a Node builtin is detected, `stats.total++` has already fired (line 463) but no category counter is incremented. The import is silently dropped.
- **Impact:** `stats.total` will be higher than the sum of `resolved + external + unresolvable + dynamic`. This isn't a bug per se (builtins are intentionally excluded), but it means the stats don't add up. Consider either not incrementing `total` for builtins, or adding a `builtins` counter.

### 6. digest.ts call site
**STATUS: PASS**

- Line 255: `const resolveResult = resolveImports(allImports, scanPath, allExports, allSymbols, barrelMap);`
- Passes all five arguments correctly. `scanPath` is the repo root path.
- Lines 306, 322: `loadImportsToNeo4j(req.url, resolveResult.imports)` — passes `EnrichedResolvedImport[]` to a function typed to accept `ResolvedImport[]`.

---

## DATA FLOW Findings

### FINDING D1 (MEDIUM) - Loader backward compat works by accident, enriched data is lost
- `loader.ts` line 222: `loadImportsToNeo4j` accepts `ResolvedImport[]`. Since `EnrichedResolvedImport extends ResolvedImport`, TypeScript allows passing the enriched array.
- However, the Cypher on lines 242-247 only writes `r.symbols = imp.symbols`. The enriched fields (`resolution_status`, `resolved_path`, `barrel_hops`, `unresolved_symbols`) are present on the objects but **never written to Neo4j**.
- This means Phase 2's enrichment data is computed but silently discarded at the Neo4j write step.
- **This is expected** — the plan assigns loader Cypher updates to Phase 3. But it means Phase 2 in isolation produces enriched data that goes nowhere. The `directImports` array from `ResolveResult` is also not written anywhere yet.
- **No action needed now**, but Phase 3 must update the loader to use these fields.

### FINDING D2 (LOW) - Stats from ResolveResult not persisted to digest_jobs
- `digest.ts` lines 336-346: the `stats` object written to `digest_jobs` does not include any of the new resolution stats (`unresolvedSymbols`, `barrelCycles`, `barrelDepthExceeded`, `directImportEdges`).
- Again, this is Phase 3 scope per the plan, but worth noting as a gap.

### FINDING D3 (INFO) - purgeImportEdges does not purge DIRECTLY_IMPORTS
- `loader.ts` lines 400-418: only purges `IMPORTS` edges. Phase 3 must add `DIRECTLY_IMPORTS` purge.
- This is called out in the plan (Issues Found, Dead End #1) and assigned to Phase 3.

---

## STUBS AND PLACEHOLDERS

**No TODOs, FIXMEs, or placeholder logic found in resolver.ts.** Clean.

---

## SILENTLY SWALLOWED ERRORS

### FINDING E1 (LOW) - loadTsConfigFromPath catch swallows all errors
- Line 105: `catch { return null; }` — any JSON parse error, file permission error, or unexpected exception is silently swallowed. No warning is logged.
- The plan says "Malformed tsconfig in chain -> warn, use what's collected so far." The implementation neither warns nor uses partial data — it returns null for the entire chain.
- **Fix:** Add `console.warn` in the catch block. Consider returning partial results from already-parsed parent configs.

### FINDING E2 (INFO) - Barrel unwind silently continues on unresolvable re-export paths
- Lines 274-275, 299-300: `if (!targetPath) continue;` — if a re-export source path can't be resolved, the re-export is silently skipped. This is reasonable behavior but means some barrel chains may terminate early without any signal.

---

## Summary of Findings

| ID | Severity | Description | Action Required |
|----|----------|-------------|-----------------|
| **R1** | **CRITICAL** | Operator precedence bug on line 557: `allExports && allSymbols && namedSymbols.length > 0 \|\| defaultImport` evaluates incorrectly when `defaultImport` is truthy but maps are missing | Add parentheses: `(namedSymbols.length > 0 \|\| defaultImport)` |
| **B1** | **MEDIUM** | Barrel memo key is `filePath` only, not `filePath:symbol`. Different symbols from same barrel return wrong cached terminal | Change key to include symbols |
| **D1** | **MEDIUM** | Enriched import fields computed but never written to Neo4j (loader not updated yet) | Phase 3 must update loader Cypher |
| **E1** | **LOW** | loadTsConfigFromPath silently swallows all errors, returns null for entire chain | Add console.warn, consider partial results |
| **S1** | **LOW** | symbolsByName Map overwrites duplicate symbol names | Consider using Map of arrays |
| Stats gap | **LOW** | Node builtins increment total but no category; stats don't sum | Add builtins counter or skip total increment |
| D2 | **INFO** | Resolution stats not in digest_jobs.stats yet | Phase 3 |
| D3 | **INFO** | purgeImportEdges doesn't purge DIRECTLY_IMPORTS yet | Phase 3 |
| E2 | **INFO** | Unresolvable re-export source paths silently skipped | Acceptable |
| Extends depth | **INFO** | No depth cap on tsconfig extends (plan says 10) | Very low risk |

---

## Verdict

**Phase 2 has two bugs that must be fixed before proceeding to Phase 3:**

1. **R1 (CRITICAL):** The operator precedence bug on line 557 of `resolver.ts` will cause `resolveSymbols()` to run with empty maps when only a default import is present and the caller omitted export/symbol data. Fix with parentheses.

2. **B1 (MEDIUM):** The barrel memo key collision will cause incorrect terminal path resolution when multiple symbols are imported from different re-export targets through the same barrel. Fix by including symbol names in the key.

All other findings are either Phase 3 scope (expected gaps) or low-severity issues that can be addressed opportunistically.
