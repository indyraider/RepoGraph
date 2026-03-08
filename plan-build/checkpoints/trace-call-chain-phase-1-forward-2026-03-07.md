# Phase 1 Forward Plan Review
**Phase completed:** Core Query Layer
**Date:** 2026-03-07
**Plan updates needed:** YES

## Actual Interfaces Built

The developer built significantly ahead of the plan. Phase 1 was supposed to deliver only the core query layer (registration shell, start node resolver, traversal queries). In practice, the file contains the full implementation including all Phase 2 deliverables.

### Exported Functions

| Function | Signature | Return Type |
|----------|-----------|-------------|
| `registerCallChainTools` | `(server: McpServer, getSession: GetSessionFn, _getSupabase: GetSupabaseFn, scopedRepo: string \| null = null) => void` | `void` |

### Internal Functions

| Function | Signature | Return Type |
|----------|-----------|-------------|
| `temporalFilter` | `(alias: string, commitTs: string \| null) => string` | `string` |
| `resolveCommitTs` | `(session: Session, repo: string, commitSha: string) => Promise<string \| null>` | `Promise<string \| null>` |
| `resolveStartNode` | `(session: Session, name: string, repo: string, file: string \| null, commitTs: string \| null) => Promise<{ok: true, node: StartNode} \| {ok: false, error: string, candidates?: ...}>` | Discriminated union |
| `traverseUpstream` | `(session: Session, startName: string, startFilePath: string, repoUrl: string, maxDepth: number, scope: string \| null, commitTs: string \| null) => Promise<Array<{chain, edges}>>` | Path array |
| `traverseDownstream` | `(session: Session, startName: string, startFilePath: string, repoUrl: string, maxDepth: number, scope: string \| null, commitTs: string \| null) => Promise<Array<{chain, edges}>>` | Path array |
| `buildTree` | `(startNode: StartNode, paths: Array<{chain, edges}>, direction: "upstream" \| "downstream", scope: string \| null) => {root: ChainNode, stats: Partial<TraceStats>}` | Tree + stats |
| `formatTree` | `(node: ChainNode, prefix: string, isLast: boolean, isRoot: boolean) => string` | `string` |
| `formatResponse` | `(startNode: StartNode, upstreamTree: {root, stats} \| null, downstreamTree: {root, stats} \| null, direction: string) => string` | `string` |
| `toNum` | `(val: unknown) => number` | `number` |
| `filterExternal` | `(node: ChainNode) => void` | `void` (mutates in-place) |

### TypeScript Types

| Type | Shape |
|------|-------|
| `GetSessionFn` | `() => Session` |
| `GetSupabaseFn` | `() => SupabaseClient` |
| `ChainNode` | `{ name, kind, file, start_line, end_line, edge_type, call_site_line, is_entry_point, is_leaf, is_external, children: ChainNode[] }` |
| `StartNode` | `{ name, kind, file, start_line, end_line, signature }` |
| `TraceStats` | `{ total_nodes, max_depth_reached, cross_module_jumps, scope_exits, truncated }` |

### Zod Schema (tool registration)

| Parameter | Type | Default |
|-----------|------|---------|
| `start` | `z.string()` | required |
| `repo` | `z.string().optional()` | scoped repo |
| `file` | `z.string().optional()` | - |
| `direction` | `z.enum(["upstream","downstream","both"]).optional()` | `"both"` |
| `max_depth` | `z.number().optional()` | `10` |
| `scope` | `z.string().optional()` | - |
| `include_external` | `z.boolean().optional()` | `false` |
| `at_commit` | `z.string().optional()` | - |

## Mismatches with Plan

### 1. Phase 2 work was completed in Phase 1

- **Plan says:** Phase 1 delivers only "Core Query Layer" (registration function, temporalFilter, resolveCommitTs, start node resolution, disambiguation, upstream/downstream traversal queries, depth limiting, scope filtering, temporal filtering). Phase 2 adds: cross-module detection, tree assembler, entry/leaf detection, external node detection, stats computation, response formatter, node cap (500), query LIMIT (200).
- **Code actually:** All Phase 2 items are fully implemented in the Phase 1 deliverable:
  - Cross-module detection: lines 265-268 (`buildTree` compares `file_path` between parent/child)
  - Tree assembler: `buildTree` function, lines 216-335
  - Entry point detection: lines 308-314
  - Leaf detection: lines 317-323
  - External node detection: lines 276-278 (checks `node_modules` and `PackageExport`)
  - Stats computation: lines 326-334
  - Response formatter: `formatResponse` + `formatTree`, lines 339-413
  - Node cap (500): line 228 `const NODE_CAP = 500;`, enforced at lines 248 and 255
  - Query LIMIT (200): applied in both `traverseUpstream` (line 156) and `traverseDownstream` (line 196)
  - `filterExternal` function: lines 610-616 (removes external nodes when `include_external=false`)
- **Downstream impact:** Phase 2 has no remaining work. It is fully complete.
- **Plan update:** Mark Phase 2 as DONE. Phase 3 (wiring) becomes the next and only remaining phase.

### 2. Supabase parameter naming: `_getSupabase` (unused)

- **Plan says:** Registration signature uses `getSupabase` (matching temporal-tools.ts)
- **Code actually:** Parameter is named `_getSupabase` with underscore prefix, indicating it is unused. This is correct -- the tool only uses Neo4j sessions, not Supabase. TypeScript will not warn about unused params with the underscore prefix.
- **Downstream impact:** None. The call site in index.ts passes `getUserSupabase` positionally, so the parameter name is irrelevant.
- **Plan update:** None needed.

### 3. `buildTree` returns `Partial<TraceStats>` not `TraceStats`

- **Plan says:** Tree assembler outputs `ChainNode tree + stats`
- **Code actually:** `buildTree` returns `{ root: ChainNode; stats: Partial<TraceStats> }`. The stats are complete in practice (all 5 fields are always set), but the type is declared as `Partial`. `formatResponse` then merges them into a full `TraceStats` with fallback defaults.
- **Downstream impact:** None -- this is internal typing and works correctly.
- **Plan update:** None needed.

### 4. Repo URL resolution is done twice (minor inefficiency)

- **Plan says:** Start node resolver handles repo resolution.
- **Code actually:** The tool handler resolves `repoUrl` separately (lines 524-539) before calling `resolveStartNode`, then passes the repo name (not URL) to `resolveStartNode`, which re-resolves the repo internally. The `repoUrl` from the handler is then passed to `traverseUpstream`/`traverseDownstream`.
- **Downstream impact:** None functionally -- minor extra query. Not worth changing.
- **Plan update:** None needed.

### 5. `edge_type` includes IMPORTS/DIRECTLY_IMPORTS in type but not in practice

- **Plan says:** Tool walks `CALLS` edges only.
- **Code actually:** The `ChainNode.edge_type` type is `"CALLS" | "IMPORTS" | "DIRECTLY_IMPORTS" | null`, but the code only ever sets it to `"CALLS"` (line 289) or `null` (line 238 for root). The extra union members are dead type surface.
- **Downstream impact:** None. Future extension point if import-chain walking is added.
- **Plan update:** None needed.

## Hook Points for Next Phase

Phase 2 is complete (built ahead). Phase 3 (Wiring and Integration) needs:

1. **Import statement in index.ts** (~line 10 area): `import { registerCallChainTools } from "./call-chain-tools.js"`
2. **Registration call in index.ts** (after line 1209): `registerCallChainTools(server, getSession, getUserSupabase, SCOPED_REPO);`
3. **TypeScript build verification**: `npm run build` in `packages/mcp-server`

The registration signature matches the existing pattern exactly:
- `registerTemporalTools(server, getSession, getUserSupabase, SCOPED_REPO)` at line 1209
- `registerCallChainTools(server, getSession, _getSupabase, scopedRepo)` -- positional match confirmed

## Recommended Plan Updates

1. **Mark Phase 2 as DONE/SKIP.** Every checklist item from Phase 2 has been implemented in Phase 1. The tree assembler, cross-module detection, entry/leaf/external detection, stats computation, response formatter, node cap, and query LIMIT are all present and complete.

2. **Phase 3 is now the only remaining phase.** It consists of exactly 3 tasks:
   - Add import to index.ts
   - Add registration call to index.ts
   - Run `npm run build` to verify TypeScript compilation

3. **No interface changes needed.** The exported `registerCallChainTools` function signature matches the exact pattern used by `registerTemporalTools` and `registerRuntimeTools`. The call site wiring is a straightforward copy of the existing pattern.
