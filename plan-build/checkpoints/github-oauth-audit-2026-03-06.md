# GitHub OAuth Audit

**Date:** 2026-03-06
**Plan:** ../planning/github-oauth-plan-2026-03-06.md
**Verdict:** 1 BUG found, 2 WARNINGS, all security checks pass

---

## End-to-End Flow Trace

### Step 1: User visits /dashboard -> AppShell checks auth -> redirects to /login

**Status:** PASS

- `main.tsx` wraps all routes in `<AuthProvider>` (line 17-29)
- `AppShell.tsx` calls `useAuth()` and checks `status` (line 9)
- If `status === "loading"`, shows spinner (lines 12-17)
- If `status === "unauthenticated"`, renders `<Navigate to="/login" replace />` (lines 20-22)
- `/login` route is defined outside the `AppShell` layout route (line 19), so it renders independently

### Step 2: LoginPage renders "Sign in with GitHub" link -> verify URL construction

**Status:** PASS

- `LoginPage.tsx` calls `getGitHubAuthUrl()` from `api.ts` (line 46)
- `getGitHubAuthUrl()` in `api.ts` (lines 41-51) constructs the URL with:
  - `client_id` from `VITE_GITHUB_CLIENT_ID`
  - `redirect_uri` = `${VITE_API_URL}/api/auth/callback`
  - `scope` = `read:user`
- URL format: `https://github.com/login/oauth/authorize?client_id=...&redirect_uri=...&scope=read:user`
- LoginPage also checks if user is already authenticated and redirects to `/dashboard` (lines 14-18)

### Step 3: GitHub redirects to backend /api/auth/callback -> verify code exchange

**Status:** PASS

- `auth.ts` GET `/callback` (line 32) extracts `code` from query params
- Exchanges code for access token via POST to `https://github.com/login/oauth/access_token` (lines 41-52)
- Sends `client_id`, `client_secret`, `code` in JSON body
- Requests JSON response via `Accept: application/json` header
- Validates `access_token` exists in response (line 55)
- Fetches user profile from `https://api.github.com/user` with Bearer token (lines 62-67)
- Validates `user.id` exists (line 75)
- All error paths redirect to `/login?error=<reason>` on the frontend

### Step 4: Backend sets cookie -> verify cookie config

**Status:** PASS

- JWT payload contains `{githubId, login, name, avatarUrl}` (lines 82-87)
- JWT signed with `config.sessionSecret`, expires in 7 days (line 89)
- Cookie set with correct security config (lines 92-98):
  - `httpOnly: true` -- prevents XSS token theft
  - `secure: true` -- HTTPS only
  - `sameSite: "none"` -- required for cross-origin (Vercel frontend -> Railway backend)
  - `maxAge: 7 days`
  - `path: "/"`
- Cookie name: `repograph_session`

### Step 5: Backend redirects to frontend -> verify redirect URL

**Status:** PASS

- Redirects to `${config.frontendUrl}/dashboard` (line 100)
- `config.frontendUrl` sourced from `FRONTEND_URL` env var, defaults to `http://localhost:5173` (config.ts line 27)

### Step 6: Frontend loads -> AuthProvider calls /api/auth/me -> verify cookie sent

**Status:** PASS

- `AuthProvider.tsx` calls `getMe()` on mount via `useEffect` (lines 24-33)
- `getMe()` in `api.ts` (lines 28-32) uses `authedFetch()` which includes `credentials: "include"` (line 16)
- Cookie is sent automatically by the browser with `credentials: "include"`

### Step 7: Auth middleware validates JWT -> verify middleware logic

**Status:** PASS

- `index.ts` middleware at line 33 handles all `/api` routes
- Skips auth for `/health`, `/webhooks/*`, and `/auth/*` (line 36)
- Checks JWT cookie first (lines 41-49): verifies with `config.sessionSecret`, attaches `req.user`
- Falls through to API key check if cookie is invalid (lines 52-58)
- Dev mode fallback: if neither `apiKey` nor `githubClientId` configured, allows all (lines 61-63)
- Returns 401 if all checks fail (line 66)

### Step 8: Sidebar shows user avatar -> verify data flow

**Status:** PASS

- `Sidebar.tsx` calls `useAuth()` to get `user` and `logout` (line 24)
- Renders avatar from `user.avatar_url` (line 93)
- Displays `user.name || user.login` and `@{user.login}` (lines 103-105)
- Logout button calls `logout` from auth context (line 112)
- `AuthProvider.logout()` calls `apiLogout()` then clears local state (lines 35-39)

---

## Security Checks

| Check | Result | Detail |
|-------|--------|--------|
| client_secret server-side only | PASS | `GITHUB_CLIENT_SECRET` only in backend `config.ts` and `auth.ts`. Grep of frontend directory returns zero matches. |
| Cookies httpOnly | PASS | `httpOnly: true` on both set (auth.ts:93) and clear (auth.ts:131) |
| JWT signature verified with secret | PASS | `jwt.verify(token, config.sessionSecret)` in auth.ts:116 and index.ts:44 |
| Auth middleware gates non-public routes | PASS | All `/api` routes pass through middleware (index.ts:33). Public exceptions: `/health`, `/webhooks/*`, `/auth/*` |
| API key auth works alongside cookie | PASS | Middleware checks cookie first, then falls through to API key (index.ts:52-58) |
| sessionSecret has safe default | WARNING | Default is `"dev-secret-change-me"` (config.ts:26). Acceptable for local dev but must be overridden in production. |

---

## Broken Chain Analysis

### Does every fetch() in api.ts include credentials: "include"?

**BUG FOUND -- `getFileContent()` at api.ts line 210 uses raw `fetch()` instead of `authedFetch()`**

```typescript
// Line 210-213 -- BROKEN: missing credentials: "include"
const res = await fetch(
  `${API_BASE}/graph/${repoId}/file-content?path=${encodeURIComponent(filePath)}`,
  { headers: authHeaders() }
);
```

This will fail with a 401 in production because the session cookie will not be sent. The fix is to replace `fetch(` with `authedFetch(` on line 210.

All other data-fetching functions correctly use `authedFetch()`.

### Does LoginPage properly construct the GitHub authorize URL?

**PASS** -- `getGitHubAuthUrl()` constructs the URL with `client_id`, `redirect_uri`, and `scope` via `URLSearchParams`. The `redirect_uri` points to the backend callback route.

### Does logout clear the cookie AND the frontend state?

**PASS** -- Backend `POST /api/auth/logout` clears the cookie with `res.clearCookie()` using matching options (auth.ts:130-136). Frontend `AuthProvider.logout()` calls the API then sets `user = null` and `status = "unauthenticated"` (AuthProvider.tsx:35-39). AppShell will then redirect to `/login`.

---

## Dependency Check (backend package.json)

| Package | Listed | Type |
|---------|--------|------|
| jsonwebtoken | ^9.0.3 | dependency |
| cookie-parser | ^1.4.7 | dependency |
| @types/jsonwebtoken | ^9.0.10 | devDependency |
| @types/cookie-parser | ^1.4.10 | devDependency |

All required dependencies are present.

---

## Warnings

### WARNING 1: Dev-mode auth bypass

`index.ts` line 61-63: If neither `config.apiKey` nor `config.githubClientId` is set, all requests are allowed without auth. This is intentional for local development but must never occur in production. Ensure `GITHUB_CLIENT_ID` is always set in Railway.

### WARNING 2: Backend URL derivation in auth.ts

`getBackendUrl()` (auth.ts:140-147) uses `RAILWAY_PUBLIC_DOMAIN` env var to build the redirect_uri. If this env var is missing in production, it falls back to `localhost`, which would break the OAuth callback. Verify this var is automatically set by Railway (it is -- Railway injects it by default).

---

## Summary of Required Fixes

| # | Severity | File | Line | Issue |
|---|----------|------|------|-------|
| 1 | **BUG** | packages/frontend/src/api.ts | 210 | `getFileContent()` uses raw `fetch()` instead of `authedFetch()` -- cookie not sent, will 401 in production |
| 2 | WARNING | packages/backend/src/config.ts | 26 | `sessionSecret` default is a placeholder -- must be overridden via `SESSION_SECRET` env var in production |
| 3 | WARNING | packages/backend/src/index.ts | 61-63 | Dev-mode bypass allows unauthenticated access when no auth is configured -- verify prod env vars are set |
