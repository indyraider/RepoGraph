# Forward Checkpoint: Runtime Context Layer — Phase 3

**Phase completed:** Phase 3 (Log Collector + Retention)
**Remaining phases:** Phase 4 (Backend API Routes), Phase 5 (MCP Runtime Tools), Phase 6 (Frontend UI)
**Date:** 2026-03-06

---

## 1. Extracted Interfaces from Phase 3

### collector.ts exports

```typescript
export function startCollector(): void
export function stopCollector(): void
```

Internal (not exported):
- `pollCycle(): Promise<void>` — finds enabled, due sources; calls `processSource()` per source
- `processSource(source: Record<string, unknown>): Promise<void>` — decrypt, adapt, parse, insert
- `updateSourceError(sourceId: string, error: string): Promise<void>`

### retention.ts exports

```typescript
export function startRetention(): void
export function stopRetention(): void
```

Internal:
- `pruneOldLogs(): Promise<void>` — deletes runtime_logs where `timestamp < NOW() - 30 days`

### Data shapes written by collector

**runtime_logs insert rows:**
```typescript
{
  repo_id: string,          // from log_sources row
  source: string,           // from NormalizedLogEntry.source
  level: string,            // "info" | "warn" | "error"
  message: string,
  timestamp: Date,          // NormalizedLogEntry.timestamp (Date object)
  deployment_id: string | null,
  function_name: string | null,
  file_path: string | null,
  line_number: number | null,
  stack_trace: string | null,
  metadata: Record<string, unknown> | {},
}
```

**deployments upsert rows:**
```typescript
{
  repo_id: string,
  source: string,
  deployment_id: string,    // platform-native ID
  status: string,
  branch: string | null,
  commit_sha: string | null,
  started_at: Date,
  completed_at: Date | null,
  url: string | null,
}
// Upsert on conflict: (repo_id, deployment_id, source)
```

**log_sources updates on success:**
```typescript
{ last_poll_at: string (ISO), last_error: null }
```

**log_sources updates on failure:**
```typescript
{ last_error: string }
```

---

## 2. Mismatch Detection vs Remaining Phases

### Phase 4: Backend API Routes (routes.ts)

**Encryption pattern — MATCH**
- Plan says routes will call `encrypt(api_token)` and store in `log_sources.config.encrypted_api_token`.
- Collector reads `config.encrypted_api_token` and calls `safeDecrypt()` from `lib/crypto.ts`.
- `crypto.ts` exports both `encrypt()` and `safeDecrypt()` / `decrypt()`.
- The encrypt/decrypt pair uses the same AES-256-GCM scheme with `config.sessionSecret` as key material.
- **No mismatch.** Routes can import `encrypt` from `../lib/crypto.js` and the collector's `safeDecrypt` will correctly reverse it.

**Adapter registry for test connection — MATCH**
- Plan says routes will call `getAdapter(platform)` for test-connection endpoint and to validate platform strings.
- Registry exports `getAdapter(platform): LogAdapter | undefined` and `getRegisteredPlatforms(): Array<{platform, displayName}>`.
- `LogAdapter` interface includes `testConnection(config: AdapterConfig): Promise<ConnectionResult>`.
- **No mismatch.** Routes have everything needed.

**Token storage location — MATCH**
- Plan says encrypted token stored at `log_sources.config.encrypted_api_token`.
- Collector destructures `const { encrypted_api_token: _, ...platformConfig } = config` — reads from exactly that path.
- **No mismatch.**

### Phase 5: MCP Runtime Tools

**runtime_logs column names — MATCH**
- Collector inserts: `repo_id`, `source`, `level`, `message`, `timestamp`, `deployment_id`, `function_name`, `file_path`, `line_number`, `stack_trace`, `metadata`.
- DB schema columns match exactly (verified against migration SQL).
- MCP tools will query these columns. All names are snake_case and match the schema.
- **No mismatch.**

**deployments column names — MATCH**
- Collector upserts: `repo_id`, `source`, `deployment_id`, `status`, `branch`, `commit_sha`, `started_at`, `completed_at`, `url`.
- DB schema has all these columns plus auto-generated `id` and `created_at`.
- **No mismatch.**

**trace_error tool dependencies — MATCH**
- Plan says trace_error fetches a `runtime_logs` entry by ID, reads `stack_trace`, `file_path`, `line_number`.
- Collector populates all three:
  - `stack_trace`: from `NormalizedLogEntry.stackTrace` or extracted from message
  - `file_path`: from stack parser's first frame (`ParsedFrame.filePath`)
  - `line_number`: from stack parser's first frame (`ParsedFrame.lineNumber`)
- **No mismatch.**

**get_deploy_errors query pattern — MATCH**
- Plan says it joins `runtime_logs` and `deployments` via `deployment_id`.
- Collector sets `runtime_logs.deployment_id` from `NormalizedLogEntry.deploymentId`.
- Collector sets `deployments.deployment_id` from `NormalizedDeployment.deploymentId`.
- Both are TEXT columns containing the platform-native deployment ID.
- **No mismatch.** The join `runtime_logs.deployment_id = deployments.deployment_id` will work.
- **Note:** The join also needs `runtime_logs.source = deployments.source` to be safe (same deployment_id could theoretically exist on two platforms). The plan's Cypher/SQL doesn't explicitly show this, but the `repo_id` filter will effectively scope it. Low risk.

**search_logs full-text search — MATCH**
- Migration creates GIN index: `to_tsvector('english', message)`.
- MCP tool will need to use `to_tsquery()` or Supabase's `.textSearch()` method.
- Collector stores the full `message` text. **No mismatch.**

**get_recent_logs filtering — MATCH**
- Tool will filter by `source`, `level`, `repo_id`, ordered by `timestamp DESC`.
- All indexes exist: `idx_runtime_logs_repo_timestamp`, `idx_runtime_logs_level_timestamp`, `idx_runtime_logs_source_timestamp`.
- **No mismatch.**

### Phase 6: Frontend UI

**Status indicators — MATCH**
- Plan says frontend shows Active/Error/Disabled + `last_poll_at` + `last_error`.
- Collector writes both `last_poll_at` and `last_error` to `log_sources`.
- GET endpoint (Phase 4) will return these fields.
- **No mismatch.**

---

## 3. Potential Issues (non-blocking but noteworthy)

### Issue 1: `timestamp` column type vs JavaScript Date

- `NormalizedLogEntry.timestamp` is typed as `Date` in `types.ts`.
- Collector passes it directly: `timestamp: e.timestamp`.
- Supabase JS client serializes `Date` objects to ISO strings for `TIMESTAMPTZ` columns, so this works.
- **Verdict: OK.** No action needed.

### Issue 2: Stack trace on non-error entries

- Collector only runs `parseStackTrace()` on entries where `entry.level === "error"` AND `!entry.filePath`.
- If a `warn`-level entry contains a stack trace, `file_path` and `line_number` will remain null.
- The plan says `trace_error` uses these fields. Since it only cares about errors, this is fine.
- **Verdict: Acceptable.** Warn-level entries don't need stack parsing for v1.

### Issue 3: `metadata` column — empty object vs null

- Collector defaults to `e.metadata || {}` — always inserts an object, never null.
- DB default is `'{}'::jsonb`. Consistent.
- **Verdict: OK.** MCP tools can always expect a JSONB object, never null.

### Issue 4: No `repo_id` on `runtime_logs` auto-generated UUID

- `runtime_logs.id` is auto-generated UUID. The `trace_error` tool fetches by `id`.
- Collector does not return the inserted IDs. This is fine — `trace_error` receives a `log_id` parameter from the user (who got it from `get_recent_logs` or `get_deploy_errors` results).
- **Verdict: OK.** The flow works: query tool returns `id`, user passes to `trace_error`.

---

## 4. Dependency Readiness for Phase 4

### Functions Phase 4 needs from earlier phases

| Function | Source File | Export Status | Notes |
|---|---|---|---|
| `encrypt(text)` | `lib/crypto.ts` | Exported | For encrypting API tokens before storage |
| `decrypt(encoded)` | `lib/crypto.ts` | Exported | For test-connection (decrypt stored token) |
| `safeDecrypt(encoded)` | `lib/crypto.ts` | Exported | Alternative — returns null on failure |
| `maskValue(value)` | `lib/crypto.ts` | Exported | For masking tokens in GET responses |
| `getAdapter(platform)` | `runtime/adapters/registry.ts` | Exported | For test-connection and platform validation |
| `getRegisteredPlatforms()` | `runtime/adapters/registry.ts` | Exported | For platform dropdown / validation |
| `getSupabase()` | `db/supabase.ts` | Exported (existing) | For all DB operations |
| `AdapterConfig` type | `runtime/adapters/types.ts` | Exported | For building config in test-connection |
| `ConnectionResult` type | `runtime/adapters/types.ts` | Exported | Return type of `testConnection()` |

**All dependencies are exported and ready.** Phase 4 can proceed without any changes to Phase 1-3 code.

### Integration point in index.ts for Phase 4

- Phase 4 must mount routes: `app.use("/api/log-sources", logSourceRoutes)`.
- This must go after the auth middleware (line 36-70) and alongside existing route mounts (lines 73-74).
- The auth middleware already covers `/api/*` paths, so `/api/log-sources/*` will be protected.
- **Ready.** No modifications to auth needed.

---

## 5. Summary

**Phase 3 is clean.** All exported interfaces match what Phases 4-6 expect:

- Collector's decrypt pattern (`safeDecrypt` on `config.encrypted_api_token`) matches what routes will write (`encrypt` into `config.encrypted_api_token`).
- All DB column names in `runtime_logs` and `deployments` match the migration schema and what MCP tools will query.
- `stack_trace`, `file_path`, `line_number` are all populated by the collector for error-level entries, ready for `trace_error`.
- `startCollector`, `stopCollector`, `startRetention`, `stopRetention` are wired into `index.ts` startup and SIGINT handler.
- All functions Phase 4 needs (`encrypt`, `getAdapter`, `getRegisteredPlatforms`, `maskValue`, types) are exported and available.

**No mismatches found. No blockers for Phase 4.**
