# Phase 3 Audit: Loader + Neo4j Schema + Digest Orchestrator
**Date:** 2026-03-06
**Status:** PASS (with observations)

---

## Wiring Checklist Verification

### 1. Constant name index in neo4j.ts — PASS
- Line 42: `CREATE INDEX constant_name IF NOT EXISTS FOR (c:Constant) ON (c.name)` is present.
- All four symbol types (Function, Class, TypeDef, Constant) now have name indexes, which is necessary for the `DIRECTLY_IMPORTS` Cypher `OPTIONAL MATCH (sym {name: ...})` to perform efficiently.

### 2. loadImportsToNeo4j enriched IMPORTS + DIRECTLY_IMPORTS — PASS
- **Signature** (line 222): `resolveResult: ResolveResult | ResolvedImport[]` — union type supports backward compat.
- **Decomposition** (lines 228-229): `Array.isArray()` check correctly branches between old `ResolvedImport[]` (returns empty `directImports`) and new `ResolveResult`.
- **Enriched IMPORTS Cypher** (lines 252-263): All four new properties are SET: `resolution_status`, `resolved_path`, `barrel_hops`, `unresolved_symbols`. Parameter names (`imp.resolution_status`, etc.) are consistent with the object built at lines 233-247.
- **`as any` cast** (line 236): Used to access `resolutionStatus`, `resolvedPath`, `barrelHops`, `unresolvedSymbols` on `ResolvedImport`. These properties exist on `EnrichedResolvedImport` (which extends `ResolvedImport`), and since `resolveResult.imports` is typed as `EnrichedResolvedImport[]`, the actual runtime objects will always have these fields. The `as any` is structurally safe. Fallback defaults (`|| "resolved"`, `|| null`, `|| 0`, `|| []`) handle the backward-compat path when a plain `ResolvedImport[]` is passed.
- **DIRECTLY_IMPORTS Cypher** (lines 307-317):
  - Uses `OPTIONAL MATCH` + `WHERE sym IS NOT NULL` — correctly handles the case where the symbol node doesn't exist in Neo4j (the edge is simply skipped).
  - Label filter `WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant` prevents matching unrelated nodes.
  - `MERGE (from)-[r:DIRECTLY_IMPORTS]->(sym)` is idempotent.
  - Parameter name `$directImports` matches the session.run arg `{ directImports: batch }` — consistent.

### 3. purgeImportEdges deletes DIRECTLY_IMPORTS — PASS
- Lines 461-465: Third `session.run` deletes `DIRECTLY_IMPORTS` edges: `MATCH (f:File {repo_url: $repoUrl})-[r:DIRECTLY_IMPORTS]->() DELETE r`.
- If no `DIRECTLY_IMPORTS` edges exist (e.g., pre-resolution digests), the `MATCH` simply returns zero rows and `DELETE` is a no-op. No error.
- Note: The purge only deletes outgoing `DIRECTLY_IMPORTS` from files in this repo. Since DIRECTLY_IMPORTS always originates from a File node, this is correct and complete. There is no need for a reverse-direction purge (unlike IMPORTS, which has a reverse purge at lines 455-458) because DIRECTLY_IMPORTS targets symbol nodes, not files from other repos.

### 4. digest.ts passes resolveResult correctly — PASS
- **Both call sites** pass `resolveResult` (not `resolveResult.imports`):
  - Incremental path, line 306: `importEdges = await loadImportsToNeo4j(req.url, resolveResult);`
  - Full reload path, line 322: `importEdges = await loadImportsToNeo4j(req.url, resolveResult);`
- **resolveImports call** (line 255): Passes all five arguments including `allExports`, `allSymbols`, `barrelMap`.
- **Stats mapping** (lines 339-348): All stat fields correctly reference `resolveResult.stats.*` and `resolveResult.imports.length` / `resolveResult.directImports.length`. Field names match the `ResolveResult.stats` interface in resolver.ts.

---

## Execution Chain Verification

### loadImportsToNeo4j handles BOTH old and new input — PASS
- `Array.isArray(resolveResult)` returns `true` for `ResolvedImport[]`, `false` for `ResolveResult` (an object with `.imports`, `.directImports`, `.stats`).
- When old format: `imports = resolveResult` (the array itself), `directImports = []` (empty, so the DIRECTLY_IMPORTS loop at line 294 is skipped).
- When new format: `imports = resolveResult.imports`, `directImports = resolveResult.directImports`.

### Enriched IMPORTS Cypher correctly SETs all new properties — PASS
- The Cypher at lines 253-262 sets `r.resolution_status`, `r.resolved_path`, `r.barrel_hops`, `r.unresolved_symbols` using parameter names that match the object keys at lines 242-246.
- `unresolved_symbols` is set as an array (Neo4j supports list properties). Empty arrays are valid.

### DIRECTLY_IMPORTS Cypher handles missing symbol nodes — PASS
- `OPTIONAL MATCH` + `WHERE sym IS NOT NULL` pattern (lines 310-313) means: if no node matches the symbol name/file_path/repo_url combination, `sym` is `NULL`, the `WHERE` filters it out, and no edge is created.
- The `edgeCount` at line 319 adds `batch.length` regardless of how many edges were actually created. This is a **minor inaccuracy** — the count reflects attempted edges, not actually created edges. The same pattern exists in the original EXPORTS edge loading (line 211). Consistent but slightly inflated.

### purgeImportEdges handles no-edges case — PASS
- All three `DELETE` statements are simple pattern matches. Zero matches = zero deletes = no error.

---

## Data Flow Verification

### Cypher parameter names vs code — PASS
All parameter names are consistent:
| Code object key | Cypher parameter | Match |
|---|---|---|
| `from_path` | `imp.from_path` | Yes |
| `to_path` | `imp.to_path` | Yes |
| `resolution_status` | `imp.resolution_status` | Yes |
| `resolved_path` | `imp.resolved_path` | Yes |
| `barrel_hops` | `imp.barrel_hops` | Yes |
| `unresolved_symbols` | `imp.unresolved_symbols` | Yes |
| `from_path` (DI) | `di.from_path` | Yes |
| `symbol_name` | `di.symbol_name` | Yes |
| `target_file_path` | `di.target_file_path` | Yes |
| `import_kind` | `di.import_kind` | Yes |
| `alias` | `di.alias` | Yes |
| `repo_url` | `di.repo_url` | Yes |

### `as any` cast safety — PASS (with note)
The `as any` at line 236 is used because the `imports` variable is typed as `ResolvedImport[]` (from the union decomposition at line 228). In practice:
- New path: `resolveResult.imports` returns `EnrichedResolvedImport[]`, so all enriched fields exist.
- Old path: Plain `ResolvedImport[]` objects lack enriched fields. The fallback defaults (`|| "resolved"`, `|| null`, `|| 0`, `|| []`) handle this correctly.

### Stats fields in digest.ts vs ResolveResult.stats — PASS
| digest.ts field | Source | Exists in ResolveResult.stats |
|---|---|---|
| `resolveResult.stats.resolved` | Line 341 | Yes |
| `resolveResult.stats.unresolvable` | Line 342 | Yes |
| `resolveResult.stats.dynamic` | Line 343 | Yes |
| `resolveResult.stats.external` | Line 344 | Yes |
| `resolveResult.stats.unresolvedSymbols` | Line 345 | Yes |
| `resolveResult.stats.barrelCycles` | Line 346 | Yes |
| `resolveResult.stats.barrelDepthExceeded` | Line 347 | Yes |
| `resolveResult.imports.length` | Line 339 | N/A (array property) |
| `resolveResult.directImports.length` | Line 340 | N/A (array property) |

---

## Error Path Verification

### Missing symbol node in Neo4j (DIRECTLY_IMPORTS) — SAFE
The `OPTIONAL MATCH` + `WHERE sym IS NOT NULL` pattern silently skips edges where the target symbol doesn't exist. This handles:
- Race conditions where symbols haven't been loaded yet (not applicable here since symbols are loaded before imports in both paths).
- Symbol nodes that were never created because parsing failed for that file.
- Namespace import aliases (e.g., `* as React`) which generate `DirectlyImportsEdge` entries in resolver.ts (lines 575-586) but whose `targetSymbolName` is the alias, not a real symbol node. These are correctly dropped.

### Enriched fields missing (backward compat) — SAFE
When `loadImportsToNeo4j` receives a plain `ResolvedImport[]`:
- `enriched.resolutionStatus` is `undefined` → fallback to `"resolved"`.
- `enriched.resolvedPath` is `undefined` → fallback to `null`.
- `enriched.barrelHops` is `undefined` → fallback to `0`.
- `enriched.unresolvedSymbols` is `undefined` → fallback to `[]`.

All defaults are semantically correct for pre-resolution imports.

---

## Observations (Non-Blocking)

### OBS-1: DigestResult.stats type is narrower than actual runtime object
The `DigestResult` interface (digest.ts lines 24-36) does not declare the new stats fields (`directImportCount`, `resolvedImports`, `unresolvedImports`, `dynamicImports`, `externalImports`, `unresolvedSymbols`, `barrelCycles`, `barrelDepthExceeded`). TypeScript does not flag this because the `stats` object is assigned to a local variable before being returned (no excess property checking on non-literal assignment). The extra fields are persisted correctly to Supabase JSONB but are invisible through the `DigestResult` type. Any consumer reading these fields from the return value would need a cast.

**Recommendation:** Update the `DigestResult.stats` interface to include the new optional fields, or use a broader type. This can be done in Phase 4 or later — it does not block correctness.

### OBS-2: Namespace import edges are created then silently dropped
Resolver.ts lines 575-586 create `DirectlyImportsEdge` entries for namespace imports (`import * as X from '...'`), with `targetSymbolName` set to the alias name. These will never match a symbol node in Neo4j (no Function/Class/TypeDef/Constant named "X" at that file path), so the `OPTIONAL MATCH` + `WHERE sym IS NOT NULL` filter drops them. This is correct behavior but wastes a small amount of work. The `directImportCount` stat will be slightly inflated.

**Recommendation:** Consider filtering out `importKind: "namespace"` edges in the loader before sending to Neo4j, or simply accept the minor overhead.

### OBS-3: edgeCount for DIRECTLY_IMPORTS is inflated
Line 319 adds `batch.length` to `edgeCount` for every batch, but the `OPTIONAL MATCH` + `WHERE sym IS NOT NULL` pattern means some edges in the batch may not actually be created. The reported edge count may be higher than the actual Neo4j edge count. Same pattern exists for EXPORTS edges (line 211). Consistent behavior across the codebase.

---

## Verdict: PASS

All four wiring checklist items are correctly implemented. Execution chains, data flow, and error paths are sound. The three observations are minor and non-blocking.
