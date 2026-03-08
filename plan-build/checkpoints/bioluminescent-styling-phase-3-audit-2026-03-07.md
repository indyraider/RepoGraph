# Phase 3 Audit: UI Chrome & Tooltip
**Date:** 2026-03-07
**Status:** PASS (with minor notes)

## Files Audited
- `packages/frontend/src/GraphExplorer.tsx` (1057 lines)
- `packages/frontend/src/Sidebar.tsx` (157 lines)
- `packages/frontend/src/index.css` (CSS variable definitions)

---

## Checklist Verification

### Top Bar
| Item | Status | Evidence |
|------|--------|----------|
| Background → `var(--bg-header)` | PASS | L643: `style={{ background: "var(--bg-header)" }}` |
| Border → `var(--border-subtle)` | PASS | L643: `borderBottom: "1px solid var(--border-subtle)"` |
| Violet accents → teal | PASS | L645: Network icon uses `var(--accent-primary)`. No violet/purple in top bar. |
| "Highlight Deps" toggle → teal styling | PASS | L663: active state uses `rgba(78, 205, 196, 0.1)` bg, `rgba(78, 205, 196, 0.3)` border, `var(--accent-primary)` text |
| Repo selector focus border → teal | PASS | L672: uses `input-focus-ring` class; CSS L128 defines focus ring as `rgba(78, 205, 196, 0.4)` |
| Node/edge count → monospace, `var(--text-secondary)` | PASS | L683: `font-mono` + `tabular-nums` + `color: "var(--text-secondary)"` |

### Filter Sidebar
| Item | Status | Evidence |
|------|--------|----------|
| Background → `var(--bg-surface)` | PASS | Uses `gradient-mesh-panel` class (CSS L169-173 resolves to `var(--bg-surface)`) |
| Color dots glow | PASS | L717: `boxShadow: \`0 0 6px ${NODE_COLORS[type]}80\`` when active |
| Section headers `var(--text-heading)` | PASS | L692: `color: "var(--text-heading)"` |
| Section header letter-spacing | PASS | L692: `letterSpacing: "0.1em"` |
| Counts `var(--text-secondary)` | PASS | L723: `color: "var(--text-secondary)"` |
| Hover teal wash | PASS | L708: `onMouseEnter` sets `rgba(78, 205, 196, 0.05)` background |

### Detail Panel
| Item | Status | Evidence |
|------|--------|----------|
| Background → `var(--bg-surface)` | PASS | L816: `background: "var(--bg-surface)"` |
| Border → `var(--border-subtle)` | PASS | L816: `borderLeft: "1px solid var(--border-subtle)"`. Internal borders (L826, L859, L906, L982) all use `var(--border-subtle)`. |
| Node name text-shadow glow | PASS | L838: `textShadow: \`0 0 10px ${NODE_COLORS[...]}40\`` |
| Section headers `var(--text-heading)` + letter-spacing | PASS | L860, L907, L983: `color: "var(--text-heading)"`, `letterSpacing: "0.1em"` |
| Property values `var(--text-code)` | PASS | L867: `color: "var(--text-code)"` |
| Relationship links teal | PASS | L916: outgoing arrow type label uses `var(--accent-primary)` |
| Arrow icons teal | PASS | L915: outgoing `ArrowRight` uses `var(--accent-primary)` |
| Incoming arrow icons | NOTE | L947: `ArrowLeft` uses `#38BDF8` (light blue) — spec says `text-emerald-400` can "stay or shift", so blue is an acceptable choice; not a violation |
| Source code viewer `var(--bg-recessed)` | PASS | L1002: `background: "var(--bg-recessed)"` |
| Line numbers `var(--text-dim)` | PASS | L1050: `color: "var(--text-dim)"` |
| Code text `var(--text-code)` | PASS | L1002: `color: "var(--text-code)"` |
| Highlighted lines teal tint | PASS | L1048: `background: "rgba(78, 205, 196, 0.08)"` replaces purple |
| Resize handle teal hover | PASS | L823: `onMouseEnter` sets `rgba(78, 205, 196, 0.3)` background |

### Nav Sidebar (Sidebar.tsx)
| Item | Status | Evidence |
|------|--------|----------|
| Background → `var(--bg-deep)` | PASS | L50: `background: "var(--bg-deep)"` |
| Border → `var(--border-subtle)` | PASS | L50, L53, L99: all use `var(--border-subtle)` |
| Active state teal | PASS | L82: `background: "rgba(78, 205, 196, 0.08)"`, `color: "#4ECDC4"`, `borderColor: "rgba(78, 205, 196, 0.2)"` |
| Logo teal gradient + text-shadow glow | PASS | L54: `linear-gradient(135deg, #4ECDC4, #0284C7)`, shadow `rgba(78, 205, 196, 0.25)`. L61: `textShadow: "0 0 15px rgba(78, 205, 196, 0.3)"` |
| Logout hover → keep red | PASS | L124: `hover:text-red-400 hover:bg-red-500/[0.06]` (semantic red preserved) |

### Loading Overlay
| Item | Status | Evidence |
|------|--------|----------|
| Teal spinner | PASS | L757: `color: "var(--accent-primary)"` on `Loader2` |

### Tooltip
| Item | Status | Evidence |
|------|--------|----------|
| DOM element with `pointer-events: none` | PASS | L780: `className="... pointer-events-none ..."` |
| Background `var(--bg-surface)` | PASS | L784: `background: "var(--bg-surface)"` |
| Border `var(--border-accent)` | PASS | L785: `border: "1px solid var(--border-accent)"` — resolves to `rgba(78, 205, 196, 0.3)` |
| Text-shadow glow on node name | PASS | L791: `textShadow: \`0 0 10px ${NODE_COLORS[...]}40\`` |
| Box-shadow | PASS | L787: `boxShadow: "0 4px 20px rgba(0, 0, 0, 0.5)"` |
| Positioned via tooltipState | PASS | L782-783: `left: tooltipState.x + 10`, `top: tooltipState.y + 10` |
| z-index above canvas | PASS | L780: `z-20` class |
| Wired to onNodeHover show/hide | PASS | L502-510: sets `tooltipState` on hover, clears to `null` on leave |
| Type badge + key properties | PASS | L793-807: type badge rendered, path/signature shown when available |

### No Remaining violet/purple in Scoped Files
| Item | Status | Evidence |
|------|--------|----------|
| GraphExplorer.tsx | PASS | `grep violet\|purple\|emerald` returns zero matches |
| Sidebar.tsx | PASS | `grep violet\|purple\|emerald` returns zero matches |

---

## Notes (Non-blocking)

1. **Hardcoded Tailwind grays in relationships section**: Lines 935, 939, 967, 971 in `GraphExplorer.tsx` use `text-gray-600` for relationship target/source labels and overflow counts. These work visually but bypass the CSS variable system. Consider migrating to `var(--text-dim)` or `var(--text-secondary)` for consistency.

2. **Violet/purple/emerald in OTHER files**: 40+ references remain in files outside Phase 3 scope (`AppShell.tsx`, `DashboardView.tsx`, `SettingsView.tsx`, `ActivityLogView.tsx`, `LoginPage.tsx`, `RuntimeLogsView.tsx`, temporal components, etc.). These are NOT in scope for Phase 3 but will need attention if a global theme sweep is planned (Phase 4 checklist item).

3. **Incoming arrow icon uses `#38BDF8`**: The incoming `ArrowLeft` and type label (L947-948) use `#38BDF8` (sky blue) rather than teal. The spec allowed `text-emerald-400` to "stay or shift", making this an acceptable design decision, not a defect.

---

## Verdict

**PASS** — All 32 Phase 3 checklist items verified. Both scoped files (GraphExplorer.tsx, Sidebar.tsx) are free of violet/purple/emerald Tailwind references. CSS variables are correctly defined and consumed. Tooltip is properly wired with pointer-events:none, correct positioning, and show/hide behavior.
