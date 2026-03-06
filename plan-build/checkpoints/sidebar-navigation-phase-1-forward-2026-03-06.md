# Forward Planning Checkpoint: Phase 1 -> Phase 2

**Date:** 2026-03-06
**Phase Completed:** Phase 1 (Infrastructure & Shell)
**Next Phase:** Phase 2 (Extract DashboardView)
**Remaining:** Phase 3 (Activity Log & Settings), Phase 4 (Polish)

---

## 1. Interface Extraction: What Phase 1 Actually Built

### main.tsx (Router & Route Config)

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/main.tsx
```

**Route table (lines 16-23):**

| Path | Component | Load Strategy |
|------|-----------|---------------|
| `/` (index) | `<Navigate to="/dashboard" replace />` | Redirect |
| `/dashboard` | `DashboardView` | `lazy(() => import("./views/DashboardView"))` |
| `/explore` | `GraphExplorer` | `lazy(() => import("./GraphExplorer"))` |
| `/activity` | `ActivityLogView` | `lazy(() => import("./views/ActivityLogView"))` |
| `/settings` | `SettingsView` | `lazy(() => import("./views/SettingsView"))` |
| `*` (catch-all) | `<Navigate to="/dashboard" replace />` | Redirect |

All views are lazy-loaded and wrapped in `<AppShell>` as a layout route.

**Key detail:** All lazy imports expect **default exports** from their respective modules. This is critical -- any replacement file must use `export default`.

### AppShell.tsx (Layout Wrapper)

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/AppShell.tsx
Export: export default function AppShell()
Props: None
```

**Layout structure (lines 8-31):**
```
div.h-screen.bg-gray-950.text-gray-100.flex.overflow-hidden
  div (absolute top accent line)
  <Sidebar />
  main.flex-1.overflow-hidden
    <ErrorBoundary>
      <Suspense fallback={spinner}>
        <Outlet />        <-- routed view renders here
      </Suspense>
    </ErrorBoundary>
```

**Key details:**
- Sidebar is a direct sibling of `<main>`, both inside a flex container.
- ErrorBoundary wraps the Outlet, so any view crash is caught at this level.
- Suspense fallback is a centered spinner with "Loading..." text.
- The `<main>` element has `overflow-hidden` -- views must manage their own scrolling.

### Sidebar.tsx (Navigation)

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/Sidebar.tsx
Export: export default function Sidebar()
Props: None (reads route via NavLink's isActive)
```

**Nav items (lines 12-17):**
```ts
const NAV_ITEMS = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/explore", icon: Network, label: "Explore Graph" },
  { to: "/activity", icon: Activity, label: "Activity Log" },
  { to: "/settings", icon: Settings, label: "Settings" },
] as const;
```

**Collapse behavior (lines 22-36):**
- State initialized from `localStorage.getItem("repograph-sidebar-collapsed")` -- defaults to `true` (collapsed) unless stored value is exactly `"false"`.
- Persisted to localStorage on every change via `useEffect`.
- Collapsed width: `w-[60px]`. Expanded width: `w-[220px]`.
- CSS transition: `transition-[width] duration-200 ease-in-out`.
- Toggle button at bottom of sidebar.

**NOTE:** The plan's Phase 4 says "CSS transitions for sidebar. localStorage persistence." -- both are **already implemented** in Phase 1. Phase 4 scope is reduced.

### ErrorBoundary.tsx

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/components/ErrorBoundary.tsx
Export: export class ErrorBoundary (named export, NOT default)
```

**Props interface (line 4-5):**
```ts
{ children: ReactNode; fallback?: (error: Error) => ReactNode }
```

**State:** `{ error: Error | null }`

**Behavior:** Renders `this.props.fallback?.(error)` if provided, otherwise renders a default red error card with icon, title, message, and stack trace. Logs to `console.error("[ErrorBoundary]", error, info)`.

**Key detail:** This is a **named export** (`export class ErrorBoundary`), not a default export. AppShell imports it correctly as `import { ErrorBoundary } from "./components/ErrorBoundary"` (line 5).

### DashboardView.tsx (Placeholder)

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/views/DashboardView.tsx
Export: export default function DashboardView()
Props: None
```

Renders a centered placeholder: "Dashboard -- will be wired in Phase 2".

### ActivityLogView.tsx (Placeholder)

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/views/ActivityLogView.tsx
Export: export default function ActivityLogView()
Props: None
```

Renders a centered placeholder: "Activity Log -- will be built in Phase 3".

### SettingsView.tsx (Placeholder)

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/views/SettingsView.tsx
Export: export default function SettingsView()
Props: None
```

Renders a centered placeholder: "Settings -- will be built in Phase 3".

---

## 2. Mismatch Detection: Plan vs. Reality

### MISMATCH 1: GraphExplorer `onBack` prop -- will crash silently, not loudly

**Plan says (Phase 2):** "Remove `onBack` prop and the Back button from GraphExplorer."

**Current state (GraphExplorer.tsx line 109-113):**
```ts
export default function GraphExplorer({
  onBack,
}: {
  onBack?: () => void;
}) {
```

The prop is already **optional** (`onBack?`). The Back button at **line 482-488** calls `onClick={onBack}` unconditionally:
```tsx
<button
  onClick={onBack}
  className="inline-flex items-center gap-1.5 text-gray-400 hover:text-white ..."
>
  <ArrowLeft className="w-4 h-4" />
  Back
</button>
```

**Impact:** Since `main.tsx` renders `<GraphExplorer />` with no props (line 19), `onBack` is `undefined`. Clicking the Back button calls `onClick={undefined}`, which is a no-op in React -- it will **not crash**, but the button is **dead UI**. It renders, looks clickable, and does nothing. This is not a runtime error but is a UX bug.

**Required fix in Phase 2:** Remove the Back button entirely (lines 482-488) and the `onBack` prop. Navigation is handled by the sidebar. The divider line at line 489 (`<div className="w-px h-5 bg-white/10" />`) should also be removed.

### MISMATCH 2: GraphExplorer assumes full viewport height

**GraphExplorer.tsx line 475:**
```tsx
<div className="h-screen bg-gray-950 text-gray-100 flex flex-col overflow-hidden">
```

GraphExplorer uses `h-screen` (100vh), but it now renders inside AppShell's `<main className="flex-1 overflow-hidden">`. The `h-screen` will cause the GraphExplorer to be taller than its container, since the container is `flex-1` (viewport minus sidebar height -- though sidebar is horizontal so this is actually fine width-wise). However, `h-screen` on a flex child inside a `h-screen` parent should resolve correctly because `overflow-hidden` on `<main>` will clip it.

**Verdict:** This works but is fragile. GraphExplorer should ideally use `h-full` instead of `h-screen` to correctly fill its parent. Phase 2 should change line 475 from `h-screen` to `h-full`.

### MISMATCH 3: GraphExplorer renders its own top accent line

**GraphExplorer.tsx line 477:**
```tsx
<div className="h-px bg-gradient-to-r from-transparent via-violet-500/40 to-transparent" />
```

AppShell already renders the same accent line at **line 11**. When viewing GraphExplorer, there will be **two accent lines** -- one from AppShell (absolute positioned, z-50) and one from GraphExplorer (in flow). The AppShell one is `absolute top-0` with `z-50`, so it floats above everything. GraphExplorer's is `position: static` and takes up 1px of vertical space inside the flex column.

**Required fix in Phase 2:** Remove the accent line from GraphExplorer (line 477).

### MISMATCH 4: McpPanel extraction -- no file path exists yet

**Plan says (Phase 2):** "Extract McpPanel to `src/components/McpPanel.tsx`."

**Current state:** McpPanel is defined at App.tsx lines 343-410 as a local function. No `src/components/McpPanel.tsx` file exists yet. Phase 2 must create it.

**McpPanel interface (App.tsx line 343):**
```ts
function McpPanel()  // No props, no exports
```

McpPanel is self-contained: it generates a hardcoded JSON config string and provides a copy button. It depends only on `useState` from React and `Network`, `Copy`, `Check` from lucide-react.

**Phase 2 must:** Create `/packages/frontend/src/components/McpPanel.tsx` with `export default function McpPanel()` (default export for consistency, or named export -- either works since DashboardView will import it directly).

### MISMATCH 5: CopyButton and StatusBadge extraction unclear

**Plan says:** "Extract CopyButton and StatusBadge if needed by other views."

**Current state:**
- `CopyButton` (App.tsx lines 75-91): Takes `{ text: string }` prop. Used inside SyncPanel and McpPanel.
- `StatusBadge` (App.tsx lines 93-106): Takes `{ connected: boolean; label: string }`. Used in the dashboard header for health badges.

**Phase 3 impact:** SettingsView needs to display connection status (plan says "Display connection status (Neo4j, Supabase)"), which means it will need `StatusBadge` or an equivalent. If StatusBadge is extracted to a shared component in Phase 2, Phase 3 can reuse it. If not, Phase 3 will need to duplicate or extract it.

**Recommendation:** Extract both to `src/components/` in Phase 2 since McpPanel (and by extension SyncPanel inside DashboardView) uses CopyButton, and SettingsView will need StatusBadge.

### MISMATCH 6: App.tsx still imports and lazy-loads GraphExplorer

**App.tsx line 44:**
```ts
const GraphExplorer = lazy(() => import("./GraphExplorer"));
```

After Phase 2 guts App.tsx, this import and the entire `view === "explore"` branch (lines 438-451) become dead code. Phase 2 must remove it. The router in main.tsx now handles GraphExplorer loading.

### FINDING: Phase 4 scope is reduced

The plan assigns "CSS transitions for sidebar" and "localStorage persistence" to Phase 4. Both are **already implemented** in Phase 1:
- CSS transition: Sidebar.tsx line 40 (`transition-[width] duration-200 ease-in-out`)
- localStorage: Sidebar.tsx lines 22-36 (`STORAGE_KEY = "repograph-sidebar-collapsed"`)

Phase 4 reduces to: final styling pass, dead code removal, route testing.

---

## 3. Hook Points for Phase 2

### 3A. DashboardView replacement

**What Phase 2 must do:** Replace the placeholder in `src/views/DashboardView.tsx` with the full dashboard extracted from App.tsx.

**Contract to satisfy:**
- File path: `/packages/frontend/src/views/DashboardView.tsx`
- Must be a **default export**: `export default function DashboardView()`
- Must accept **no props** (self-contained, fetches its own data)
- Must manage its own scrolling (parent `<main>` has `overflow-hidden`)

**What to extract from App.tsx:**
- All state (lines 413-422): `health`, `repos`, `url`, `branch`, `digesting`, `error`, `errorCode`, `success`, `expandedRepo`
- All handlers: `refreshRepos` (424-431), `handleDigest` (453-474), `handleDelete` (476-483), `handleReDigest` (485-504)
- `useEffect` for initial load (433-436)
- All JSX from the `return` statement (506-770), minus the `view === "explore"` branch
- Local components: `CopyButton`, `StatusBadge`, `SyncPanel`, `McpPanel` (either inline or imported from extracted files)

**Imports needed from api.ts:**
- `checkHealth`, `startDigest`, `getRepositories`, `deleteRepository`, `updateSyncMode`, `getSyncEvents`
- Types: `Repository`, `HealthStatus`, `SyncEvent`

### 3B. McpPanel extraction

**Target file:** `/packages/frontend/src/components/McpPanel.tsx`
**Export:** `export default function McpPanel()` (no props)
**Dependencies:** `useState` from React, `Network`, `Copy`, `Check` from lucide-react
**Source:** App.tsx lines 343-410

### 3C. GraphExplorer modifications

**File:** `/packages/frontend/src/GraphExplorer.tsx`

Changes needed:
1. **Remove `onBack` prop** (line 109-113): Change signature to `export default function GraphExplorer()`
2. **Remove Back button** (lines 482-488): Delete the button and the divider on line 489
3. **Remove `ArrowLeft` import** (line 14): No longer needed
4. **Change `h-screen` to `h-full`** (line 475): Correct sizing inside AppShell's flex layout
5. **Remove top accent line** (line 477): Already provided by AppShell

### 3D. App.tsx disposition

**Phase 2 must decide:** gut App.tsx or remove it entirely.

**Current state:** `main.tsx` does NOT import App.tsx. The router goes `BrowserRouter > Routes > Route(AppShell) > child routes`. App.tsx is **already dead code** as of Phase 1. Nothing imports it.

**Recommendation:** Delete `src/App.tsx` in Phase 2 after extracting all components. Also delete `src/App.css` if it exists and is only used by App.tsx.

### 3E. Import verification for App.css

App.tsx line 45: `import "./App.css"`. If DashboardView uses any classes defined in App.css (e.g., `card-glass`, `input-focus-ring`, `animate-pulse-soft`), those must either:
1. Be moved to `index.css`, or
2. Be imported by DashboardView directly

**Checking App.css dependency:** The classes `card-glass`, `input-focus-ring`, and `animate-pulse-soft` are used throughout App.tsx's JSX. Phase 2 must ensure these CSS classes are available to DashboardView.

---

## 4. Phase 2 -> Phase 3 Dependency Chain

Phase 3 views (ActivityLogView, SettingsView) will need:

| Dependency | Source | Available After Phase 2? |
|-----------|--------|--------------------------|
| `getRepositories()` | api.ts | Yes (already exists) |
| `getSyncEvents(repoId)` | api.ts | Yes (already exists) |
| `checkHealth()` | api.ts | Yes (already exists) |
| `StatusBadge` component | Needs extraction | Only if Phase 2 extracts it |
| `McpPanel` component | Phase 2 creates it | Yes |
| `Repository` type | api.ts | Yes (already exists) |
| `HealthStatus` type | api.ts | Yes (already exists) |
| `SyncEvent` type | api.ts | Yes (already exists) |

Phase 3 placeholder files already exist at the correct paths with correct default exports. Phase 3 only needs to replace the placeholder JSX with real implementations.

---

## 5. Summary of Required Actions

### Phase 2 must do:
1. **Replace** `src/views/DashboardView.tsx` placeholder with full dashboard extracted from App.tsx
2. **Create** `src/components/McpPanel.tsx` (extracted from App.tsx lines 343-410)
3. **Extract** `CopyButton` and `StatusBadge` to shared components (recommended for Phase 3 reuse)
4. **Modify** `src/GraphExplorer.tsx`: remove `onBack` prop, Back button, accent line; change `h-screen` to `h-full`
5. **Delete** `src/App.tsx` and `src/App.css` (dead code after extraction)
6. **Verify** CSS classes (`card-glass`, `input-focus-ring`, `animate-pulse-soft`) are in `index.css` or otherwise available

### Phase 2 must NOT do (deferred to later phases):
- Build ActivityLogView (Phase 3)
- Build SettingsView (Phase 3)
- Final styling pass (Phase 4)

### Risks:
- **LOW:** GraphExplorer's `h-screen` inside flex layout works due to `overflow-hidden` on parent, but is technically incorrect. Fix is trivial.
- **LOW:** Dead Back button in GraphExplorer is a UX annoyance, not a crash. Fix is part of Phase 2.
- **NONE:** All placeholder files exist at correct paths with correct export signatures. Phase 2 and 3 can drop in replacements without touching router config.
