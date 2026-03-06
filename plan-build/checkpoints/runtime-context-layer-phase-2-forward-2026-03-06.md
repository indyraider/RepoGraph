# Phase 2 Forward Plan Review
**Phase completed:** Adapters + Registry
**Date:** 2026-03-06
**Plan updates needed:** YES

---

## Actual Interfaces Built

### 1. Vercel Adapter (`packages/backend/src/runtime/adapters/vercel.ts`)

| Export | Kind | Signature |
|---|---|---|
| `vercelAdapter` | const (LogAdapter) | `{ platform: "vercel", displayName: "Vercel", testConnection, fetchSince, fetchDeployments }` |

**`testConnection(config: AdapterConfig): Promise<ConnectionResult>`**
- Requires `config.platformConfig.project_id` (returns error if missing)
- Reads `config.platformConfig.team_slug` (optional)
- Calls `GET /v6/deployments?projectId=X&limit=1`
- Returns `{ ok: true, meta: { entryCount, latestLogTimestamp } }` or `{ ok: false, error }`

**`fetchSince(config: AdapterConfig, since: Date): Promise<NormalizedLogEntry[]>`**
- Lists deployments via `GET /v6/deployments?projectId=X&since=T&limit=10`
- For each deployment, fetches `GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs`
- Parses newline-delimited JSON response
- Normalizes: `level` via `normalizeLevel()` (stderr/fatal -> error, warning -> warn, default -> info)
- Sets `source: "vercel"`, `deploymentId: deploy.uid`, `functionName: log.source`
- Metadata includes: `requestPath`, `requestMethod`, `statusCode`, `domain`, `rowId`
- Throws on deployment list failure; silently skips individual deployment log failures

**`fetchDeployments(config: AdapterConfig, since: Date): Promise<NormalizedDeployment[]>`**
- Calls `GET /v6/deployments?projectId=X&since=T&limit=20`
- Maps `state`/`readyState` -> normalized status (READY->ready, ERROR->error, BUILDING/INITIALIZING->building, CANCELED->cancelled, QUEUED->running)
- Reads `meta.githubCommitRef` as branch, `meta.githubCommitSha` as commitSha
- Throws on API failure

**Internal helpers (not exported):**
- `vercelFetch(path, token, teamSlug?)` -- handles 429 backoff (3 retries, exponential 1s/2s/4s, max 30s)
- `normalizeLevel(type: string)` -- maps Vercel log type to info/warn/error
- `mapDeploymentStatus(state: string)` -- maps Vercel deployment state to normalized status

### 2. Railway Adapter (`packages/backend/src/runtime/adapters/railway.ts`)

| Export | Kind | Signature |
|---|---|---|
| `railwayAdapter` | const (LogAdapter) | `{ platform: "railway", displayName: "Railway", testConnection, fetchSince, fetchDeployments }` |

**`testConnection(config: AdapterConfig): Promise<ConnectionResult>`**
- Calls `query { me { name } }` as auth check
- Returns `{ ok: true, meta: { latestLogTimestamp: undefined, entryCount: undefined } }` or `{ ok: false, error }`

**`fetchSince(config: AdapterConfig, since: Date): Promise<NormalizedLogEntry[]>`**
- Requires: `config.platformConfig.project_id`, `config.platformConfig.service_id`
- Optional: `config.platformConfig.environment_id`
- Lists deployments via GraphQL `deployments(input: { projectId, serviceId }, first: 10)`
- Fetches logs via GraphQL `deploymentLogs(deploymentId, limit: 500, startDate)`
- Normalizes: severity via `normalizeSeverity()` (error/err -> error, warn/warning -> warn, default -> info)
- Sets `source: "railway"`, `deploymentId: deploy.id`
- Metadata includes: `serviceName` (from `platformConfig.service_name`), `environmentId`
- Throws on deployment list failure; silently skips individual deployment log failures

**`fetchDeployments(config: AdapterConfig, since: Date): Promise<NormalizedDeployment[]>`**
- Lists deployments via GraphQL (first: 20) with `meta { commitHash, branch }`, `staticUrl`
- Maps status via `mapDeploymentStatus()` (success->ready, failed/crashed->error, building/deploying/initializing->building)
- Filters results to only those with `startedAt >= since`
- Throws on API failure

**Internal helpers (not exported):**
- `railwayGql<T>(query, variables, token)` -- handles 429 backoff (3 retries), throws on non-429 errors, throws after max retries exceeded
- `normalizeSeverity(severity: string)` -- maps Railway severity to info/warn/error
- `mapDeploymentStatus(status: string)` -- maps Railway status to normalized status

### 3. Adapter Registry (`packages/backend/src/runtime/adapters/registry.ts`)

| Export | Kind | Signature | Return Type |
|---|---|---|---|
| `getAdapter` | function | `(platform: string)` | `LogAdapter \| undefined` |
| `getRegisteredPlatforms` | function | `()` | `Array<{ platform: string; displayName: string }>` |

- Internal `Map<string, LogAdapter>` keyed by `adapter.platform`
- Pre-registers `vercelAdapter` and `railwayAdapter`

---

## Mismatches with Plan

### MISMATCH 1: Vercel uses runtime-logs endpoint, NOT events endpoint
- **Plan says** (Contract 4): `GET /v2/deployments/{id}/events` for function logs per deployment
- **Actually built:** `GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs`
- **Impact:** The runtime-logs endpoint returns newline-delimited JSON with different field names than the events endpoint. The adapter correctly handles this format (parses NDJSON, reads `log.level`/`log.type`, `log.message`/`log.text`, `log.timestampInMs`/`log.created`).
- **Assessment:** This is a CORRECT deviation. The runtime-logs endpoint provides structured runtime function invocation logs, which is the right data source for production error monitoring. The events endpoint is for build/deployment events.
- **Action:** Update plan Contract 4 to reference `/v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs` instead of `/v2/deployments/{id}/events`.

### MISMATCH 2: Railway GraphQL endpoint URL uses `.com` not `.app`
- **Plan says** (Contract 4): `POST https://backboard.railway.app/graphql/v2`
- **Actually built:** `POST https://backboard.railway.com/graphql/v2`
- **Impact:** If the `.com` URL is incorrect, Railway API calls will fail. Railway's current production GraphQL endpoint should be verified.
- **Action:** Verify the correct Railway API base URL. If `.app` is correct, the adapter needs to be updated.

### MISMATCH 3: Registry exports `getRegisteredPlatforms()` -- not in plan
- **Plan does not mention** a function to list all registered platforms.
- **Actually built:** `getRegisteredPlatforms(): Array<{ platform: string; displayName: string }>`
- **Impact:** This is a USEFUL addition. Phase 4 routes can use it for platform validation and Phase 6 frontend can use it for the platform dropdown. No conflict.
- **Action:** Update plan Phase 4 to use `getRegisteredPlatforms()` for platform validation instead of hardcoded checks.

### MISMATCH 4: Vercel adapter does not populate `stackTrace` or `filePath` on log entries
- **Plan expects** adapters to return `stackTrace` in `NormalizedLogEntry` when present in raw logs.
- **Actually built:** The Vercel adapter does not extract `stackTrace` from log messages. It sets `message: log.message || log.text || ""` but does not check for embedded stack traces.
- **Impact:** Phase 3 collector runs `parseStackTrace()` on error entries "lacking file_path" (per plan). Since the adapter never sets `stackTrace`, the collector will need to check the `message` field for stack trace patterns instead, or the adapter should be extracting stack traces from log messages that contain them.
- **Assessment:** This is by design -- the adapter returns raw messages, and the collector's job is to detect and parse stack traces from those messages. However, the collector will need to look at `entry.message` (not `entry.stackTrace`) for stack trace content on entries where `stackTrace` is undefined.
- **Action:** Phase 3 collector must handle the case where `stackTrace` is undefined but `message` contains a stack trace. It should either: (a) scan `message` for stack trace patterns and populate `stack_trace` before insert, or (b) only parse entries where `stackTrace` is explicitly set. Recommend option (a) since adapters don't extract stack traces.

### MISMATCH 5: Railway adapter reads `platformConfig.service_name` but plan doesn't mention it
- **Plan's request body** (Contract 1) lists Railway config as: `project_id`, `service_id`, `environment_id`.
- **Actually built:** Railway adapter also reads `platformConfig.service_name` for metadata.
- **Impact:** Minor -- just metadata enrichment. Frontend will need to include `service_name` in the config form for Railway if we want this populated.
- **Action:** Add `service_name` to the Railway config fields in Phase 6 frontend form.

### MISMATCH 6: Vercel `fetchSince` missing `project_id` validation
- **testConnection** validates that `project_id` exists and returns an error if missing.
- **fetchSince** and **fetchDeployments** cast `platformConfig.project_id as string` without checking.
- **Impact:** If `project_id` is missing, the URL will contain `undefined` and the API call will fail with an unhelpful error. The collector's per-source try/catch will handle this, but the error message won't be clear.
- **Assessment:** Low risk since `testConnection` is called before a source goes live, but defensive coding would be better.
- **Action:** Not a blocker. Can be improved later.

---

## Dependency Readiness for Phase 3 (Log Collector + Retention)

### Functions the Collector Must Call

**From registry (`runtime/adapters/registry.ts`):**
```typescript
import { getAdapter } from "./adapters/registry.js";

const adapter: LogAdapter | undefined = getAdapter(source.platform);
// Must check: if (!adapter) { set last_error, continue to next source }
```

**From adapter (via `LogAdapter` interface):**
```typescript
// Fetch logs -- ALWAYS called
const entries: NormalizedLogEntry[] = await adapter.fetchSince(adapterConfig, sinceDate);

// Fetch deployments -- OPTIONAL, must check existence
if (adapter.fetchDeployments) {
  const deployments: NormalizedDeployment[] = await adapter.fetchDeployments(adapterConfig, sinceDate);
}
```

**From crypto (`lib/crypto.ts`):**
```typescript
import { decrypt } from "../lib/crypto.js";

const apiToken: string = decrypt(source.config.encrypted_api_token);
```

**From stack parser (`runtime/stack-parser.ts`):**
```typescript
import { parseStackTrace, ParsedFrame } from "./stack-parser.js";

const frames: ParsedFrame[] = parseStackTrace(entry.message);
// frames[0]?.filePath, frames[0]?.lineNumber
```

**AdapterConfig construction:**
```typescript
const adapterConfig: AdapterConfig = {
  apiToken: decrypt(source.config.encrypted_api_token),
  platformConfig: {
    // spread source.config but exclude encrypted_api_token
    ...source.config,
    encrypted_api_token: undefined,
  },
};
```

### camelCase to snake_case Mapping

**NormalizedLogEntry -> runtime_logs insert:**
```typescript
{
  repo_id:        source.repo_id,       // from log_sources row
  source:         entry.source,         // "vercel" | "railway"
  level:          entry.level,          // "info" | "warn" | "error"
  message:        entry.message,
  timestamp:      entry.timestamp,      // Date object -- Supabase handles serialization
  deployment_id:  entry.deploymentId,
  function_name:  entry.functionName,
  file_path:      entry.filePath,       // likely undefined; set from stack parser
  line_number:    entry.lineNumber,     // likely undefined; set from stack parser
  stack_trace:    entry.stackTrace,     // likely undefined; detect from message
  metadata:       entry.metadata,
}
```

**NormalizedDeployment -> deployments upsert:**
```typescript
{
  repo_id:        source.repo_id,         // from log_sources row
  source:         deployment.source,      // "vercel" | "railway"
  deployment_id:  deployment.deploymentId,
  status:         deployment.status,
  branch:         deployment.branch,
  commit_sha:     deployment.commitSha,
  started_at:     deployment.startedAt,   // Date object
  completed_at:   deployment.completedAt, // Date object | undefined
  url:            deployment.url,
}
```

**Deployments upsert conflict clause:** `ON CONFLICT (repo_id, deployment_id, source)` -- matches the UNIQUE constraint in the migration.

### Collector Export Contract (for Phase 4 / index.ts)

The collector must export:
```typescript
export function startCollector(): void   // starts setInterval(10s)
export function stopCollector(): void    // clears interval
```

### Retention Export Contract (for Phase 4 / index.ts)

The retention worker must export:
```typescript
export function startRetention(): void   // starts setInterval(1 hour)
export function stopRetention(): void    // clears interval
```

---

## Dependency Readiness for Phase 4 (Backend API Routes)

### Registry functions needed:
```typescript
import { getAdapter, getRegisteredPlatforms } from "../runtime/adapters/registry.js";

// Validate platform on POST/PUT:
const adapter = getAdapter(req.body.platform);
if (!adapter) return res.status(400).json({ error: "Unknown platform" });

// Test connection:
const result: ConnectionResult = await adapter.testConnection(adapterConfig);

// List platforms for frontend dropdown (optional endpoint):
const platforms = getRegisteredPlatforms();
```

### Crypto functions needed:
```typescript
import { encrypt, decrypt } from "../lib/crypto.js";

// On POST (create source): encrypt(req.body.api_token)
// On test connection: decrypt(source.config.encrypted_api_token)
```

---

## Dependency Readiness for Phase 5 (MCP Runtime Tools)

Phase 5 does NOT directly import from Phase 2 adapters. MCP tools query Supabase tables populated by the collector. No interface dependency on adapters/registry.

---

## Dependency Readiness for Phase 6 (Frontend UI)

Phase 6 needs to know the valid platforms for the dropdown. Two options:
1. Hardcode `["vercel", "railway"]` in the frontend (simple).
2. Add a `GET /api/log-sources/platforms` route in Phase 4 that calls `getRegisteredPlatforms()` (extensible).

The `getRegisteredPlatforms()` function was added to the registry, which supports option 2. Recommend implementing it in Phase 4.

---

## Issues Found

### ISSUE 1: Stack trace extraction gap
Neither adapter populates `stackTrace` on `NormalizedLogEntry`. The `message` field may contain stack traces for error-level logs, but the adapters don't detect or separate them. Phase 3 collector must:
1. For error-level entries where `stackTrace` is undefined, scan `message` for stack trace patterns.
2. If a stack trace is detected in `message`, extract it into the `stack_trace` DB column.
3. Run `parseStackTrace()` on the extracted stack trace to populate `file_path` and `line_number`.

### ISSUE 2: Railway API URL needs verification
The adapter uses `https://backboard.railway.com/graphql/v2` but the plan specifies `.app`. The correct URL should be verified against Railway's current documentation before deployment.

### ISSUE 3: `NormalizedDeployment` missing `repo_id`
The `NormalizedDeployment` interface does not include a `repo_id` field. The collector must add `repo_id` from the `log_sources` row when inserting into the `deployments` table. This is expected behavior (adapters don't know about repo IDs), but the collector must remember to add it.

### ISSUE 4: `NormalizedLogEntry` missing `repo_id`
Same pattern -- the collector must add `repo_id` from the `log_sources` row to each entry before inserting into `runtime_logs`. Already reflected in the mapping above.

---

## Recommended Plan Updates

1. **Update Contract 4 Vercel section:** Change endpoint from `GET /v2/deployments/{id}/events` to `GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs`.

2. **Update Contract 4 Railway section:** Verify and fix the GraphQL endpoint URL (`.com` vs `.app`).

3. **Add `getRegisteredPlatforms()` to plan:** Document the new registry function and recommend a `/api/log-sources/platforms` route in Phase 4.

4. **Add stack trace detection to Phase 3 checklist:** "For error-level entries where stackTrace is undefined, scan message for stack trace patterns and extract into stack_trace column."

5. **Add `service_name` to Railway config fields:** Phase 6 frontend form should include this optional field.

6. **No structural blockers for Phase 3.** All interfaces Phase 3 needs are in place. The registry, adapters, types, crypto, and stack parser are all wired correctly. Phase 3 can proceed immediately.
