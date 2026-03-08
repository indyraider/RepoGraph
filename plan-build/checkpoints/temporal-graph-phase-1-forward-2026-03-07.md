# Temporal Graph -- Phase 1 Forward Planning Checkpoint
**Date:** 2026-03-07
**Phase completed:** Phase 1 -- Schema & Infrastructure
**Remaining phases:** 2 (Clone + Commit Ingestion), 3 (Diff Engine), 4 (Temporal Loader + Orchestrator), 5 (Complexity Metrics + Historical Backfill), 6 (MCP Tools)

---

## 1. What Was Actually Built

### 1A. Supabase Tables (`supabase-temporal-migration.sql`)

**`commits` table:**
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK, default `gen_random_uuid()` |
| repo_id | UUID | NOT NULL, FK -> `repositories(id)` ON DELETE CASCADE |
| sha | TEXT | NOT NULL |
| author | TEXT | NOT NULL |
| author_email | TEXT | nullable |
| timestamp | TIMESTAMPTZ | NOT NULL |
| message | TEXT | nullable |
| parent_shas | TEXT[] | DEFAULT '{}' |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |
| **UNIQUE** | | `(repo_id, sha)` |

Indexes: `idx_commits_repo (repo_id)`, `idx_commits_repo_ts (repo_id, timestamp DESC)`

**`complexity_metrics` table:**
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK, default `gen_random_uuid()` |
| repo_id | UUID | NOT NULL, FK -> `repositories(id)` ON DELETE CASCADE |
| commit_sha | TEXT | NOT NULL |
| file_path | TEXT | NOT NULL |
| metric_name | TEXT | NOT NULL |
| metric_value | REAL | NOT NULL |
| timestamp | TIMESTAMPTZ | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |

Indexes: `idx_complexity_repo_file (repo_id, file_path)`, `idx_complexity_repo_ts (repo_id, timestamp DESC)`, `idx_complexity_repo_metric (repo_id, metric_name, file_path)`

**`temporal_digest_jobs` table:**
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK, default `gen_random_uuid()` |
| repo_id | UUID | NOT NULL, FK -> `repositories(id)` ON DELETE CASCADE |
| digest_job_id | UUID | FK -> `digest_jobs(id)` ON DELETE SET NULL |
| mode | TEXT | NOT NULL, DEFAULT 'snapshot' |
| commits_processed | INTEGER | NOT NULL, DEFAULT 0 |
| commits_total | INTEGER | NOT NULL, DEFAULT 0 |
| oldest_commit_sha | TEXT | nullable |
| newest_commit_sha | TEXT | nullable |
| stats | JSONB | DEFAULT '{}' |
| status | TEXT | NOT NULL, DEFAULT 'running' |
| started_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |
| completed_at | TIMESTAMPTZ | nullable |
| error_log | TEXT | nullable |

Indexes: `idx_temporal_jobs_repo (repo_id)`

RLS: Disabled on all three tables (matches existing pattern).

### 1B. Neo4j Indexes (added to `initNeo4jIndexes()` in `neo4j.ts`)

New indexes added (lines 45-51):
```
CREATE INDEX commit_sha     IF NOT EXISTS FOR (c:Commit)   ON (c.sha)
CREATE INDEX commit_repo    IF NOT EXISTS FOR (c:Commit)   ON (c.repo_url)
CREATE INDEX file_temporal  IF NOT EXISTS FOR (f:File)     ON (f.valid_from_ts, f.valid_to_ts)
CREATE INDEX function_temporal IF NOT EXISTS FOR (fn:Function) ON (fn.valid_from_ts, fn.valid_to_ts)
CREATE INDEX class_temporal IF NOT EXISTS FOR (c:Class)    ON (c.valid_from_ts, c.valid_to_ts)
CREATE INDEX typedef_temporal IF NOT EXISTS FOR (t:TypeDef) ON (t.valid_from_ts, t.valid_to_ts)
CREATE INDEX constant_temporal IF NOT EXISTS FOR (c:Constant) ON (c.valid_from_ts, c.valid_to_ts)
```

### 1C. Existing Loader Identity Keys (via RepoGraph, `loader.ts`)

These are the MERGE identity keys downstream phases must match against:
- **File:** `{path, repo_url}`
- **Function:** `{name, file_path, repo_url}`
- **Class:** `{name, file_path, repo_url}`
- **TypeDef:** `{name, file_path, repo_url}`
- **Constant:** `{name, file_path, repo_url}`
- **Package:** `{name}`
- **IMPORTS edge (internal):** `(from:File)-[:IMPORTS]->(to:File)` matched by `{path, repo_url}` on each end
- **CALLS edge:** `(caller)-[:CALLS]->(callee)` matched by `{name, file_path, repo_url}` on each end

---

## 2. Mismatch Analysis by Phase

### Phase 2: Commit Ingester -- STATUS: READY (no mismatches)

**What Phase 2 needs to write:**
- Commit nodes in Neo4j with `MERGE (c:Commit {sha: $sha, repo_url: $repoUrl})`
- Rows to Supabase `commits` table: `{ repo_id, sha, author, author_email, timestamp, message, parent_shas }`

**Against what was built:**
- Neo4j Commit indexes: `commit_sha` on `(c.sha)` and `commit_repo` on `(c.repo_url)`. These are **two separate single-property indexes**, not a composite index. Phase 2's MERGE key is `{sha, repo_url}` -- Neo4j will use both indexes via index intersection. This works but is suboptimal.
- Supabase `commits` table: Schema matches exactly. All columns the ingester needs exist. The `UNIQUE(repo_id, sha)` constraint enables upsert with `ON CONFLICT`.
- FK dependency: Phase 2 must have the `repo_id` UUID from the `repositories` table before inserting commits. This is already available in the current digest flow (`DigestRequest.repoId` or looked up after clone).

**Recommendation (minor optimization, not blocking):**
- Consider adding a composite index `CREATE INDEX commit_identity IF NOT EXISTS FOR (c:Commit) ON (c.sha, c.repo_url)` for direct MERGE performance. The two separate indexes work but a composite is more efficient for the dual-property MERGE pattern. This can be added in Phase 2 without schema change.

### Phase 3: Diff Engine -- STATUS: READY (no mismatches)

**What Phase 3 needs to read:**
- Previous graph state from Neo4j: all nodes/edges `WHERE valid_to IS NULL` (or `NOT EXISTS(node.valid_to)` for first temporal run)
- Node identity keys for diffing: `{name, file_path, repo_url}` for symbols, `{path, repo_url}` for files

**Against what was built:**
- Temporal indexes on `(valid_from_ts, valid_to_ts)` support the `WHERE valid_to_ts IS NULL` filter needed by Phase 3.
- The identity keys are well-documented in the existing loader (see 1C above) and the diff engine can reuse them directly.
- No schema dependency on Supabase tables.

**Note:** The diff engine will query `WHERE node.valid_to IS NULL OR NOT EXISTS(node.valid_to)`. The temporal index on `valid_to_ts` (not `valid_to`) means the diff engine should filter on `valid_to_ts IS NULL` specifically, not `valid_to IS NULL`. Phase 3 must use the `_ts` (timestamp) variant for index-assisted queries.

### Phase 4: Temporal Loader -- STATUS: READY (property names match)

**What Phase 4 needs to SET:**
- Per plan Contract 6: `valid_from`, `valid_from_ts`, `valid_to`, `valid_to_ts`, `change_type`, `changed_by`, `commit_message`
- Create `INTRODUCED_IN` edges to Commit nodes

**Against what was built:**
- Neo4j temporal indexes are on `(valid_from_ts, valid_to_ts)` -- the `_ts` suffix properties. These are the timestamp versions.
- The plan also references `valid_from` and `valid_to` (SHA-based, string). These are **not indexed** but that's correct -- they're used for display/attribution, not range queries. Timestamp fields are the query workhorses.
- Commit nodes are indexed on `sha` and `repo_url`, which matches the INTRODUCED_IN edge target lookup pattern.

**No mismatches.** Property naming is consistent between indexes and planned SET operations.

### Phase 5: Complexity Metrics -- STATUS: READY (minor note)

**What Phase 5 needs to write:**
- Rows to `complexity_metrics`: `{ repo_id, commit_sha, file_path, metric_name, metric_value, timestamp }`
- Rows to `temporal_digest_jobs`: `{ repo_id, digest_job_id, mode, commits_processed, commits_total, ... }`

**Against what was built:**
- `complexity_metrics` schema matches exactly. All required columns present with correct types.
- `temporal_digest_jobs` schema matches. The `mode` column accepts 'snapshot', 'historical', 'incremental' as TEXT (no enum constraint, just convention).
- The `complexity_metrics` table uses `commit_sha` (TEXT) rather than a FK to `commits(id)`. This is a deliberate denormalization -- it avoids insert-order dependencies (metrics can be computed before or after commit rows are inserted) and simplifies queries. Acceptable tradeoff.

**Note:** The `complexity_metrics` table has no UNIQUE constraint. If the same metric is computed twice for the same `(repo_id, commit_sha, file_path, metric_name)`, it will create duplicate rows. Phase 5 should either:
- Add an upsert strategy with a unique constraint, OR
- Guard against re-computation in application code (check if metrics exist for this commit before computing)

### Phase 6: MCP Tools -- STATUS: READY (indexes sufficient)

**What Phase 6 needs to query:**

1. `get_symbol_history`: MATCH nodes by `{name, repo_url}` across all temporal versions, ORDER BY `valid_from_ts DESC`. Needs temporal indexes -- PRESENT.
2. `diff_graph`: MATCH `INTRODUCED_IN` edges to Commit nodes in a range. Needs Commit index on `sha` -- PRESENT.
3. `get_structural_blame`: MATCH earliest `INTRODUCED_IN` for a symbol. Same index needs as #2.
4. `get_complexity_trend`: Supabase query on `complexity_metrics` filtered by `(repo_id, file_path, metric_name)` with timestamp ordering. Index `idx_complexity_repo_metric` covers `(repo_id, metric_name, file_path)` -- PRESENT. Index `idx_complexity_repo_ts` covers `(repo_id, timestamp DESC)` -- PRESENT.
5. `find_when_introduced`/`find_when_removed`: Same pattern as #1, filtering by `change_type`.
6. Existing tools with `at_commit`: Need temporal range filter `WHERE valid_from_ts <= $ts AND (valid_to_ts IS NULL OR valid_to_ts > $ts)`. Composite temporal indexes on `(valid_from_ts, valid_to_ts)` support this -- PRESENT.

**All query patterns are covered by the built indexes.**

---

## 3. Issues Found

### ISSUE 1: No Composite Commit Identity Index (Severity: Low)

Phase 2 will MERGE Commit nodes on `{sha, repo_url}`. The current indexes are two separate single-property indexes (`commit_sha` on `sha`, `commit_repo` on `repo_url`). Neo4j can use index intersection, but a composite index `ON (c.sha, c.repo_url)` would be more efficient for the MERGE pattern.

**Action:** Add composite index in Phase 2, or amend Phase 1. Not blocking.

### ISSUE 2: No UNIQUE Constraint on complexity_metrics (Severity: Low)

The `complexity_metrics` table has no unique constraint to prevent duplicate rows for the same `(repo_id, commit_sha, file_path, metric_name)` combination. If Phase 5's `computeComplexityMetrics` runs twice for the same commit (e.g., retry after partial failure), duplicates will be inserted.

**Action:** Phase 5 should add a UNIQUE constraint:
```sql
ALTER TABLE complexity_metrics ADD CONSTRAINT uq_complexity_metric
  UNIQUE (repo_id, commit_sha, file_path, metric_name);
```
Or handle idempotency in application code. Not blocking for Phase 2-4.

### ISSUE 3: No INTRODUCED_IN Edge Index (Severity: Low)

Phase 6's `diff_graph` and `get_structural_blame` tools query `INTRODUCED_IN` edges heavily. There is no relationship index defined for `INTRODUCED_IN`. In Neo4j 5.x, relationship type indexes are supported and would speed up these queries.

**Action:** Consider adding in Phase 4 or 6:
```
CREATE INDEX introduced_in_change IF NOT EXISTS FOR ()-[r:INTRODUCED_IN]-() ON (r.change_type)
```
Not blocking -- Neo4j will scan relationship types without an index but may be slow on large temporal graphs.

### ISSUE 4: Missing HAS_COMMIT / PARENT_OF Relationship Consideration (Severity: Info)

Phase 2 will create `HAS_COMMIT` edges `(Repository)-[:HAS_COMMIT]->(Commit)` and `PARENT_OF` edges `(Commit)-[:PARENT_OF]->(Commit)`. No indexes were created for these relationships. This is fine since they'll be traversed from already-indexed endpoints, but worth noting for completeness.

---

## 4. Dependency Readiness for Phase 2

Phase 2 (Clone + Commit Ingestion) can proceed. Here is exactly what it can rely on:

### Supabase Tables Available
- `commits` table: insert with `{ repo_id, sha, author, author_email, timestamp, message, parent_shas }`. Upsert on `(repo_id, sha)`.
- `repositories` table (pre-existing): provides `repo_id` UUID via `url` lookup.

### Neo4j Indexes Available
- `commit_sha`: index on `(Commit.sha)` -- supports MERGE lookups
- `commit_repo`: index on `(Commit.repo_url)` -- supports repo-scoped queries
- `repo_url` constraint on Repository -- supports MATCH for HAS_COMMIT source

### Insert Order Constraints
1. `repositories` row must exist before `commits` insert (FK constraint)
2. Commit nodes should be created before PARENT_OF edges (both endpoints must exist)
3. No dependency on temporal indexes -- those are consumed by later phases

### Identity Keys for Commit Nodes
Phase 2 should MERGE on: `MERGE (c:Commit {sha: $sha, repo_url: $repoUrl})`
This matches the indexed properties.

---

## 5. Summary Verdict

**Phase 1 is complete and correctly aligned with all downstream phases.** No blocking mismatches were found. Three low-severity optimizations were identified (composite Commit index, complexity_metrics UNIQUE constraint, INTRODUCED_IN relationship index) that can be addressed in their respective phases without requiring Phase 1 rework.

Phase 2 is cleared to proceed with the schemas and indexes as built.
