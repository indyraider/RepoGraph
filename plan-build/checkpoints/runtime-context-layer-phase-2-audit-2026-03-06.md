# Phase 2 Audit: Adapters + Registry
**Date:** 2026-03-06
**Phase:** Phase 2 — Adapters + Registry
**Status:** PASS with findings

---

## Files Audited

| File | Lines |
|---|---|
| `packages/backend/src/runtime/adapters/types.ts` | 63 |
| `packages/backend/src/runtime/adapters/vercel.ts` | 234 |
| `packages/backend/src/runtime/adapters/railway.ts` | 291 |
| `packages/backend/src/runtime/adapters/registry.ts` | 30 |

---

## Wiring Checklist Verification

| Checklist Item | Status | Notes |
|---|---|---|
| Create Vercel adapter at `packages/backend/src/runtime/adapters/vercel.ts` | PASS | Exported as `vercelAdapter` object literal implementing `LogAdapter` |
| Implement Vercel `testConnection()` -> GET /v6/deployments?limit=1 | PASS | Calls `/v6/deployments?projectId=X&limit=1`, validates projectId, returns `ConnectionResult` |
| Implement Vercel `fetchSince()` -> list deployments + fetch logs per deployment | PASS | Lists deployments via `/v6/deployments`, then fetches `/v1/projects/.../runtime-logs` per deployment |
| Implement Vercel `fetchDeployments()` -> list recent deployments with status | PASS | Lists via `/v6/deployments?limit=20`, maps state to normalized status |
| Create Railway adapter at `packages/backend/src/runtime/adapters/railway.ts` | PASS | Exported as `railwayAdapter` object literal implementing `LogAdapter` |
| Implement Railway `testConnection()` -> `query { me { name } }` | PASS | Executes `query { me { name } }` auth check via `railwayGql` |
| Implement Railway `fetchSince()` -> list deployments + fetch logs per deployment | PASS | Lists via `deployments` query, fetches `deploymentLogs` per deployment |
| Implement Railway `fetchDeployments()` -> list recent deployments with status | PASS | Lists deployments with meta, maps status, filters by `since` |
| Both adapters: implement exponential backoff on 429 responses | PASS | Both use `Math.min(1000 * Math.pow(2, attempt), 30000)` with MAX_RETRIES=3 |
| Both adapters: normalize log levels to info/warn/error | PASS | Vercel: `normalizeLevel()` maps stderr/error/fatal->error, warning->warn, default->info. Railway: `normalizeSeverity()` maps error/err->error, warn/warning->warn, default->info |
| Create adapter registry at `packages/backend/src/runtime/adapters/registry.ts` | PASS | `Map<string, LogAdapter>` with `getAdapter()` and `getRegisteredPlatforms()` |
| Register vercel + railway adapters in registry | PASS | Both set in Map at module level |

---

## Execution Chain Analysis

### Interface Compliance

Both `vercelAdapter` and `railwayAdapter` correctly implement `LogAdapter`:
- `platform: string` — "vercel" / "railway"
- `displayName: string` — "Vercel" / "Railway"
- `testConnection(config: AdapterConfig): Promise<ConnectionResult>` — present
- `fetchSince(config: AdapterConfig, since: Date): Promise<NormalizedLogEntry[]>` — present
- `fetchDeployments(config: AdapterConfig, since: Date): Promise<NormalizedDeployment[]>` — present (non-optional implementations of the optional interface method; this is valid TypeScript)

### testConnection

- **Vercel:** Makes a real API call to `/v6/deployments?projectId=X&limit=1`. Validates `project_id` is present before calling. Returns `ConnectionResult` with `meta.latestLogTimestamp` from the first deployment's `created` field. Handles non-ok responses and network errors.
- **Railway:** Makes a real API call `query { me { name } }`. Checks for GraphQL `errors` array. Returns `ConnectionResult` with `meta` containing `undefined` values (not populated — see Finding #3).

### fetchSince

- **Vercel:** Lists deployments since cursor via `/v6/deployments?since=T&limit=10`, then iterates each deployment fetching runtime logs at `/v1/projects/{projectId}/deployments/{uid}/runtime-logs`. Parses newline-delimited JSON. Filters entries by `timestamp > since`.
- **Railway:** Lists deployments via GraphQL `deployments` query (`first: 10`), then iterates each fetching `deploymentLogs` with `startDate: since.toISOString()` and `limit: 500`. Filters entries by `timestamp > since`.

### fetchDeployments

- **Vercel:** Lists via `/v6/deployments?since=T&limit=20`, maps Vercel state names to normalized status strings, extracts branch/commitSha from `meta` object.
- **Railway:** Lists via GraphQL `deployments` query (`first: 20`), maps Railway status names, extracts branch/commitHash from `meta` object. Filters by `startedAt >= since`.

### Exponential Backoff

Both adapters implement identical backoff logic:
- Loop from `attempt = 0` to `attempt <= MAX_RETRIES` (so 4 total attempts: 0, 1, 2, 3)
- On 429: sleep `min(1000 * 2^attempt, 30000)` ms — i.e., 1s, 2s, 4s
- After exhausting retries: Vercel returns the last 429 response (caller must check `res.ok`); Railway throws an explicit error

---

## Data Flow Analysis

### NormalizedLogEntry Field Mapping

| NormalizedLogEntry field | Vercel source | Railway source |
|---|---|---|
| `source` | `"vercel"` (hardcoded) | `"railway"` (hardcoded) |
| `level` | `normalizeLevel(log.level \|\| log.type \|\| "info")` | `normalizeSeverity(log.severity)` |
| `message` | `log.message \|\| log.text \|\| ""` | `log.message` |
| `timestamp` | `new Date(log.timestampInMs \|\| log.created \|\| Date.now())` | `new Date(log.timestamp)` |
| `deploymentId` | `deploy.uid` | `deploy.id` |
| `functionName` | `log.source \|\| undefined` | not set |
| `filePath` | not set | not set |
| `lineNumber` | not set | not set |
| `stackTrace` | not set | not set |
| `metadata` | `{ requestPath, requestMethod, statusCode, domain, rowId }` | `{ serviceName, environmentId }` |

Both match the `NormalizedLogEntry` interface shape. `filePath`, `lineNumber`, `stackTrace` are optional and will be populated by the Phase 3 stack parser.

### NormalizedDeployment Field Mapping

| NormalizedDeployment field | Vercel source | Railway source |
|---|---|---|
| `source` | `"vercel"` | `"railway"` |
| `deploymentId` | `d.uid` | `d.id` |
| `status` | `mapDeploymentStatus(d.state \|\| d.readyState)` | `mapDeploymentStatus(d.status)` |
| `branch` | `d.meta.githubCommitRef` | `d.meta?.branch` |
| `commitSha` | `d.meta.githubCommitSha` | `d.meta?.commitHash` |
| `startedAt` | `new Date(d.created \|\| d.createdAt)` | `new Date(d.createdAt)` |
| `completedAt` | `d.ready ? new Date(d.ready) : undefined` | `d.updatedAt ? new Date(d.updatedAt) : undefined` |
| `url` | `d.url ? "https://${d.url}" : undefined` | `d.staticUrl \|\| undefined` |

Both match the `NormalizedDeployment` interface shape.

---

## Error Path Analysis

### Single deployment log failure
- **Vercel (line 192):** `catch { continue; }` — skips the deployment, continues to next. Correct.
- **Railway (line 212):** `catch { continue; }` — same pattern. Correct.
- **Railway (line 194):** `if (logsResult.errors?.length) continue;` — also skips on GraphQL errors. Correct.

### API returns 401
- **Vercel:** `vercelFetch` returns the Response object. In `testConnection`, handled via `if (!res.ok)` returning `{ ok: false, error }`. In `fetchSince`/`fetchDeployments`, throws `new Error("Vercel deployments API ${status}")`. Collector (Phase 3) is expected to catch this.
- **Railway:** `railwayGql` throws `new Error("Railway API ${status}: ${body}")` for all non-ok non-429 responses. In `testConnection`, this is caught and returned as `{ ok: false, error }`. In `fetchSince`/`fetchDeployments`, the throw propagates to the collector.

### API returns malformed JSON
- **Vercel fetchSince:** Runtime logs are parsed line by line with individual `try { JSON.parse } catch { return null }` and filtered via `.filter(Boolean)`. Malformed lines are silently skipped. Correct.
- **Vercel testConnection/fetchDeployments:** `res.json()` is called directly. If the JSON is malformed, this will throw. In `testConnection` it's caught; in `fetchDeployments` it propagates (collector must catch).
- **Railway:** `res.json()` is called in `railwayGql`. Malformed JSON throws, which propagates. In `testConnection` it's caught; in `fetchSince`/`fetchDeployments` it propagates.

---

## Findings

### Finding 1: Railway API URL mismatch with plan [MEDIUM]

- **Plan says (Contract 4):** `POST https://backboard.railway.app/graphql/v2`
- **Code says (line 18):** `const RAILWAY_API = "https://backboard.railway.com/graphql/v2";`
- The domain is `.com` in code vs `.app` in plan. Railway's actual production API endpoint is `https://backboard.railway.com/graphql/v2` (the `.app` domain was the older endpoint). The code appears correct, but this should be verified against current Railway docs.
- **Action:** Verify the correct Railway API domain. If `.com` is correct, update the plan. If `.app` is correct, fix the code.

### Finding 2: Vercel backoff returns last 429 response instead of throwing [LOW]

- **Vercel `vercelFetch` (lines 41-42):** After exhausting retries, returns `lastResponse!` (the 429 response) rather than throwing.
- **Railway `railwayGql` (line 57):** After exhausting retries, throws an explicit error.
- **Impact:** In Vercel's case, callers must check `res.ok` / `res.status` themselves. In `fetchSince` (line 136-137) and `fetchDeployments` (line 216-217), the code does check `if (!res.ok)` and throws. In `testConnection` (line 96), it also checks. So this is functionally correct, but the inconsistency with Railway's approach means different error messages surface: Vercel says `"Vercel deployments API 429"` while Railway says `"Railway API rate limited after 3 retries (429)"`. The Railway message is more informative.
- **Action:** Consider making `vercelFetch` throw after exhausting retries, matching Railway's pattern. Not a bug, but an inconsistency.

### Finding 3: Railway testConnection returns empty meta [LOW]

- **Code (lines 107-110):** Returns `meta: { latestLogTimestamp: undefined, entryCount: undefined }`.
- **Vercel testConnection (lines 104-111):** Returns populated `meta` with actual deployment data.
- **Impact:** Phase 6 frontend displaying connection test results will show empty meta for Railway. The `testConnection` for Railway only validates auth (via `me { name }`) but doesn't fetch any deployment/log data to populate meta.
- **Action:** Consider querying for a deployment count or latest deployment timestamp in Railway's `testConnection` to provide parity with Vercel. Or document that Railway test returns auth-only validation.

### Finding 4: Vercel metadata does not match plan spec [LOW]

- **Plan says (Contract 4):** Vercel metadata should be `{ region, duration_ms }`.
- **Code (lines 183-189):** Metadata is `{ requestPath, requestMethod, statusCode, domain, rowId }`.
- **Impact:** The code's metadata is arguably more useful for the runtime logs use case (request context vs. execution region). However, it diverges from the plan spec. The plan spec appears to have been based on the older `/v2/deployments/{id}/events` endpoint, while the code uses the newer `/v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs` endpoint which returns different fields.
- **Action:** Accept the code's metadata shape as superior. Update the plan to reflect the actual fields.

### Finding 5: Vercel log endpoint differs from plan [LOW]

- **Plan says (Contract 4):** `GET /v2/deployments/{id}/events` for function logs.
- **Code (line 150-151):** `GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs`
- The code uses a different (newer) Vercel endpoint than what the plan specified. This endpoint returns structured runtime logs as newline-delimited JSON rather than build/deployment events. This is actually the correct endpoint for runtime log ingestion.
- **Action:** Update the plan to reference the correct endpoint.

### Finding 6: Railway metadata does not match plan spec [LOW]

- **Plan says (Contract 4):** Railway metadata should be `{ serviceName, replicaId, environment }`.
- **Code (lines 206-209):** Metadata is `{ serviceName: platformConfig.service_name, environmentId }`.
- Missing `replicaId`. The `serviceName` comes from `platformConfig` (user-provided config) rather than from the log entry itself. The `environmentId` is used instead of `environment`.
- **Action:** Minor divergence. `replicaId` is not available from the `deploymentLogs` query as written. Accept or add `replicaId` field to the GraphQL query if available.

### Finding 7: Railway `fetchDeployments` filters post-fetch, not pre-fetch [INFO]

- **Code (line 289):** `.filter((d) => d.startedAt >= since)` — filters deployments after fetching 20.
- **Vercel `fetchDeployments` (line 211):** Passes `&since=${sinceMs}` to the API, so server-side filtering is done.
- **Railway `fetchSince` (line 189):** Uses `startDate` in the logs query for server-side filtering.
- **Impact:** For Railway `fetchDeployments`, all 20 most recent deployments are fetched and then client-side filtered. This works but is slightly less efficient if the `since` cursor is recent. Not a bug — the Railway GraphQL API may not support a `since` filter on the deployments list query itself.
- **Action:** None required. Acceptable approach.

### Finding 8: Railway `fetchDeployments` uses `updatedAt` for `completedAt` [INFO]

- **Code (line 285):** `completedAt: d.updatedAt ? new Date(d.updatedAt) : undefined`
- `updatedAt` is not the same as completion time — a deployment could be updated for reasons other than completion (e.g., scaling events, config changes).
- **Impact:** The `completedAt` field may sometimes reflect non-completion updates. This is a minor data accuracy concern for display/analytics purposes.
- **Action:** Accept as best-available approximation. Railway's API may not expose an explicit `completedAt` field.

### Finding 9: Vercel `fetchSince` uses `Date.now()` fallback for timestamps [LOW]

- **Code (line 173):** `const timestamp = new Date(log.timestampInMs || log.created || Date.now());`
- If a log entry has neither `timestampInMs` nor `created`, the current time is used. This could assign incorrect timestamps to entries.
- **Impact:** Entries with fabricated timestamps might not be filtered correctly by the `since` check on line 174, and could appear out of order in query results.
- **Action:** Consider logging a warning or skipping entries without timestamps rather than fabricating one.

---

## Stubs / TODOs / Empty Catches

- **No TODO/FIXME/HACK/STUB comments found** in any of the four files.
- **Empty catch blocks:** Three instances, all intentional:
  1. `vercel.ts:166` — `catch { return null }` in JSON.parse per-line. Correct: malformed lines become null and are filtered out.
  2. `vercel.ts:192` — `catch { continue }` for per-deployment log fetch. Correct: documented with comment "Skip individual deployment log failures".
  3. `railway.ts:212` — `catch { continue }` for per-deployment log fetch. Correct: same pattern.
- **No hardcoded return values.** All methods make real API calls.

---

## Registry Verification

- `registry.ts` imports both adapters and registers them in a `Map<string, LogAdapter>`.
- `getAdapter("vercel")` returns `vercelAdapter`. `getAdapter("railway")` returns `railwayAdapter`.
- `getRegisteredPlatforms()` returns `[{ platform: "vercel", displayName: "Vercel" }, { platform: "railway", displayName: "Railway" }]`.
- The registry exports match the Phase 1 forward plan's hook points: `getAdapter(platform: string): LogAdapter | undefined`.
- Bonus: `getRegisteredPlatforms()` was not in the plan but is useful for Phase 4 (platform validation) and Phase 6 (dropdown population).

---

## Downstream Readiness (Phase 3 Concerns)

1. **camelCase to snake_case mapping** is still required by Phase 3 collector, as noted in the Phase 1 forward plan (Mismatches 4/5). No changes needed in Phase 2 code.

2. **`fetchDeployments` is optional on `LogAdapter` interface** but both adapters implement it. Phase 3 collector must still check `if (adapter.fetchDeployments)` before calling, per the interface contract.

3. **Both adapters throw on top-level API failures** (deployment listing errors). Phase 3 collector must wrap each adapter call in try/catch per source, as specified in the plan's Flow 3 step 4.

---

## Summary

**Phase 2 is complete and correct.** All 12 wiring checklist items are satisfied. Both adapters implement the `LogAdapter` interface from Phase 1 types, make real API calls, implement exponential backoff, normalize log levels, and handle per-deployment failures gracefully. The registry correctly maps platform strings to adapter instances.

**Action items for plan updates (non-blocking):**
- Update Railway API URL in plan (`.app` -> `.com`) after verifying current endpoint
- Update Vercel log endpoint in plan (`/v2/deployments/{id}/events` -> `/v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs`)
- Update Vercel metadata spec in plan to match actual fields
- Update Railway metadata spec to drop `replicaId` or note it as unavailable

**No blockers for Phase 3.**
