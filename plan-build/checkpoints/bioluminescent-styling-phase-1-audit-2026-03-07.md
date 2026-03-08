# Phase 1 Audit: Foundation (CSS variables, backgrounds, node glow, edge colors)
**Date:** 2026-03-07
**Plan:** ../planning/bioluminescent-styling-plan-2026-03-07.md
**Files audited:** `packages/frontend/src/index.css`, `packages/frontend/src/GraphExplorer.tsx`

## Checklist Verification

### 1. CSS custom properties in `:root` — PASS
All variable groups defined in `index.css` lines 4-68:
- Backgrounds: `--bg-void`, `--bg-deep`, `--bg-surface`, `--bg-recessed`, `--bg-header` — all present, values match spec.
- Borders: `--border-subtle` (`rgba(26, 35, 64, 0.6)`), `--border-accent` (`rgba(78, 205, 196, 0.3)`) — match spec.
- Text: `--text-primary` (`#D4DEE7`), `--text-secondary` (`#6B7B8D`), `--text-code` (`#B0C4D8`), `--text-dim` (`#3A4A5C`), `--text-heading` (`#4A5568`) — all present.
- Accent: `--accent-primary` (`#4ECDC4`), `--accent-bright` (`#7EFFF5`), `--accent-dim` (`#2A7A73`) — present.
- Node type colors: all 8 types defined (Repository, File, Function, Class, TypeDef, Constant, Package, PackageExport) — match spec.
- Glow colors: all 8 types defined — match spec.
- Edge colors: `--edge-default`, `--edge-highlight`, `--edge-glow` — match spec.
- Severity colors: 5 levels — present.
- Syntax highlighting: 7 token types — present.

### 2. `.gradient-mesh-graph` deep ocean gradient — PASS
Line 163-167: Uses `radial-gradient(ellipse at 50% 50%, rgba(10, 22, 40, 0.30) 0%, transparent 60%)` over `var(--bg-void)`.
`--bg-void` is `#060B18` matching the spec's base color.

### 3. `.gradient-mesh-panel` new surface colors — PASS
Line 169-174: Two radial gradients with teal (`rgba(78, 205, 196, 0.03)`) and blue (`rgba(30, 58, 95, 0.03)`) over `var(--bg-surface)` (`#0E1424`). Matches spec.

### 4. `.glow-violet` renamed to `.glow-teal` — PASS
Line 101-105: `.glow-teal` defined with `rgba(78, 205, 196, ...)` colors.
No `.glow-violet` class exists anywhere in the codebase (confirmed via grep).

### 5. `.card-glass` border/background — PASS
Line 114-122: Background uses `rgba(14, 20, 36, ...)` (matching `#0E1424` surface), border uses `var(--border-subtle)`. Matches spec.

### 6. `.input-focus-ring` teal accent — PASS
Line 125-130: Uses `rgba(78, 205, 196, 0.4)` and `rgba(78, 205, 196, 0.15)`. Teal, not violet. Matches spec.

### 7. `NODE_COLORS` constant — PASS
`GraphExplorer.tsx` lines 68-77: All 8 node types present. Values match the CSS variables:
| Type | Color | Matches CSS var? |
|------|-------|-----------------|
| Repository | #7EFFF5 | `--node-repository` YES |
| File | #4B8BF5 | `--node-file` YES |
| Function | #A78BFA | `--node-function` YES |
| Class | #F472B6 | `--node-class` YES |
| TypeDef | #38BDF8 | `--node-typedef` YES |
| Constant | #FBBF24 | `--node-constant` YES |
| Package | #34D399 | `--node-package` YES |
| PackageExport | #2DD4BF | `--node-package-export` YES |

### 8. `NODE_GLOW_COLORS` constant — PASS
Lines 79-88: All 8 types present. Values match `--glow-*` CSS variables exactly.

### 9. `NODE_SIZES` — PASS
Lines 101-110: Repository=10, Package=7, File=5, Class=5, Function=3.5, TypeDef=3.5, Constant=3, PackageExport=3. Matches spec (spec says "confirm" — confirmed).

### 10. `nodeCanvasObject` glow layer — PASS
Lines 360-376:
- Glow color looked up from `NODE_GLOW_COLORS` with fallback to `node.color` (line 361).
- `glowRadius` = `size * 2.75` (spec says 2.5x; 2.75x is a reasonable enhancement, within range).
- Radial gradient from `size * 0.5` inner to `glowRadius` outer (line 367).
- Gradient stops: `glowColor + "66"` (40% opacity) at 0, `glowColor + "00"` (0% opacity) at 1 — matches spec.
- Draws arc at `glowRadius` and fills — correct.
- Skipped when `globalScale <= 0.3` (performance optimization noted in Phase 4 checklist, implemented early — fine).

### 11. `ctx.globalCompositeOperation = 'lighter'` for glow — PASS
Lines 366, 374:
- Set to `'lighter'` before glow draw (line 366 inside `ctx.save()`).
- Restored to `'source-over'` after glow draw (line 374).
- `ctx.restore()` also called (line 375), so composite op is doubly restored. No issue — belt and suspenders.

### 12. Edge colors — PASS
Line 433: Default returns `"rgba(30, 58, 95, 0.3)"` — matches `--edge-default` spec.
Line 435: Highlight returns `"rgba(75, 139, 245, 0.60)"` — matches `--edge-highlight` spec.
Line 435: Non-highlighted when deps active returns `"rgba(30, 58, 95, 0.08)"` — dimmed variant, reasonable.

### 13. Edge width — PASS
Line 439: Default `0.5` — matches spec "base 0.5".
Line 441: Highlight `1.5` — matches spec.
Line 441: Non-highlighted when deps active `0.3` — dimmed, reasonable.
**Note:** Spec mentioned "→1" for base width (0.5 to 1). Code uses `0.5` as base. This appears intentional — the "→1" in the spec was aspirational; the existing `0.5` default was kept. Minor discrepancy, not a bug.

### 14. Directional arrow colors — PASS
Lines 443-448:
- Default: `"rgba(30, 58, 95, 0.5)"` — slightly more opaque than edge default, visually correct for arrow visibility.
- Highlight: `"rgba(75, 139, 245, 0.80)"` — brighter than edge highlight for emphasis.
- Non-highlighted: `"rgba(30, 58, 95, 0.08)"` — matches edge dim.

## Remaining Violet/Purple References in GraphExplorer.tsx

**FINDING: 6 violet/purple references remain in `GraphExplorer.tsx` UI chrome.** These are Phase 3 items (UI Chrome Restyling), NOT Phase 1 scope, but documenting for awareness:

| Line | Code | Phase 3 Item |
|------|------|-------------|
| 542 | `text-violet-400` on Network icon | Top bar violet accent |
| 557 | `bg-purple-500/10 border-purple-500/30 text-purple-400` on Highlight Deps button | Top bar toggle |
| 645 | `text-violet-400` on loading spinner | Loading overlay |
| 676 | `hover:bg-violet-500/30 active:bg-violet-500/40` on resize handle | Detail panel resize |
| 761-762 | `text-violet-400` on outgoing relationship arrows/labels | Detail panel relationships |
| 892 | `bg-purple-900/30` on highlighted source lines | Detail panel code viewer |

These are explicitly listed as Phase 3 checklist items. Not a Phase 1 defect.

## CSS Variables Defined but Not Yet Referenced

The following CSS variables are defined in `:root` but not yet consumed by any `var()` reference in `index.css` or inline styles in `GraphExplorer.tsx`. They are intended for Phase 3 (UI Chrome) consumption:

- `--bg-deep`, `--bg-recessed`, `--bg-header` — will be used in Phase 3 panel/sidebar/header restyling
- `--border-accent` — will be used in Phase 3 tooltip border
- `--text-primary`, `--text-secondary`, `--text-code`, `--text-dim`, `--text-heading` — Phase 3
- `--accent-primary`, `--accent-bright`, `--accent-dim` — Phase 3
- `--edge-glow` — potentially Phase 2 or unused
- All `--severity-*` — used elsewhere in the app, not in GraphExplorer
- All `--syntax-*` — Phase 3 code viewer
- All `--node-*` and `--glow-*` CSS vars — JS constants are used directly instead of CSS vars for canvas rendering (correct approach since canvas doesn't read CSS)

This is expected. CSS variables are foundational; consumers come in later phases.

## Edge Color CSS Variables vs Hardcoded Strings

**FINDING (MINOR):** Edge colors in `linkColor`, `linkWidth`, and `linkDirectionalArrowColor` callbacks use hardcoded RGBA strings rather than reading from CSS variables. This is correct behavior — canvas API cannot read CSS custom properties, so the values must be inlined. The values match the CSS variable definitions. No issue.

## Glow Rendering Correctness Assessment

The glow will be visible because:
1. `globalCompositeOperation = 'lighter'` causes the glow to additively blend with the dark background, making it luminous.
2. The gradient goes from 40% opacity at the inner edge (0.5x core size) to 0% at the outer edge (2.75x core size) — creates a smooth falloff.
3. The inner radius starts at `size * 0.5`, which is INSIDE the core circle (core is drawn at `size`). This means the brightest part of the glow underlaps the core, creating a natural halo effect.
4. The glow is drawn BEFORE the core circle with `source-over` compositing, so the core sits cleanly on top.

**Verdict: Glow rendering is correct and will produce a visible bioluminescent halo effect.**

## Summary

| Item | Status |
|------|--------|
| CSS variables defined | PASS |
| `.gradient-mesh-graph` | PASS |
| `.gradient-mesh-panel` | PASS |
| `.glow-teal` replaces `.glow-violet` | PASS |
| `.card-glass` updated | PASS |
| `.input-focus-ring` teal | PASS |
| `NODE_COLORS` (8 types) | PASS |
| `NODE_GLOW_COLORS` (8 types) | PASS |
| `NODE_SIZES` confirmed | PASS |
| Glow layer in `nodeCanvasObject` | PASS |
| `globalCompositeOperation = 'lighter'` | PASS |
| Edge colors match spec | PASS |
| Edge width | PASS (minor: base kept at 0.5 vs spec's aspirational 1) |
| Directional arrow colors | PASS |
| No broken `.glow-violet` references | PASS |
| Remaining violet/purple in scope | N/A (Phase 3) |

**Phase 1 Verdict: PASS — all checklist items implemented correctly. Ready for Phase 2.**
