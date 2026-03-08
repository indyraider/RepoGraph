# Temporal Graph Phase 2 Audit: Clone + Commit Ingestion

**Date:** 2026-03-07
**Auditor:** Claude Opus 4.6
**Status:** PASS WITH ISSUES (2 bugs, 1 design gap, 2 minor items)

---

## Files Audited

| File | Status | Lines |
|------|--------|-------|
| `packages/backend/src/pipeline/cloner.ts` | Modified | 89 |
| `packages/backend/src/pipeline/commit-ingester.ts` | New | 157 |
| `packages/backend/src/pipeline/digest.ts` | Modified | 529 |
| `packages/backend/src/db/neo4j.ts` | Modified | 67 |

---

## Wiring Checklist Verification

### Clone Stage

| Checklist Item | Status | Evidence |
|---------------|--------|----------|
| Add `historyDepth?: number` to `DigestRequest` | PASS | `digest.ts:26` — `historyDepth?: number` with JSDoc comment |
| Modify `cloneRepo()` to accept `depth` parameter | PASS | `cloner.ts:54` — `depth: number = 1` with default |
| Change `["--depth", "1"]` to configurable depth args | PASS | `cloner.ts:62` — `depth > 0 ? ["--depth", String(depth)] : ["--branch", branch]` |
| Handle `localPath` mode: use existing .git for history | PASS | `digest.ts:214-225` — `isLocalPath` branch reads SHA from local `.git` via `simpleGit(scanPath)` |

### Commit History Ingester

| Checklist Item | Status | Evidence |
|---------------|--------|----------|
| Create `commit-ingester.ts` | PASS | New file at `packages/backend/src/pipeline/commit-ingester.ts` |
| Define `CommitMeta` type | PASS | `commit-ingester.ts:5-12` — all 6 fields present |
| Implement `ingestCommitHistory()` | PASS | `commit-ingester.ts:25-157` — full implementation |
| Use `simple-git` `.log({maxCount})` | PASS | `commit-ingester.ts:36` — `git.log({ maxCount: maxCommits })` |
| Batch create Commit nodes in Neo4j | PASS | `commit-ingester.ts:84-106` — UNWIND + MERGE with BATCH_SIZE=100 |
| Create HAS_COMMIT edges | PASS | `commit-ingester.ts:102-103` — `MERGE (r)-[:HAS_COMMIT]->(commit)` |
| Create PARENT_OF edges | PASS | `commit-ingester.ts:120-127` — batched with MATCH+MERGE |
| Batch insert to Supabase `commits` table | PASS | `commit-ingester.ts:134-153` — upsert with `onConflict: "repo_id,sha"` |
| Wire into `runDigest()` after clone, before scan | PASS | `digest.ts:262-270` — Stage 1.5, after clone, before Stage 2 scan |
| Error handling: log warning and continue | PASS | `digest.ts:267-268` — try/catch with `console.warn`, non-fatal |

### Neo4j Indexes

| Checklist Item | Status | Evidence |
|---------------|--------|----------|
| Composite commit index `(sha, repo_url)` | PASS | `neo4j.ts:47` — `CREATE INDEX commit_identity IF NOT EXISTS FOR (c:Commit) ON (c.sha, c.repo_url)` |
| Individual commit indexes | PASS | `neo4j.ts:45-46` — separate indexes on `sha` and `repo_url` |
| Temporal indexes on all node labels | PASS | `neo4j.ts:48-52` — File, Function, Class, TypeDef, Constant |

---

## Execution Chain Verification

### 1. Does `cloneRepo()` pass depth to `git.clone()`?
**PASS.** `cloner.ts:62` builds `cloneArgs` dynamically:
- `depth > 0`: `["--depth", String(depth), "--branch", branch]`
- `depth === 0`: `["--branch", branch]` (full clone, no depth limit)

Then `cloner.ts:65`: `git.clone(cloneUrl, localPath, cloneArgs)` passes args directly.

### 2. Does `historyDepth` flow from `DigestRequest` through to `cloneRepo()`?
**PASS.** `digest.ts:227`: `await cloneRepo(req.url, req.branch, req.historyDepth ?? 1)` — defaults to 1 (backward compatible).

### 3. Does `ingestCommitHistory()` get called at the right point in `runDigest()`?
**PASS.** `digest.ts:262-270`: Called as "Stage 1.5" after clone completes and after same-commit early-exit check, but before scan (Stage 2). Wrapped in try/catch so failure is non-fatal.

### 4. Does the commit ingester create Commit nodes, HAS_COMMIT, and PARENT_OF edges?
**PASS.** All three are created:
- Commit nodes: `commit-ingester.ts:94-105` via `MERGE (commit:Commit {sha, repo_url})`
- HAS_COMMIT: `commit-ingester.ts:102-103` via `MERGE (r)-[:HAS_COMMIT]->(commit)`
- PARENT_OF: `commit-ingester.ts:120-127` via `MERGE (parent)-[:PARENT_OF]->(child)`

### 5. Is PARENT_OF direction correct (parent -> child)?
**PASS.** `commit-ingester.ts:124`: `(parent)-[:PARENT_OF]->(child)` — this is the correct semantic direction. A parent commit points to its child, matching git's DAG convention where the relationship reads "parent is a parent of child."

### 6. Is error handling non-fatal?
**PASS.** Two layers:
- `commit-ingester.ts:45-51`: git log failure returns `{ commitsIngested: 0 }` with `console.warn`
- `digest.ts:267-268`: Outer try/catch in `runDigest()` catches any thrown error, logs warning, continues

---

## Bug: parentShas Not Populated from `simple-git` `.log()` -- SEVERITY: MEDIUM

**Location:** `commit-ingester.ts:43`

```typescript
parentShas: entry.refs ? [] : [], // simple-git doesn't expose parents directly
```

**Problem:** This line always produces an empty array regardless of the `entry.refs` value. The ternary is a no-op (both branches return `[]`). The comment acknowledges the issue.

**Mitigation present:** Lines 56-78 use a raw `git log --format=%H %P` command to extract parent SHAs in a second pass, then backfill the `commits` array. This works correctly.

**Verdict:** The dead code on line 43 is harmless but misleading. The real parent extraction happens via the raw git log. **No data loss, but the dead ternary should be cleaned up to just `parentShas: []`** to avoid confusion.

---

## Bug: PARENT_OF Edges Silently Fail for Shallow Clones -- SEVERITY: MEDIUM

**Location:** `commit-ingester.ts:120-127`

```typescript
MATCH (child:Commit {sha: e.sha, repo_url: e.repoUrl})
MATCH (parent:Commit {sha: e.parentSha, repo_url: e.repoUrl})
MERGE (parent)-[:PARENT_OF]->(child)
```

**Problem:** With `--depth 1`, only one commit is cloned. That commit's parent SHA is known (from `git log --format=%H %P`), but the parent Commit node does NOT exist in Neo4j because only 1 commit was ingested. The `MATCH (parent:Commit ...)` will match zero rows, so the PARENT_OF edge silently fails to be created.

**Impact:** For `historyDepth=1` (the default), no PARENT_OF edges are ever created. This is technically correct behavior (you only have 1 commit, no parent exists), but the code does unnecessary work building `parentEdges` and running a Cypher query that will always match nothing.

**Recommendation:** Add an early exit: if `maxCommits === 1`, skip the parent edge creation entirely. Or document that PARENT_OF edges are only meaningful when `historyDepth > 1`.

---

## Design Gap: CloneResult Does Not Include `depth` -- SEVERITY: LOW

**Location:** `cloner.ts:19-22`

The build plan checklist item says: "Update `CloneResult` type to include `depth` for downstream use." This was NOT done. `CloneResult` is still:
```typescript
export interface CloneResult {
  localPath: string;
  commitSha: string;
}
```

**Impact:** Low. No downstream code currently needs `depth` from `CloneResult` since `digest.ts` already has `req.historyDepth` available. But this deviates from the plan.

---

## Minor: Neo4j Session Not in Transaction -- SEVERITY: LOW

**Location:** `commit-ingester.ts:81-131`

The commit node creation, HAS_COMMIT edges, and PARENT_OF edges are run as separate `session.run()` calls, not wrapped in an explicit transaction. If the process crashes between creating Commit nodes and creating PARENT_OF edges, the graph will have orphaned commit nodes without parent links.

**Impact:** Low. MERGE is idempotent, so re-running the ingester fixes the state. But the build plan Contract 3 says "Transaction failure -> rollback, log error, continue digest." There is no explicit transaction wrapping to enable rollback.

**Recommendation:** Wrap the Neo4j writes in `session.writeTransaction()` for atomicity, matching the contract spec.

---

## Minor: `simple-git` Import Style Inconsistency -- SEVERITY: COSMETIC

**Location:** `digest.ts:218` vs `commit-ingester.ts:1`

- `commit-ingester.ts:1`: `import { simpleGit } from "simple-git"` (static import)
- `digest.ts:218`: `const { simpleGit } = await import("simple-git")` (dynamic import)

The dynamic import in `digest.ts` is only for the `localPath` branch. This works but creates a style inconsistency. Since `simple-git` is already a dependency and used statically elsewhere, both could use static imports.

---

## Data Flow Verification

### CommitMeta type vs Supabase `commits` table schema

| CommitMeta field | Supabase column | Match? |
|-----------------|-----------------|--------|
| `sha` | `sha TEXT NOT NULL` | PASS |
| `author` | `author TEXT NOT NULL` | PASS |
| `authorEmail` | `author_email TEXT` | PASS |
| `timestamp` (Date) | `timestamp TIMESTAMPTZ NOT NULL` | PASS (`.toISOString()` used) |
| `message` | `message TEXT` | PASS |
| `parentShas` (string[]) | `parent_shas TEXT[] DEFAULT '{}'` | PASS |
| — | `repo_id UUID NOT NULL` | PASS (added in upsert batch, line 137) |
| — | `id UUID PRIMARY KEY` | PASS (auto-generated) |
| — | `created_at TIMESTAMPTZ` | PASS (auto-generated) |
| — | `UNIQUE(repo_id, sha)` | PASS (matches `onConflict: "repo_id,sha"` on line 148) |

**Full alignment confirmed.**

### Cypher Identity Keys

| Cypher statement | Identity key | Correct? |
|-----------------|-------------|----------|
| Commit MERGE | `{sha, repo_url}` | PASS — matches index `commit_identity` |
| HAS_COMMIT MERGE | `(r:Repository {url})-[:HAS_COMMIT]->(commit)` | PASS |
| PARENT_OF MERGE | `(parent:Commit {sha, repo_url})-[:PARENT_OF]->(child)` | PASS |

---

## Stubs and Placeholders

- **No TODOs found** in `commit-ingester.ts`
- **No empty function bodies** in any audited file
- **No hardcoded data** that should be dynamic (depth is parameterized, batch size is a constant)
- The `parentShas: entry.refs ? [] : []` on line 43 is effectively dead code (see bug above)

---

## Configuration Verification

### `simple-git` on shallow clones
**PASS.** `git.log({ maxCount: maxCommits })` works correctly on shallow clones. `simple-git` just calls `git log` under the hood, which returns whatever commits are available. If the clone has fewer commits than `maxCount`, it returns what it has.

The raw `git log --format=%H %P` fallback for parent SHAs also works on shallow clones -- it simply returns the parent SHA even if that parent commit object is not available locally.

### Package installation
**PASS.** `simple-git: ^3.32.3` is in `packages/backend/package.json`.

### Import validity
**PASS.** All imports verified:
- `commit-ingester.ts` imports: `simple-git`, `../db/neo4j.js`, `../db/supabase.js` -- all valid
- `digest.ts` line 12: `import { ingestCommitHistory } from "./commit-ingester.js"` -- valid

---

## Summary

| Category | Finding | Severity | Action Required |
|----------|---------|----------|----------------|
| Bug | `parentShas: entry.refs ? [] : []` dead ternary | LOW | Clean up to `parentShas: []` |
| Bug | PARENT_OF edges silently fail for depth=1 | MEDIUM | Add early exit or document |
| Gap | `CloneResult` missing `depth` field per plan | LOW | Add if needed by later phases |
| Design | Neo4j writes not in explicit transaction | LOW | Wrap in `writeTransaction()` |
| Cosmetic | Dynamic vs static import of `simple-git` | COSMETIC | Standardize |

**Overall Phase 2 verdict: PASS.** The core execution chain is wired correctly. `historyDepth` flows from `DigestRequest` through `cloneRepo()` and into `ingestCommitHistory()`. Commit nodes, HAS_COMMIT edges, and PARENT_OF edges are all created with correct Cypher. Supabase schema alignment is perfect. Error handling is properly non-fatal. The two medium-severity items are edge cases that do not break the happy path but should be cleaned up before Phase 3 begins.
