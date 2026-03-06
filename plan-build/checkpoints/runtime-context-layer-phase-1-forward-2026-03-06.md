# Phase 1 Forward Plan Review
**Phase completed:** Foundation (Database + Types + Crypto)
**Date:** 2026-03-06
**Plan updates needed:** YES

---

## Actual Interfaces Built

### 1. Database Schema (`supabase-runtime-migration.sql`)

**Tables:**

| Table | Columns (name : type) |
|---|---|
| `log_sources` | `id` UUID PK, `repo_id` UUID FK, `platform` TEXT, `display_name` TEXT, `config` JSONB, `polling_interval_sec` INTEGER (default 30), `min_level` TEXT (default 'warn'), `enabled` BOOLEAN (default true), `last_poll_at` TIMESTAMPTZ, `last_error` TEXT, `created_at` TIMESTAMPTZ |
| `deployments` | `id` UUID PK, `repo_id` UUID FK, `source` TEXT, `deployment_id` TEXT, `status` TEXT, `branch` TEXT, `commit_sha` TEXT, `started_at` TIMESTAMPTZ, `completed_at` TIMESTAMPTZ, `url` TEXT, `created_at` TIMESTAMPTZ, UNIQUE(`repo_id`, `deployment_id`, `source`) |
| `runtime_logs` | `id` UUID PK, `repo_id` UUID FK, `source` TEXT, `level` TEXT, `message` TEXT, `timestamp` TIMESTAMPTZ, `deployment_id` TEXT, `function_name` TEXT, `file_path` TEXT, `line_number` INTEGER, `stack_trace` TEXT, `metadata` JSONB |

**Indexes:**

| Index Name | Table | Columns/Type |
|---|---|---|
| `idx_runtime_logs_timestamp` | runtime_logs | `(timestamp DESC)` |
| `idx_runtime_logs_level_timestamp` | runtime_logs | `(level, timestamp DESC)` |
| `idx_runtime_logs_source_timestamp` | runtime_logs | `(source, timestamp DESC)` |
| `idx_runtime_logs_deployment` | runtime_logs | `(deployment_id, source)` |
| `idx_runtime_logs_repo_timestamp` | runtime_logs | `(repo_id, timestamp DESC)` |
| `idx_runtime_logs_message_fts` | runtime_logs | GIN `to_tsvector('english', message)` |
| `idx_deployments_started_at` | deployments | `(started_at DESC)` |
| `idx_deployments_repo_started` | deployments | `(repo_id, started_at DESC)` |
| `idx_log_sources_repo` | log_sources | `(repo_id)` |

**Constraints:**
- `deployments` has `UNIQUE(repo_id, deployment_id, source)` -- matches plan requirement.
- All three tables have `ON DELETE CASCADE` via `repo_id` FK to `repositories`.

### 2. Crypto Utilities (`packages/backend/src/lib/crypto.ts`)

| Export | Signature | Return Type |
|---|---|---|
| `encrypt` | `(text: string): string` | `string` (format: `iv:tag:ciphertext` all base64) |
| `decrypt` | `(encoded: string): string` | `string` |
| `encryptCredentials` | `(creds: Record<string, string>): Record<string, string>` | `Record<string, string>` |
| `decryptCredentials` | `(creds: Record<string, string>): Record<string, string>` | `Record<string, string>` |
| `maskValue` | `(value: string): string` | `string` |

- Uses AES-256-GCM with key derived via `scryptSync(config.sessionSecret, "repograph-connections", 32)`.
- Depends on `config.sessionSecret` from `../config.js`.

### 3. Connections Router (`packages/backend/src/connections.ts`)

- Updated to import `{ encryptCredentials, decryptCredentials, maskValue }` from `"./lib/crypto.js"`.
- No new exports -- still `export default router`.
- Confirms the crypto extraction is wired correctly.

### 4. Adapter Interface Types (`packages/backend/src/runtime/adapters/types.ts`)

| Export | Kind | Shape |
|---|---|---|
| `AdapterConfig` | interface | `{ apiToken: string; platformConfig: Record<string, unknown> }` |
| `ConnectionResult` | interface | `{ ok: boolean; error?: string; meta?: { latestLogTimestamp?: string; entryCount?: number } }` |
| `NormalizedLogEntry` | interface | `{ source: string; level: "info" \| "warn" \| "error"; message: string; timestamp: Date; deploymentId?: string; functionName?: string; filePath?: string; lineNumber?: number; stackTrace?: string; metadata: Record<string, unknown> }` |
| `NormalizedDeployment` | interface | `{ source: string; deploymentId: string; status: string; branch?: string; commitSha?: string; startedAt: Date; completedAt?: Date; url?: string }` |
| `LogAdapter` | interface | `{ platform: string; displayName: string; testConnection(config: AdapterConfig): Promise<ConnectionResult>; fetchSince(config: AdapterConfig, since: Date): Promise<NormalizedLogEntry[]>; fetchDeployments?(config: AdapterConfig, since: Date): Promise<NormalizedDeployment[]> }` |

### 5. Stack Trace Parser (`packages/backend/src/runtime/stack-parser.ts`)

| Export | Kind | Signature |
|---|---|---|
| `ParsedFrame` | interface | `{ filePath: string; lineNumber: number; columnNumber?: number; functionName?: string }` |
| `parseStackTrace` | function | `(stackTrace: string): ParsedFrame[]` |

- Supports Node.js, Python, Go frame formats.
- Strips container prefixes: `/var/task/`, `/app/`, `/home/<user>/`, `/opt/<name>/`, `/workspace/`.
- Filters out `node_modules/`, `node:` internal, `site-packages/`, `<` builtins, `/pkg/mod/` Go stdlib.
- Returns empty array on empty/unparseable input (never throws).

---

## Mismatches with Plan

### MISMATCH 1: Crypto module location
- **Plan says:** `packages/backend/src/runtime/crypto.ts` (Component Inventory row) OR `packages/backend/src/lib/crypto.ts` (parenthetical alternative in Issues Found section)
- **Actually built:** `packages/backend/src/lib/crypto.ts`
- **Impact:** Phase 3 (collector) and Phase 4 (routes) need to import from the correct path. The plan's Component Inventory references `packages/backend/src/runtime/crypto.ts` which does not exist.
- **Action:** Update plan Component Inventory to `packages/backend/src/lib/crypto.ts`. All future phases must import from `"../lib/crypto.js"` (from runtime/) or `"./lib/crypto.js"` (from src/).

### MISMATCH 2: `ConnectionResult` vs plan's `testConnection()` return
- **Plan says** (Contract 1, end-to-end flow): `testConnection()` returns `{ ok: true, latestLog: "..." }`
- **Actually built:** `ConnectionResult` has `{ ok: boolean; error?: string; meta?: { latestLogTimestamp?: string; entryCount?: number } }`
- **Impact:** Phase 2 adapters must return `ConnectionResult`, not the `{ ok, latestLog }` shape. Phase 4 routes and Phase 6 frontend test-connection handler must consume `ConnectionResult.meta` not a flat `latestLog` field.
- **Action:** Update plan Flow 1 step 10 and Contract 1 to reference `ConnectionResult` shape. Frontend must display `meta.latestLogTimestamp` instead of `latestLog`.

### MISMATCH 3: `NormalizedLogEntry.timestamp` is `Date`, DB column is `TIMESTAMPTZ`
- **Plan says** (Contract 6): insert shape has `timestamp: string` (ISO 8601).
- **Actually built:** `NormalizedLogEntry.timestamp` is typed as `Date`.
- **Impact:** Phase 3 collector will need to call `.toISOString()` on the `Date` before Supabase insert, or rely on Supabase JS client auto-serialization. This is minor but should be documented.
- **Action:** Note in Phase 3 that Supabase JS client handles Date-to-TIMESTAMPTZ conversion automatically. No code change needed, but plan Contract 6 insert shape should say `timestamp: Date | string`.

### MISMATCH 4: `NormalizedLogEntry` field casing vs DB column names
- **Built interface uses camelCase:** `deploymentId`, `functionName`, `filePath`, `lineNumber`, `stackTrace`
- **DB columns use snake_case:** `deployment_id`, `function_name`, `file_path`, `line_number`, `stack_trace`
- **Impact:** Phase 3 collector must map between these when inserting. This is expected (TypeScript convention vs SQL convention), but the plan's Contract 6 insert shape uses snake_case, so the collector must perform the conversion.
- **Action:** Phase 3 must include a mapping step: `{ repo_id, source: entry.source, level: entry.level, message: entry.message, timestamp: entry.timestamp, deployment_id: entry.deploymentId, function_name: entry.functionName, file_path: entry.filePath, line_number: entry.lineNumber, stack_trace: entry.stackTrace, metadata: entry.metadata }`.

### MISMATCH 5: `NormalizedDeployment` field casing vs DB column names
- Same pattern: `deploymentId` -> `deployment_id`, `commitSha` -> `commit_sha`, `startedAt` -> `started_at`, `completedAt` -> `completed_at`.
- **Action:** Phase 3 collector upsert must map these fields. Document in Phase 3 checklist.

### MISMATCH 6: `fetchDeployments()` is optional on `LogAdapter`
- **Plan says** (Phase 2 checklist): "Implement Railway fetchDeployments()" and "Implement Vercel fetchDeployments()" as required items.
- **Actually built:** `fetchDeployments?()` is optional (note the `?` on the method).
- **Impact:** Phase 3 collector must check `if (adapter.fetchDeployments)` before calling. This is fine but the plan's collector description (Contract 3, Flow 3) assumes it always exists.
- **Action:** Update plan Flow 3 step 3e to: "If adapter implements fetchDeployments, call it; otherwise skip deployment upsert."

### MISMATCH 7: `fetchSince()` returns only logs, not logs+deployments
- **Plan says** (Contract 3): `fetchSince()` returns `NormalizedLogEntry[]` and `NormalizedDeployment[]`.
- **Actually built:** `fetchSince()` returns only `Promise<NormalizedLogEntry[]>`. Deployments come from the separate `fetchDeployments()` method.
- **Impact:** Phase 3 collector must make two calls per adapter (fetchSince + fetchDeployments) instead of one. Flow 3 step 3e must be updated.
- **Action:** Update Contract 3 to reflect the two-call pattern.

---

## Hook Points for Next Phase

Phase 2 (Adapters + Registry) needs to consume these exact interfaces:

### To Implement (adapters)

Each adapter (`vercel.ts`, `railway.ts`) must:

1. **Export a class/object implementing `LogAdapter`** from `../types.js`:
   ```typescript
   import { LogAdapter, AdapterConfig, ConnectionResult, NormalizedLogEntry, NormalizedDeployment } from "./types.js";
   ```

2. **Set `platform` property:** `"vercel"` or `"railway"` (matches `log_sources.platform` column values).

3. **Set `displayName` property:** Human-readable name for UI.

4. **Implement `testConnection(config: AdapterConfig): Promise<ConnectionResult>`**
   - Receives `config.apiToken` (decrypted string) and `config.platformConfig` (Record with project_id, team_slug, etc.)
   - Must return `{ ok: true, meta: { latestLogTimestamp, entryCount } }` or `{ ok: false, error: "message" }`

5. **Implement `fetchSince(config: AdapterConfig, since: Date): Promise<NormalizedLogEntry[]>`**
   - Must normalize platform log levels to `"info" | "warn" | "error"`
   - Must populate `source` field with platform string

6. **Implement `fetchDeployments(config: AdapterConfig, since: Date): Promise<NormalizedDeployment[]>`**
   - Optional but plan calls for it on both adapters
   - Must populate `source` and `deploymentId` fields

### To Create (registry)

`packages/backend/src/runtime/adapters/registry.ts` must:

1. Import both adapter instances.
2. Export a function to retrieve adapter by platform string:
   ```typescript
   function getAdapter(platform: string): LogAdapter | undefined
   ```
3. The registry will be consumed by:
   - Phase 3 collector: `getAdapter(source.platform)` to load the right adapter per log_sources row.
   - Phase 4 routes: `getAdapter(platform)` to validate platform strings and run `testConnection()`.

### Types Ready for Consumption

| Type | Location | Consumers |
|---|---|---|
| `AdapterConfig` | `runtime/adapters/types.ts` | Phase 2 adapters, Phase 3 collector, Phase 4 routes |
| `ConnectionResult` | `runtime/adapters/types.ts` | Phase 2 adapters, Phase 4 routes |
| `NormalizedLogEntry` | `runtime/adapters/types.ts` | Phase 2 adapters, Phase 3 collector |
| `NormalizedDeployment` | `runtime/adapters/types.ts` | Phase 2 adapters, Phase 3 collector |
| `LogAdapter` | `runtime/adapters/types.ts` | Phase 2 registry, Phase 3 collector, Phase 4 routes |
| `ParsedFrame` | `runtime/stack-parser.ts` | Phase 3 collector, Phase 5 trace_error |
| `parseStackTrace` | `runtime/stack-parser.ts` | Phase 3 collector, Phase 5 trace_error |
| `encrypt` | `lib/crypto.ts` | Phase 4 routes (encrypt api_token on create) |
| `decrypt` | `lib/crypto.ts` | Phase 3 collector (decrypt api_token at poll time) |

### Database Tables Ready

| Table | Consumers |
|---|---|
| `log_sources` | Phase 3 collector (poll query), Phase 4 routes (CRUD), Phase 6 frontend (via API) |
| `runtime_logs` | Phase 3 collector (insert), Phase 5 MCP tools (query) |
| `deployments` | Phase 3 collector (upsert), Phase 5 MCP tools (query) |

---

## Recommended Plan Updates

1. **Update Component Inventory:** Change crypto location from `packages/backend/src/runtime/crypto.ts` to `packages/backend/src/lib/crypto.ts`.

2. **Update Contract 3:** Change `fetchSince()` output description from "NormalizedLogEntry[] + NormalizedDeployment[]" to "NormalizedLogEntry[] only; deployments come from separate fetchDeployments() call."

3. **Update Contract 3 / Flow 3:** Add step for optional `fetchDeployments()` call. Change step 3e from assuming combined return to: "If adapter.fetchDeployments exists, call it and batch-upsert results."

4. **Update Flow 1 step 10:** Change `{ ok: true, latestLog: "..." }` to `ConnectionResult` shape: `{ ok: true, meta: { latestLogTimestamp: "...", entryCount: N } }`.

5. **Add to Phase 3 checklist:** "Map camelCase NormalizedLogEntry/NormalizedDeployment fields to snake_case DB columns before insert."

6. **Update Contract 6 insert shape:** Change `timestamp: string` to `timestamp: Date` (Supabase JS handles serialization).

7. **No structural blockers for Phase 2.** All interfaces Phase 2 needs are in place and the types are well-defined. Phase 2 can proceed immediately.
