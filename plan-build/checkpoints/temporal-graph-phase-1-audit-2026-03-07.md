# Temporal Graph -- Phase 1 Audit: Schema & Infrastructure
**Date:** 2026-03-07
**Auditor:** Claude Opus 4.6
**Build plan:** ../planning/temporal-graph-plan-2026-03-07.md
**Verdict:** PASS with minor findings

---

## Files Audited

| File | Status |
|------|--------|
| `/supabase-temporal-migration.sql` | New -- reviewed in full |
| `/packages/backend/src/db/neo4j.ts` | Modified -- reviewed lines 44-51 (new temporal indexes) |
| `/packages/backend/src/index.ts` | Unchanged -- verified startup chain (line 91) |

---

## Checklist Item Verification

### 1. Supabase `commits` table
**Plan spec:** id, repo_id, sha, author, author_email, timestamp, message, parent_shas text[]
**SQL (lines 8-20):** All columns present and correctly typed.
- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` -- correct
- `repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE` -- correct FK
- `sha TEXT NOT NULL` -- correct
- `author TEXT NOT NULL` -- correct
- `author_email TEXT` -- correct (nullable, plan doesn't mandate NOT NULL)
- `timestamp TIMESTAMPTZ NOT NULL` -- correct
- `message TEXT` -- correct (nullable)
- `parent_shas TEXT[] DEFAULT '{}'` -- correct, matches plan's `text[]`
- `UNIQUE(repo_id, sha)` -- good addition, prevents duplicate commits per repo
- Extra: `created_at TIMESTAMPTZ` -- housekeeping column, harmless

**Downstream match (Contract 3):** `ingestCommitHistory()` will write `{ sha, author, authorEmail, timestamp, message, parentShas }` -- all columns align. The `CommitMeta` type maps cleanly to this table.

**Result:** PASS

### 2. Supabase `complexity_metrics` table
**Plan spec:** id, repo_id, **commit_id**, file_path, metric_name, metric_value, timestamp
**SQL (lines 28-37):** Column is named `commit_sha` (TEXT), not `commit_id` (UUID).

**Finding -- PLAN TYPO, CODE IS CORRECT:** The plan checklist says `commit_id` but all downstream references (Contract 7, Phase 5 complexity.ts spec) pass `commitSha` as a string, not a UUID. The SQL correctly uses `commit_sha TEXT NOT NULL`. Storing the SHA directly avoids an unnecessary join to the `commits` table and works even if the commit row doesn't exist yet. This is the right design.

- `metric_value REAL NOT NULL` -- correct (REAL for decimal metrics like coupling_score)
- Indexes on `(repo_id, file_path)`, `(repo_id, timestamp DESC)`, `(repo_id, metric_name, file_path)` -- good coverage for the `get_complexity_trend` MCP tool query patterns (Contract 9)

**Result:** PASS

### 3. Supabase `temporal_digest_jobs` table
**Plan spec:** id, repo_id, digest_job_id, mode, commits_processed, commits_total, oldest_commit_sha, newest_commit_sha, stats jsonb
**SQL (lines 46-60):** All planned columns present, plus useful additions:
- `status TEXT NOT NULL DEFAULT 'running'` -- needed for job tracking (mirrors `digest_jobs` pattern)
- `started_at TIMESTAMPTZ NOT NULL DEFAULT now()` -- needed
- `completed_at TIMESTAMPTZ` -- needed
- `error_log TEXT` -- needed for failure diagnostics

**FK:** `digest_job_id UUID REFERENCES digest_jobs(id) ON DELETE SET NULL` -- correct. SET NULL is appropriate: temporal job record survives cleanup of parent digest job.

**Downstream match (Phase 5, backfill.ts):** The backfill will update `commits_processed` per commit and set `status` on completion. All needed columns are present.

**Result:** PASS

### 4. Neo4j composite indexes on temporal fields
**Plan spec:** `(valid_from_ts, valid_to_ts)` on Function, Class, TypeDef, Constant, File labels
**Code (neo4j.ts lines 47-51):**
```
CREATE INDEX file_temporal IF NOT EXISTS FOR (f:File) ON (f.valid_from_ts, f.valid_to_ts)
CREATE INDEX function_temporal IF NOT EXISTS FOR (fn:Function) ON (fn.valid_from_ts, fn.valid_to_ts)
CREATE INDEX class_temporal IF NOT EXISTS FOR (c:Class) ON (c.valid_from_ts, c.valid_to_ts)
CREATE INDEX typedef_temporal IF NOT EXISTS FOR (t:TypeDef) ON (t.valid_from_ts, t.valid_to_ts)
CREATE INDEX constant_temporal IF NOT EXISTS FOR (c:Constant) ON (c.valid_to_ts, c.valid_to_ts)
```

Wait -- **FINDING: POSSIBLE TYPO on constant_temporal index.** Let me re-verify...

Actually on re-read of the source, line 51 is:
```
"CREATE INDEX constant_temporal IF NOT EXISTS FOR (c:Constant) ON (c.valid_from_ts, c.valid_to_ts)",
```
This is correct -- `valid_from_ts, valid_to_ts`. All five labels covered. Composite indexes match the plan.

**Downstream match (Contract 8):** MCP temporal queries will use `WHERE valid_from_ts <= $ts AND (valid_to_ts IS NULL OR valid_to_ts > $ts)`. The composite index on `(valid_from_ts, valid_to_ts)` supports this range query efficiently.

**Result:** PASS

### 5. Neo4j Commit node index
**Plan spec:** `(sha, repo_url)` -- implies a composite index
**Code (neo4j.ts lines 45-46):**
```
CREATE INDEX commit_sha IF NOT EXISTS FOR (c:Commit) ON (c.sha)
CREATE INDEX commit_repo IF NOT EXISTS FOR (c:Commit) ON (c.repo_url)
```

**Finding -- MINOR:** Two separate single-property indexes instead of one composite. Downstream usage (Contract 3): `MERGE (c:Commit {sha: $sha, repo_url: $repoUrl})` matches on both properties. Neo4j will use index intersection for this MERGE, which works correctly but is slightly less efficient than a composite index. Not a blocker -- SHAs are already highly selective, so the `commit_sha` index alone will narrow to 1 result in practice.

**Result:** PASS (minor optimization opportunity)

### 6. Neo4j Aura plan capacity
**Plan spec:** Verify ~50K base + ~50K historical = ~100K nodes fits within Aura plan
**Analysis:**
- Neo4j Aura Free tier: 200K nodes, 400K relationships
- Projected: ~100K nodes -- within the 200K limit with 50% headroom
- Total indexes after Phase 1: 14 (7 original + 7 temporal). No hard index count limit on Aura Free.
- **Risk:** Historical backfill (Phase 5) with deep history on large repos could exceed 200K nodes. For a repo with 1000 functions across 100 commits with 50% churn, that's 1000 + (100 * 500) = 51K function versions alone. Add other node types and edges, and a large backfill could approach limits.

**Result:** PASS for MVP scope; monitor during Phase 5 backfill implementation

---

## Execution Chain Verification

### initNeo4jIndexes() -> start() -> server boot
**Traced via:** `packages/backend/src/index.ts:91`
```
async function start() {
  const neo4jOk = await verifyNeo4jConnection();
  if (neo4jOk) {
    console.log("Neo4j: connected");
    await initNeo4jIndexes();    // <-- Line 91: indexes are created at startup
  }
}
```
- `initNeo4jIndexes()` is imported at line 4 and called at line 91
- All 14 indexes (including the 7 new temporal ones) are created in a `for` loop
- `IF NOT EXISTS` on every statement makes this idempotent and safe for restarts
- If Neo4j connection fails, indexes are skipped (graceful degradation)

**Result:** PASS -- startup chain is intact

### Supabase migration execution
- The SQL file is standalone (`supabase-temporal-migration.sql`), intended for manual execution in Supabase SQL Editor
- Header comment says "Run after: supabase-migration.sql" -- correct dependency ordering
- All three `REFERENCES` clauses point to tables from `supabase-migration.sql` (`repositories`, `digest_jobs`)
- `IF NOT EXISTS` on all CREATE TABLE/INDEX statements -- idempotent

**Result:** PASS

---

## Data Flow Verification

### commits table -> downstream writers
| Writer (Phase 2) | Column | Table Column | Match? |
|---|---|---|---|
| `CommitMeta.sha` | sha | `sha TEXT NOT NULL` | Yes |
| `CommitMeta.author` | author | `author TEXT NOT NULL` | Yes |
| `CommitMeta.authorEmail` | authorEmail | `author_email TEXT` | Yes |
| `CommitMeta.timestamp` | timestamp | `timestamp TIMESTAMPTZ NOT NULL` | Yes |
| `CommitMeta.message` | message | `message TEXT` | Yes |
| `CommitMeta.parentShas` | parentShas | `parent_shas TEXT[]` | Yes |

### complexity_metrics table -> downstream writers
| Writer (Phase 5) | Column | Table Column | Match? |
|---|---|---|---|
| `computeComplexityMetrics(repoUrl, commitSha, commitTs)` | commitSha | `commit_sha TEXT NOT NULL` | Yes |
| per-file metrics | file_path | `file_path TEXT NOT NULL` | Yes |
| metric names: import_count, coupling_score, etc. | metric_name | `metric_name TEXT NOT NULL` | Yes |
| metric values | metric_value | `metric_value REAL NOT NULL` | Yes |
| commitTs | timestamp | `timestamp TIMESTAMPTZ NOT NULL` | Yes |

### Neo4j temporal fields -> downstream readers
| MCP Query Pattern (Contract 8) | Index Fields | Match? |
|---|---|---|
| `WHERE valid_from_ts <= $ts AND (valid_to_ts IS NULL OR valid_to_ts > $ts)` | `(valid_from_ts, valid_to_ts)` | Yes |
| `WHERE valid_to IS NULL` (current state) | Not directly indexed (valid_to vs valid_to_ts) | See finding below |

**Finding -- MINOR GAP:** Several queries in the plan use `WHERE valid_to IS NULL` (the SHA field) rather than `WHERE valid_to_ts IS NULL` (the timestamp field). The indexes are on `(valid_from_ts, valid_to_ts)` -- the timestamp variants. Queries filtering on `valid_to IS NULL` (the SHA string) won't use these indexes. This is acceptable because:
1. The `valid_to IS NULL` filter is for "current state" queries which should return most nodes (low selectivity = full scan is fine)
2. The temporal range queries (the selective ones) correctly use the indexed `_ts` fields
3. Adding a separate index on `valid_to` would add index maintenance cost for marginal benefit

**Result:** PASS (noted for awareness)

---

## Summary of Findings

| # | Severity | Finding | Action Needed |
|---|----------|---------|---------------|
| 1 | Info | Plan checklist says `commit_id` for complexity_metrics but SQL correctly uses `commit_sha` | Update plan text (optional) |
| 2 | Info | Commit indexes are two separate single-property indexes instead of one composite | No action -- SHA alone is selective enough |
| 3 | Info | `valid_to IS NULL` queries won't hit the `_ts` composite indexes | No action -- low selectivity filter, full scan is acceptable |
| 4 | Warning | Deep historical backfill on large repos could approach Aura Free tier 200K node limit | Monitor during Phase 5; document limit in backfill options |
| 5 | Info | `temporal_digest_jobs` has useful extra columns (`status`, `started_at`, `completed_at`, `error_log`) not in plan checklist | No action -- good additions |

**No blocking issues found. Phase 1 is ready for Phase 2 to build on.**
