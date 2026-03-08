# Temporal Graph -- Phase 2 Forward-Looking Checkpoint
**Date:** 2026-03-07
**Phase completed:** Phase 2 (Clone + Commit Ingestion)
**Remaining phases:** 3 (Diff Engine), 4 (Temporal Loader + Orchestrator), 5 (Complexity Metrics + Historical Backfill), 6 (MCP Tools)

---

## Extracted Interfaces (Actual Code)

### 1. `cloneRepo()` -- New Signature
**File:** `packages/backend/src/pipeline/cloner.ts:51-54`
```ts
export async function cloneRepo(
  url: string,
  branch: string,
  depth: number = 1
): Promise<CloneResult>
```
- `depth > 0` produces `["--depth", String(depth), "--branch", branch]`
- `depth === 0` (or negative) produces `["--branch", branch]` (full clone, no depth limit)
- `CloneResult` is unchanged: `{ localPath: string; commitSha: string }` -- no `depth` field added

### 2. `ingestCommitHistory()` -- Full Signature
**File:** `packages/backend/src/pipeline/commit-ingester.ts:25-30`
```ts
export async function ingestCommitHistory(
  localPath: string,
  repoUrl: string,
  repoId: string,
  maxCommits: number = 1
): Promise<{ commitsIngested: number }>
```
- Parameter is `maxCommits`, not `depth` as the plan's Contract 2 specifies
- Takes `repoId` (Supabase UUID) as a required 3rd parameter -- plan Contract 2 omits this
- Returns `{ commitsIngested: number }` -- a count only, no commit metadata returned

### 3. `CommitMeta` -- Type Definition
**File:** `packages/backend/src/pipeline/commit-ingester.ts:5-12`
```ts
export interface CommitMeta {
  sha: string;
  author: string;
  authorEmail: string;
  timestamp: Date;
  message: string;
  parentShas: string[];
}
```
- Matches plan exactly. Type is exported and available for downstream consumption.

### 4. `DigestRequest` -- New `historyDepth` Field
**File:** `packages/backend/src/pipeline/digest.ts:26`
```ts
historyDepth?: number;
```
- Comment: `/** Clone depth for git history access. 0 = full clone, 1 = shallow (default). */`
- Used at `digest.ts:227`: `cloneRepo(req.url, req.branch, req.historyDepth ?? 1)`
- Used at `digest.ts:263-266`: `const historyDepth = req.historyDepth ?? 1;` then passed as `maxCommits` to `ingestCommitHistory`

### 5. Neo4j Commit Node -- Properties Being SET
**File:** `packages/backend/src/pipeline/commit-ingester.ts:94-103`
```cypher
MERGE (commit:Commit {sha: c.sha, repo_url: c.repo_url})
SET commit.author = c.author,
    commit.author_email = c.author_email,
    commit.timestamp = datetime(c.timestamp),
    commit.message = c.message
```
**Identity key:** `{sha, repo_url}` (composite)
**Properties available:** `sha`, `repo_url`, `author`, `author_email`, `timestamp` (datetime), `message`

**Edges created:**
- `(Repository)-[:HAS_COMMIT]->(Commit)` -- via MERGE (line 103)
- `(parent:Commit)-[:PARENT_OF]->(child:Commit)` -- via MERGE (line 124)

### 6. Supabase `commits` Row -- Columns Being Inserted
**File:** `packages/backend/src/pipeline/commit-ingester.ts:136-143`
```ts
{
  repo_id: repoId,        // string (UUID)
  sha: c.sha,             // string
  author: c.author,       // string
  author_email: c.authorEmail,  // string
  timestamp: c.timestamp.toISOString(),  // string (ISO 8601)
  message: c.message,     // string
  parent_shas: c.parentShas,  // string[]
}
```
- Uses `upsert` with `onConflict: "repo_id,sha"` -- safe for re-runs

### 7. Neo4j Indexes Created
**File:** `packages/backend/src/db/neo4j.ts:45-52`
- `commit_sha` on `(Commit.sha)` -- single-field
- `commit_repo` on `(Commit.repo_url)` -- single-field
- `commit_identity` on `(Commit.sha, Commit.repo_url)` -- composite
- Temporal indexes on `(valid_from_ts, valid_to_ts)` for File, Function, Class, TypeDef, Constant

### 8. Wiring in `runDigest()`
**File:** `packages/backend/src/pipeline/digest.ts:262-269`
```ts
const historyDepth = req.historyDepth ?? 1;
if (scanPath && historyDepth > 0) {
  try {
    await ingestCommitHistory(scanPath, req.url, repo.id, historyDepth);
  } catch (err) {
    console.warn("[digest] Commit history ingestion failed (non-fatal):", ...);
  }
}
```
- Called after clone, before scan (Stage 1.5) -- matches plan
- Non-fatal: caught and logged, digest continues

---

## Mismatch Detection

### MISMATCH 1: `ingestCommitHistory` return type is too thin for Phase 4 (Temporal Loader)
**Severity: MEDIUM -- requires Phase 4 workaround**

Phase 4 (Temporal Loader) needs `CommitMeta` for the HEAD commit to set `valid_from`, `valid_from_ts`, `changed_by`, and `commit_message` on versioned nodes, and to create `INTRODUCED_IN` edges. The current function returns only `{ commitsIngested: number }` -- no commit metadata.

The plan's Contract 6 expects:
```
valid_from=commitSha, valid_from_ts=commitTs, change_type="created",
changed_by=author, commit_message=message
```

**Current state:** `runDigest()` already has `commitSha` from `cloneRepo()`, but does NOT have `author`, `authorEmail`, `timestamp`, or `message` for the HEAD commit.

**Options for Phase 4:**
1. Change `ingestCommitHistory` to return `CommitMeta[]` (the array it already builds internally at line 37-44)
2. Add a separate `getHeadCommitMeta(localPath)` helper
3. Have the temporal loader query the Commit node from Neo4j (it was just written) -- adds a round-trip but avoids changing Phase 2 code

**Recommendation:** Option 1 is cleanest. The `commits` array is already built; just return it. This is a one-line change: `return { commitsIngested: commits.length, commits }`.

### MISMATCH 2: Plan Contract 2 signature differs from actual
**Severity: LOW -- documentation only**

Plan says: `ingestCommitHistory(localPath, commitSha, historyDepth)`
Actual:    `ingestCommitHistory(localPath, repoUrl, repoId, maxCommits)`

The actual signature is better (needs `repoUrl` for Neo4j identity, `repoId` for Supabase FK). The plan just needs updating. No code change needed.

### MISMATCH 3: `CloneResult` does not include `depth`
**Severity: NONE**

Plan checklist says "Update CloneResult type to include depth for downstream use." This was not done, but no downstream consumer actually needs depth from CloneResult -- `historyDepth` is read directly from `DigestRequest` at line 263. Non-issue.

### MISMATCH 4: Parent SHA extraction is fragile
**Severity: LOW -- affects Phase 5 backfill quality, not correctness**

At line 43, the initial `simple-git` `.log()` sets `parentShas: entry.refs ? [] : []` -- always empty array. The real parent extraction happens via a second `git.raw()` call (lines 56-78). If that raw call fails (e.g., shallow clone with missing parents), PARENT_OF edges won't be created. Phase 5 (Historical Backfill) loops through commits oldest-to-newest and relies on PARENT_OF edges to understand commit ordering.

**Impact on Phase 5:** Backfill independently calls `git.log()` to get the commit list, so ordering is not dependent on PARENT_OF edges. However, MCP tools like `diff_graph(from_ref, to_ref)` in Phase 6 may need PARENT_OF to walk commit ranges. The fallback is acceptable for now since full clones (used in backfill) will have parent data available.

---

## Dependency Readiness for Each Remaining Phase

### Phase 3 (Diff Engine) -- READY with notes

**What Phase 3 needs from Phase 2:**
- Commit nodes exist in Neo4j with identity `{sha, repo_url}` -- CONFIRMED at line 96
- `runDigest()` calls ingester before the resolve stage -- CONFIRMED at line 262-269

**How Phase 3 slots into `runDigest()`:**
- Currently, after resolve (line 354), the pipeline goes directly to load (line 368)
- Phase 3 must insert `diffGraph()` between resolve and load
- The resolve output is available as `resolveResult` (line 354), `allSymbols`, `allExports`, `allFiles`, `callsEdges`
- Phase 3's `fetchCurrentGraphState(repoUrl)` will query Neo4j for nodes `WHERE valid_to IS NULL` -- the temporal indexes on `(valid_from_ts, valid_to_ts)` are already created (neo4j.ts:48-52)

**Commit node properties available for Phase 3 attribution queries:**
| Property | Type | Available |
|----------|------|-----------|
| `sha` | string | Yes (identity) |
| `repo_url` | string | Yes (identity) |
| `author` | string | Yes |
| `author_email` | string | Yes |
| `timestamp` | datetime | Yes |
| `message` | string | Yes |

Phase 3 does not directly create INTRODUCED_IN edges (that's Phase 4), so no mismatch here.

### Phase 4 (Temporal Loader + Orchestrator) -- READY with one required fix

**What Phase 4 needs from Phase 2:**
1. Commit node exists with `{sha, repo_url}` for INTRODUCED_IN edge targets -- CONFIRMED
2. `CommitMeta` type for setting temporal properties on versioned nodes -- EXPORTED, available
3. HEAD commit metadata (author, timestamp, message) to populate `changed_by`, `valid_from_ts` -- NOT RETURNED (see Mismatch 1)

**INTRODUCED_IN edge creation pattern (from plan):**
```cypher
CREATE (node)-[:INTRODUCED_IN {change_type: $type}]->(commit:Commit {sha: $sha})
```
This will work as-is. The Commit MERGE identity `{sha, repo_url}` matches what Phase 4 will MATCH on. However, the plan uses a CREATE pattern with inline properties `{sha: $sha}` -- this should be a MATCH, not CREATE, since the Commit node already exists from Phase 2's ingestion. The actual Phase 4 Cypher should be:
```cypher
MATCH (commit:Commit {sha: $sha, repo_url: $repoUrl})
CREATE (node)-[:INTRODUCED_IN {change_type: $type}]->(commit)
```
This is a Phase 4 implementation detail, not a Phase 2 issue.

**Required fix before Phase 4:** `ingestCommitHistory` must return the `CommitMeta[]` array so `runDigest()` can pass HEAD commit metadata to the temporal loader.

### Phase 5 (Complexity Metrics + Historical Backfill) -- READY with design note

**What Phase 5 needs from Phase 2:**
1. `ingestCommitHistory()` callable per-commit in a loop -- WORKS. The function accepts `maxCommits` and can be called with `maxCommits=1` per iteration. However, for backfill, the function would re-extract git log on each call, which is wasteful.
2. Commit nodes in Neo4j for each historical commit -- Phase 5 can call `ingestCommitHistory(localPath, repoUrl, repoId, N)` once with all commits, then iterate.

**Design note for Phase 5:** The backfill loop should call `ingestCommitHistory` once at the start with `maxCommits = depth` to create all Commit nodes, then iterate through commits for the scan/parse/resolve/diff/load cycle. This avoids N separate calls.

**`CommitMeta` type reuse:** Phase 5 needs `CommitMeta` to pass to the temporal loader per-commit. The type is exported from `commit-ingester.ts` and matches exactly what's needed.

### Phase 6 (MCP Tools) -- READY

**What Phase 6 needs from Phase 2:**
1. Commit node properties for `get_symbol_history`, `get_structural_blame`, `find_when_introduced`, `find_when_removed` -- all properties are available (`sha`, `author`, `author_email`, `timestamp`, `message`)
2. Supabase `commits` table for `get_complexity_trend` joins -- columns match plan exactly
3. `HAS_COMMIT` edges for repo-scoped commit queries -- CONFIRMED
4. `PARENT_OF` edges for commit range queries in `diff_graph` -- CONFIRMED (with the caveat from Mismatch 4 about shallow clones)

**Commit node query pattern Phase 6 will use:**
```cypher
MATCH (c:Commit {sha: $sha, repo_url: $repo})
```
This matches the MERGE identity key exactly. The composite index `commit_identity` on `(sha, repo_url)` ensures fast lookups.

---

## Summary of Action Items

| # | Item | Severity | When to Fix | Owner |
|---|------|----------|-------------|-------|
| 1 | `ingestCommitHistory` should return `CommitMeta[]` alongside count | MEDIUM | Before Phase 4 starts | Phase 4 builder |
| 2 | Plan Contract 2 signature is out of date (docs only) | LOW | Anytime | Plan maintainer |
| 3 | INTRODUCED_IN Cypher in plan uses CREATE for Commit -- should be MATCH | LOW | Phase 4 implementation | Phase 4 builder |
| 4 | Phase 5 backfill should call ingester once (batch), not per-commit | LOW | Phase 5 design | Phase 5 builder |

**Bottom line:** Phase 2 output is solid. The Commit node schema, Neo4j indexes, Supabase columns, and `CommitMeta` type all align with what Phases 3-6 need. The one required change before Phase 4 is returning commit metadata from `ingestCommitHistory` so the temporal loader can populate `changed_by` and `valid_from_ts` on versioned nodes without an extra Neo4j round-trip.
