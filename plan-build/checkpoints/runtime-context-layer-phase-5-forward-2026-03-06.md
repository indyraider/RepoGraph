# Phase 5 Forward Plan Review
**Phase completed:** MCP Runtime Tools
**Date:** 2026-03-06
**Plan updates needed:** NO

## Actual Interfaces Built

### repo-resolver.ts

**Exported function:**
```typescript
export async function resolveRepoId(
  sb: SupabaseClient,
  repoNameOrUrl: string
): Promise<string | null>
```

**Deviation from plan:** The plan spec showed `resolveRepoId(repoNameOrUrl: string)` calling `getSupabase()` internally. The implementation takes `sb: SupabaseClient` as an explicit first argument (dependency injection). This is fine — callers in `runtime-tools.ts` pass `getSupabase()` at the call site.

**Supabase query:** `repositories` table, columns `id`, `name`, `url`. Uses `.or()` filter matching on `name` or `url`.

---

### runtime-tools.ts

**Exported function:**
```typescript
export function registerRuntimeTools(
  server: McpServer,
  getSession: GetSessionFn,    // () => Session
  getSupabase: GetSupabaseFn   // () => SupabaseClient
): void
```

**Internal types (not exported):**
```typescript
interface ParsedFrame { filePath: string; lineNumber: number; functionName?: string }
type GetSessionFn = () => Session
type GetSupabaseFn = () => SupabaseClient
```

**Internal function:** `parseStackTrace(stack: string): ParsedFrame[]` — duplicated from backend `stack-parser.ts`. Handles Node.js and Python frames. Strips common path prefixes (`/var/task/`, `/app/`, etc.). Filters out `node_modules/` and `site-packages/`. Not exported.

**Internal function:** `formatLogEntries(entries: Record<string, unknown>[]): string` — formats log entries for search_logs output. Not exported.

---

### 5 MCP Tools Registered

#### 1. `get_recent_logs`
- **Params:** `repo: string`, `source?: string`, `minutes?: number (default 30)`, `level?: string`, `max_results?: number (default 50)`
- **Tables queried:** `runtime_logs` — columns: `id, timestamp, source, level, message, function_name, file_path, line_number`
- **Filters:** `repo_id` (resolved), `timestamp >= since`, optionally `source`, `level`
- **Response shape:** `{ content: [{ type: "text", text: string }] }` — markdown formatted log list

#### 2. `search_logs`
- **Params:** `query: string`, `repo: string`, `source?: string`, `since?: string (ISO 8601)`, `level?: string`
- **Tables queried:** `runtime_logs` — columns: `id, timestamp, source, level, message, file_path, line_number, stack_trace`
- **Search method:** Primary: `.textSearch("message", query, { type: "websearch" })` (requires GIN index). Fallback: `.ilike("message", ...)` if full-text search fails.
- **Limit:** 30 results hardcoded
- **Response shape:** Same MCP text content pattern

#### 3. `get_deploy_errors`
- **Params:** `repo: string`, `source?: string`, `deployment_id?: string`, `last_n_deploys?: number (default 1)`
- **Tables queried:** `deployments` — columns: `deployment_id, source, status, branch, commit_sha, started_at`. `runtime_logs` — all columns including `stack_trace, deployment_id`
- **Logic:** Resolves deployment IDs first from `deployments` table, then fetches `level = "error"` logs scoped to those IDs
- **Response shape:** Markdown with deployment info header + error list with truncated stack traces (first 3 lines)

#### 4. `get_deployment_history`
- **Params:** `repo: string`, `source?: string`, `max_results?: number (default 10)`
- **Tables queried:** `deployments` — `SELECT *`. `runtime_logs` — columns: `deployment_id, level` (for error/warn counts)
- **Logic:** Fetches deployments, then counts error/warn logs per deployment via a second query
- **Note:** The log count query fetches all matching rows and counts client-side (not aggregated in DB). Fine for small counts; could be a performance concern with high-volume logs.
- **Response shape:** Markdown table with columns: Time, Platform, Status, Branch, Commit, Errors, Warns

#### 5. `trace_error`
- **Params:** `repo: string`, `log_id?: string`, `stack_trace?: string` (at least one required)
- **Tables queried:** `runtime_logs` — `SELECT *` by `id`. `file_contents` — columns: `content, language` by `file_path`.
- **Neo4j queries (3 sequential):**
  1. Function lookup: `MATCH (f:File {path})-[:CONTAINS]->(fn:Function) WHERE fn.start_line <= $line AND fn.end_line >= $line`
  2. Callers: `MATCH (fn:Function {name})<-[:CALLS]-(caller:Function)<-[:CONTAINS]-(f:File)`
  3. Imports: `MATCH (f:File {path})-[r:IMPORTS]->(target)` returning `target.path, target.name, labels(target)[0], r.symbols`
- **Graceful degradation:** Returns partial context when Neo4j yields empty results, raw stack when parsing fails
- **Response shape:** Multi-section markdown: Log Context, Containing Function, Callers, Imports, Source code, Full Stack Frames

---

### index.ts Registration

Line 632: `registerRuntimeTools(server, getSession, getSupabase);`

Import on line 9: `import { registerRuntimeTools } from "./runtime-tools.js";`

Passes existing `getSession` and `getSupabase` factory functions. No new env vars required.

---

### Supabase Tables/Columns Touched by Phase 5 Code

| Table | Columns Read | Operation |
|-------|-------------|-----------|
| `repositories` | `id, name, url` | `.or()` lookup for repo resolution |
| `runtime_logs` | `id, timestamp, source, level, message, function_name, file_path, line_number, stack_trace, deployment_id, repo_id, metadata` (via `*`) | SELECT with various filters |
| `deployments` | `deployment_id, source, status, branch, commit_sha, started_at, repo_id` (and `*`) | SELECT with repo_id filter |
| `file_contents` | `content, language, file_path` | SELECT by file_path (single) |

### Neo4j Node Labels and Relationship Types Used

- `(:File {path})-[:CONTAINS]->(:Function {name, signature, docstring, start_line, end_line})`
- `(:Function {name})<-[:CALLS]-(:Function {name, start_line})<-[:CONTAINS]-(:File {path})`
- `(:File {path})-[:IMPORTS {symbols}]->(:File | :Package {path, name})`

These match the existing code graph schema used by other MCP tools in the same file.

---

## Mismatches with Plan

### 1. resolveRepoId signature change (benign)
- **Plan:** `resolveRepoId(repoNameOrUrl: string)` with internal `getSupabase()` call
- **Actual:** `resolveRepoId(sb: SupabaseClient, repoNameOrUrl: string)` with DI
- **Impact:** None on Phase 6. The frontend never imports from the MCP server package.

### 2. No mismatches affecting Phase 6
Phase 5 (MCP tools) and Phase 6 (Frontend LogSourcePanel) are fully independent. The MCP tools are consumed by Claude via the MCP protocol, not by the frontend. The frontend consumes the backend API routes (Phase 4), not the MCP tools.

---

## Hook Points for Next Phase

Phase 6 builds:
1. **API functions in `packages/frontend/src/api.ts`**
2. **`LogSourcePanel` component at `packages/frontend/src/components/LogSourcePanel.tsx`**
3. **Integration into `packages/frontend/src/views/SettingsView.tsx`**

### Backend API Routes (Phase 4) — ready and mounted

All 7 endpoints are live at `/api/log-sources`:

| Method | Path | Purpose | Response Shape |
|--------|------|---------|---------------|
| GET | `/api/log-sources` | List all sources | `Array<{ id, repo_id, platform, display_name, config (no token), polling_interval_sec, min_level, enabled, last_poll_at, last_error, created_at }>` |
| GET | `/api/log-sources/platforms` | List registered adapters | `Array<{ platform: string, displayName: string }>` |
| POST | `/api/log-sources` | Create source | `{ id, repo_id, platform, display_name, config (no token), ... }` (201) |
| PUT | `/api/log-sources/:id` | Update source | Same shape as create response |
| DELETE | `/api/log-sources/:id` | Delete source | `{ ok: true }` |
| POST | `/api/log-sources/:id/test` | Test saved source | `{ ok: boolean, error?: string, latestLog?: string }` |
| POST | `/api/log-sources/test-connection` | Test before saving | `{ ok: boolean, error?: string }` |
| POST | `/api/log-sources/:id/toggle` | Toggle enabled | `{ id, enabled }` |

**Note:** The plan listed 6 endpoints. The actual implementation adds 2 extras:
- `GET /platforms` — useful for the frontend dropdown (no hardcoding platform list)
- `POST /test-connection` — test *before* saving (the plan's `/test` only works on saved sources)

### Frontend api.ts — pattern to follow

The existing `api.ts` uses `authedFetch()` with `authHeaders()`. Phase 6 should add functions following the same pattern:
- `getLogSources()` → GET `/api/log-sources`
- `getLogSourcePlatforms()` → GET `/api/log-sources/platforms`
- `createLogSource(body)` → POST `/api/log-sources`
- `updateLogSource(id, body)` → PUT `/api/log-sources/:id`
- `deleteLogSource(id)` → DELETE `/api/log-sources/:id`
- `testLogSourceConnection(body)` → POST `/api/log-sources/test-connection`
- `testSavedLogSource(id)` → POST `/api/log-sources/:id/test`
- `toggleLogSource(id)` → POST `/api/log-sources/:id/toggle`

### SettingsView.tsx — integration point

The `LogSourcePanel` should be added after the MCP Configuration card (currently the last card, ending at line 501). The plan specifies:
```tsx
{/* Log Sources */}
<div className="card-glass rounded-xl overflow-hidden mt-6">
  <LogSourcePanel />
</div>
```
This goes inside the `max-w-4xl` container div, after the MCP card.

### Database schema — ready

The `log_sources` table has all columns the frontend needs to display:
- `id`, `repo_id`, `platform`, `display_name`, `config` (JSONB, token stripped in API response)
- `polling_interval_sec`, `min_level`, `enabled`
- `last_poll_at`, `last_error`, `created_at`

### Repo list — the frontend will need it

The create form needs a `repo_id` dropdown. The existing `getRepositories()` API function in `api.ts` returns `Repository[]` with `id` and `name` fields. The `LogSourcePanel` should use this to populate a repo selector.

---

## New Opportunities

### 1. Platform list endpoint
The backend provides `GET /api/log-sources/platforms` which returns `[{ platform, displayName }]`. This is not mentioned in the plan but is already built. Phase 6 should use it to dynamically populate the platform dropdown rather than hardcoding "Vercel" and "Railway".

### 2. Pre-save test endpoint
The `POST /api/log-sources/test-connection` endpoint accepts `{ platform, api_token, config }` directly (no saved source needed). This enables a better UX: test before save, matching the plan's happy-path flow step 6-12.

### 3. Client-side log count aggregation concern
The `get_deployment_history` tool fetches all error/warn log rows to count them client-side. This is fine for MCP tool usage (low volume, developer queries) but worth noting if anyone later considers exposing deployment history in the frontend — a server-side aggregation query would be needed.

---

## Recommended Plan Updates

**No plan updates needed.** Phase 5 is complete and correct. All interfaces match what the plan expects. Phase 6 has no dependencies on Phase 5's MCP tools — it depends only on Phase 4's backend API routes, which are fully operational.

The two extra endpoints (`/platforms` and `/test-connection`) are additive improvements that Phase 6 should take advantage of but do not require plan changes — they are strictly more capable than what the plan specified.
