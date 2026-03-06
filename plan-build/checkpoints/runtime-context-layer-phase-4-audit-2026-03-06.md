# Phase 4 Audit: Backend API Routes
**Date:** 2026-03-06
**Status:** PASS WITH ISSUES

## Files Audited
- `packages/backend/src/runtime/routes.ts` (new file, 262 lines)
- `packages/backend/src/index.ts` (modifications — import + mount)

## Verification Against Wiring Checklist

| Checklist Item | Status | Notes |
|---|---|---|
| Create routes at routes.ts | PASS | |
| GET /api/log-sources — list with masked tokens | ISSUE | Token stripped but not masked (see I-1) |
| POST /api/log-sources — create (encrypt, validate) | PASS | |
| PUT /api/log-sources/:id — update | PASS | |
| DELETE /api/log-sources/:id — remove | PASS | |
| POST /api/log-sources/:id/test — test connection | ISSUE | Missing try/catch (see I-2) |
| POST /api/log-sources/:id/toggle — flip enabled | PASS | |
| Mount in index.ts | PASS | Line 75 |
| Validate platform against registry | PASS | Uses `getAdapter()` on POST create |

## Crypto Compatibility

**Q: Does encrypt(api_token) match what collector's safeDecrypt() expects?**
YES. Both routes.ts and collector.ts import from the same `packages/backend/src/lib/crypto.ts`. Routes call `encrypt()`, collector calls `safeDecrypt()`, which wraps `decrypt()` in a try/catch. The AES-256-GCM format (`iv:tag:ciphertext` base64) is consistent. `connections.ts` was also updated to import from the shared module — no duplication.

**Q: Is encrypted_api_token NEVER returned in any response?**
YES. All three response paths (GET list line 30, POST create line 88, PUT update line 145) explicitly `delete responseConfig.encrypted_api_token` before sending. The DELETE and toggle endpoints don't return config at all.

## Issues Found

### I-1: GET response strips token but does not mask it (LOW)
**Location:** `routes.ts:28-34`
The GET handler deletes `encrypted_api_token` from the config object, which is correct. However, the plan's response contract says "token NEVER included" — this is satisfied. The `maskValue` import exists but is unused. Not a bug, but the unused import should be cleaned up.

### I-2: CRITICAL — test-connection endpoints lack try/catch around adapter.testConnection()
**Location:** `routes.ts:202` and `routes.ts:226`
Both the `POST /:id/test` and `POST /test-connection` routes call `adapter.testConnection(adapterConfig)` without a try/catch. If the adapter throws (network timeout, DNS failure, malformed response from platform API), the error will propagate as an unhandled rejection, returning a raw 500 with no structured error body. The collector handles this correctly (line 209 wraps in try/catch), but the routes do not.

**Fix:** Wrap both `testConnection()` calls:
```typescript
try {
  const result = await adapter.testConnection(adapterConfig);
  res.json(result);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  res.json({ ok: false, error: msg });
}
```

### I-3: No authorization scoping — any authenticated user can CRUD any log source (MEDIUM)
**Location:** `routes.ts` — all handlers
The `connections.ts` routes extract `githubId` from the JWT and scope all queries with `.eq("github_id", githubId)`. The log source routes do NOT do this. Any authenticated user can:
- List ALL log sources across all repos (GET /)
- Modify or delete any source by ID (PUT/DELETE /:id)
- Test or toggle any source (POST /:id/test, /:id/toggle)

This is a security gap. At minimum, routes should verify the authenticated user has access to the `repo_id` associated with the log source. If this is intentional for an admin-only deployment, it should be documented.

### I-4: PUT allows changing platform field implicitly via config merge (LOW)
**Location:** `routes.ts:93-126`
The PUT handler does not accept or validate a `platform` change, but it also doesn't prevent the caller from injecting arbitrary keys into `config` (including `encrypted_api_token` if they pass it inside `config`). A malicious request body like `{ config: { encrypted_api_token: "attacker-value" } }` would overwrite the encrypted token with an unencrypted string, breaking decryption.

**Fix:** Strip `encrypted_api_token` from the incoming `config` before merging:
```typescript
const { encrypted_api_token: _drop, ...safeConfig } = config || {};
const newConfig = { ...existingConfig, ...safeConfig };
```

### I-5: Route ordering — /test-connection must be declared before /:id/test (LOW)
**Location:** `routes.ts:207` vs `routes.ts:165`
The `/test-connection` route (line 207) is declared AFTER `/:id/test` (line 165). Express evaluates routes in declaration order. A request to `POST /api/log-sources/test-connection` will match `/:id` with `id = "test-connection"`, hitting the `/:id/test` handler first — which will attempt a Supabase lookup with `id = "test-connection"` and return 404. The `/test-connection` route is unreachable.

**Fix:** Move the `POST /test-connection` route declaration above the `POST /:id/test` route, or rename it to avoid the `:id` parameter conflict (e.g., `POST /test` at the router root).

## Auth Middleware Verification

**Q: Are routes mounted AFTER auth middleware in index.ts?**
YES. Auth middleware is at line 37 (`app.use("/api", ...)`), log source routes mounted at line 75 (`app.use("/api/log-sources", logSourceRoutes)`). Correct ordering.

## Error Handling Assessment

**Q: What happens if Supabase is down?**
All Supabase calls check for errors and return 500 with the error message. This is adequate. However, `getSupabase()` is called per-request — if the Supabase client itself throws on initialization, that would be an unhandled exception. This is a pre-existing pattern across the codebase, not specific to this phase.

**Q: What happens if adapter testConnection throws?**
See I-2 above — unhandled, will crash the request with an opaque 500.

## Bonus: Extra Endpoint Not in Plan
`GET /api/log-sources/platforms` (line 38) — returns registered adapter platforms. Not in the wiring checklist but useful for the frontend dropdown. Acceptable addition, but note the same route-ordering issue: this works because it's declared before any `/:id` routes.

## Summary

3 issues to fix before proceeding to Phase 5:
1. **I-5 (BLOCKING):** `/test-connection` route is unreachable due to `:id` parameter shadowing. Move it above `/:id` routes.
2. **I-2 (HIGH):** Add try/catch around `adapter.testConnection()` in both test endpoints.
3. **I-3 (MEDIUM):** Add user/repo ownership scoping to all log source routes.

1 issue to track for later:
4. **I-4 (LOW):** Strip `encrypted_api_token` from incoming config in PUT handler to prevent injection.
