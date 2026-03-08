# Forward Checkpoint: Bioluminescent Styling Phase 1
**Date:** 2026-03-07
**Phase completed:** Phase 1 — Foundation (CSS variables, backgrounds, node glow, edge colors)
**Files modified:** `index.css`, `GraphExplorer.tsx`

---

## 1. Actual CSS Variables Defined in `:root`

### Backgrounds
| Variable | Value |
|----------|-------|
| `--bg-void` | `#060B18` |
| `--bg-deep` | `#080D1A` |
| `--bg-surface` | `#0E1424` |
| `--bg-recessed` | `#080D1A` |
| `--bg-header` | `#0A1020` |

### Borders
| Variable | Value |
|----------|-------|
| `--border-subtle` | `rgba(26, 35, 64, 0.6)` |
| `--border-accent` | `rgba(78, 205, 196, 0.3)` |

### Text
| Variable | Value |
|----------|-------|
| `--text-primary` | `#D4DEE7` |
| `--text-secondary` | `#6B7B8D` |
| `--text-code` | `#B0C4D8` |
| `--text-dim` | `#3A4A5C` |
| `--text-heading` | `#4A5568` |

### Accent
| Variable | Value |
|----------|-------|
| `--accent-primary` | `#4ECDC4` |
| `--accent-bright` | `#7EFFF5` |
| `--accent-dim` | `#2A7A73` |

### Node/Glow/Edge colors, Severity, Syntax
All defined and matching the plan spec. Edge variables: `--edge-default`, `--edge-highlight`, `--edge-glow`.

### CSS Utilities Built
- `.glow-teal` (renamed from `.glow-violet`) -- teal box-shadow
- `.glow-blue` -- blue box-shadow (new)
- `.card-glass` -- uses `var(--border-subtle)`, `rgba(14, 20, 36, ...)` background
- `.input-focus-ring` -- teal `rgba(78, 205, 196, 0.4)` focus ring
- `.gradient-mesh-graph` -- `#060B18` base with `rgba(10, 22, 40, 0.30)` center glow
- `.gradient-mesh-panel` -- `var(--bg-surface)` base with teal and blue radial accents
- `.noise-overlay` / `.noise-overlay-strong` -- SVG noise pseudo-element

---

## 2. Actual JS Constants

### `NODE_COLORS` (line 68-77)
```
Repository: "#7EFFF5", File: "#4B8BF5", Function: "#A78BFA",
Class: "#F472B6", TypeDef: "#38BDF8", Constant: "#FBBF24",
Package: "#34D399", PackageExport: "#2DD4BF"
```
Matches CSS `--node-*` variables exactly.

### `NODE_GLOW_COLORS` (line 79-88)
```
Repository: "#4ECDC4", File: "#2E5FBF", Function: "#7C5FCF",
Class: "#DB2777", TypeDef: "#0284C7", Constant: "#D97706",
Package: "#059669", PackageExport: "#0D9488"
```
Matches CSS `--glow-*` variables exactly.

### `NODE_SIZES` (line 101-110)
Repository: 10, Package: 7, File: 5, Class: 5, Function: 3.5, TypeDef: 3.5, Constant: 3, PackageExport: 3. Matches plan.

---

## 3. `nodeCanvasObject` Rendering Structure (line 347-413)

Current execution order inside the callback:
1. Compute `baseSize`, `size` (scale-adjusted), `x`, `y`
2. Compute `dimmed` from `highlightDepsRef` (click-based dep highlighting)
3. Set `ctx.globalAlpha` based on `dimmed`
4. **Glow layer** (guarded by `globalScale > 0.3`):
   - `ctx.globalCompositeOperation = "lighter"`
   - Radial gradient from `glowColor+"66"` (40%) to `glowColor+"00"` (0%)
   - Fixed `glowRadius = size * 2.75`
   - Draws arc at `glowRadius`
   - Restores `"source-over"`
5. **Core circle**: solid fill at `node.color`
6. **Dep highlight stroke** (if active and not selected)
7. **Selection indicator**: white stroke, 1.5px
8. **Labels** at high zoom
9. Reset `ctx.globalAlpha = 1`

### Key variables available to Phase 2 in scope:
- `size` -- the computed core radius
- `glowRadius` -- currently `size * 2.75`
- `glowColor` -- from `NODE_GLOW_COLORS`
- `x`, `y` -- node position
- `isSelected` -- `selectedNodeIdRef.current === node.id`
- `globalScale` -- from force-graph
- `dimmed` -- from highlight deps system

---

## 4. Phase 2 Integration Analysis

### 4a. rAF Loop (`requestAnimationFrame` keep-alive)
**Plan:** Add `useEffect` with rAF loop calling `graphRef.current.refresh()`.
**Hook point:** New standalone `useEffect` after the mount `useEffect` (after line 476). No conflicts. `graphRef` is already a module-level ref. The mount effect sets `autoPauseRedraw(false)` (line 341), which is correct -- this prevents force-graph from skipping redraws but the sim still cools down and stops calling `nodeCanvasObject`. The rAF loop will force continuous redraws.
**Verdict: CLEAN -- no interface mismatch.**

### 4b. Breathing Animation (glow radius modulation)
**Plan:** Modulate `glowRadius` between `2.5x`-`3x` core size on sine wave with `performance.now()` and per-node phase offset via `hashCode(node.id)`.
**Hook point:** Line 362 where `glowRadius` is computed. Currently `const glowRadius = size * 2.75`. Phase 2 replaces this with:
```js
const phase = (hashCode(node.id) % 1000) / 1000 * Math.PI * 2;
const breathe = Math.sin(performance.now() / 1000 * (2 * Math.PI / 4) + phase);
const glowRadius = size * (2.75 + 0.25 * breathe); // oscillates 2.5-3.0
```
**Requirement:** A `hashCode(nodeId: string): number` utility function must be added. Not yet present.
**Verdict: CLEAN -- direct replacement of a single `const`. Need to add `hashCode` helper.**

### 4c. `hoveredNodeRef` and `hoveredNeighborsRef`
**Plan:** Add `useRef` state for hovered node and its neighbor set.
**Hook point:** New refs after `highlightedLinksRef` (line 151). No conflicts.
**Existing adjacency map:** `adjacencyRef.current.neighbors` already has the direct neighbor lookup needed for hover isolation (line 216-247). Phase 2 can read from it directly.
**Verdict: CLEAN.**

### 4d. `onNodeHover` Callback
**Plan:** Wire `.onNodeHover()` on the force-graph instance.
**Hook point:** In the mount `useEffect` chain (line 339-448), add `.onNodeHover(...)` to the builder chain. Must be added during initialization since force-graph is vanilla (not React). Place after `.onBackgroundClick()` (line 425).
**Interaction with existing click highlight:** Plan says hover takes visual priority. In `nodeCanvasObject`, hover check goes BEFORE the existing `dimmed` check. Currently `dimmed` is computed at line 355 from `highlightDepsRef`. Phase 2 will add a second alpha path: if `hoveredNodeRef.current` is set, non-neighbor nodes get alpha 0.2 regardless of dep highlight state.
**Verdict: CLEAN -- but requires reordering the alpha logic in `nodeCanvasObject`.**

### 4e. Selection Ring
**Plan:** Draw `#7EFFF5` circle at 2x core size, 1.5px, rotating angle from `performance.now() / 60000 * 2*PI`.
**Hook point:** Replace or augment the current selection indicator at lines 396-400. Currently draws a white stroke at core size. Phase 2 replaces this with a teal ring at `2 * size` radius with rotation.
**Note:** Current selection indicator is a simple `ctx.stroke()` after the core `ctx.arc()`. The ring needs its own `ctx.beginPath()` + `ctx.arc()` + rotation transform. This is a replacement, not an addition.
**Verdict: CLEAN -- direct replacement of lines 396-400.**

### 4f. Hover-Aware Edge Rendering
**Plan:** In `linkColor`/`linkWidth`, if `hoveredNodeRef.current` is set, brighten connected edges, dim others.
**Hook point:** `linkColor` callback at line 431, `linkWidth` at line 437. Currently these only check `highlightDepsRef`. Phase 2 adds a hover check before the deps check:
```js
if (hoveredNodeRef.current) {
  // check if link connects to hovered node
  // return bright or dim color accordingly
}
```
**Verdict: CLEAN -- additive logic at top of existing callbacks.**

---

## 5. Phase 3 Integration Analysis

### 5a. Top Bar Restyling
**Plan:** `bg-gray-900/60` -> `#0A1020`, `border-white/5` -> `rgba(26, 35, 64, 0.6)`, violet -> teal.
**Current (line 540):** `bg-gray-900/60 backdrop-blur-md` with `border-white/5`.
**CSS vars available:** `--bg-header: #0A1020`, `--border-subtle: rgba(26, 35, 64, 0.6)`.
**Match:** Plan references `#0A1020` which is `var(--bg-header)`. Plan references `rgba(26, 35, 64, 0.6)` which is `var(--border-subtle)`. Both exist.
**Verdict: CLEAN.**

### 5b. Highlight Deps Button
**Plan:** `bg-purple-500/10` -> `bg-[rgba(78,205,196,0.1)]`, `text-purple-400` -> teal.
**Current (line 557-558):** Still uses `bg-purple-500/10 border-purple-500/30 text-purple-400`.
**NOTE: Phase 1 did NOT restyle the Highlight Deps button.** The plan checklist has it under Phase 3 line items. This is expected -- Phase 1 only laid the foundation variables and canvas rendering. Phase 3 will swap these Tailwind classes.
**Verdict: EXPECTED GAP -- Phase 3 will handle. CSS vars exist for the replacement values.**

### 5c. Filter Sidebar
**Plan:** Background -> `#0E1424`, color dot glow, section headers `#4A5568`, counts `#6B7B8D`, hover state `rgba(78,205,196,0.05)`.
**Current (line 586):** Uses `bg-gray-900/40` and `gradient-mesh-panel`.
**CSS vars available:** `--bg-surface: #0E1424`, `--text-heading: #4A5568`, `--text-secondary: #6B7B8D`.
**Verdict: CLEAN -- all referenced values exist as CSS vars.**

### 5d. Detail Panel
**Plan:** Background `#0E1424`, borders `rgba(26, 35, 64, 0.6)`, node name text-shadow, section headers `#4A5568`, property values `#B0C4D8`, relationship links `#4ECDC4`, source viewer `#080D1A` bg, line numbers `#3A4A5C`, code text `#B0C4D8`, highlighted line `bg-[rgba(78,205,196,0.08)]`.
**CSS vars available:** All map directly: `--bg-surface`, `--border-subtle`, `--text-heading`, `--text-code`, `--accent-primary`, `--bg-recessed`, `--text-dim`.
**Highlighted line (line 892):** Currently `bg-purple-900/30`. Phase 3 replaces with teal tint.
**Verdict: CLEAN.**

### 5e. Resize Handle
**Plan:** `hover:bg-violet-500/30` -> teal.
**Current (line 676):** `hover:bg-violet-500/30 active:bg-violet-500/40`.
**Verdict: CLEAN -- straightforward class swap.**

### 5f. Sidebar (`Sidebar.tsx`)
**Plan references:** `Sidebar.tsx` for nav sidebar restyling (background `#080D1A`, active state teal, logo gradient teal).
**Note:** This file was NOT modified in Phase 1. Phase 3 will need to read and modify it.
**CSS vars available:** `--bg-deep: #080D1A`, `--accent-primary: #4ECDC4`, `--accent-bright: #7EFFF5`, `--border-accent: rgba(78, 205, 196, 0.3)`.
**Verdict: CLEAN -- vars exist, but Sidebar.tsx not yet touched.**

### 5g. Loading Overlay
**Current (line 645):** `text-violet-400` on the Loader2 spinner.
**Plan:** -> teal accent.
**Verdict: CLEAN -- simple class swap.**

### 5h. Tooltip
**Plan:** New absolute-positioned div, `pointer-events: none`, styled with `--bg-surface`, `--border-accent`, `--text-primary`.
**Hook point:** Inside the `.gradient-mesh-graph` container div (line 639), after the overlay divs. Phase 2 will have already set up `hoveredNodeRef` and `onNodeHover` with screen coords.
**Dependency chain:** Tooltip needs `hoveredNodeRef` (Phase 2) + screen coords from `graph2ScreenCoords` (Phase 2). Phase 3 therefore depends on Phase 2 for the data pipe, and Phase 1 for the CSS vars.
**Verdict: CLEAN -- but Phase 3 tooltip MUST run after Phase 2, not in parallel.**

---

## 6. Phase 4 Considerations

### 6a. Performance Guard
**Plan:** Skip glow layer when `globalScale < 0.3`.
**Current:** Already implemented at line 364: `if (globalScale > 0.3)`.
**Verdict: ALREADY DONE in Phase 1. Phase 4 can verify but doesn't need to add it.**

### 6b. Remaining Violet/Purple References
Grep needed at Phase 4. Current known remaining references in `GraphExplorer.tsx`:
- Line 542: `text-violet-400` on Network icon (top bar)
- Line 557: `bg-purple-500/10 border-purple-500/30 text-purple-400` (Highlight Deps button)
- Line 645: `text-violet-400` (loading spinner)
- Line 676: `hover:bg-violet-500/30 active:bg-violet-500/40` (resize handle)
- Line 761: `text-violet-400` (outgoing relationship arrow/label)
- Line 762: `text-violet-400` (outgoing relationship type label)
- Line 892: `bg-purple-900/30` (highlighted code line)

These are all deferred to Phase 3. Phase 4 verifies none remain.

---

## 7. Issues and Risks

### Issue 1: `hashCode` Utility Missing
**Severity:** LOW (blocks Phase 2 breathing animation only)
**Action:** Phase 2 must define a `hashCode(str: string): number` function before the component. Simple implementation:
```ts
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
```

### Issue 2: `autoPauseRedraw(false)` Already Set
**Severity:** INFO
**Note:** Line 341 already calls `.autoPauseRedraw(false)`. This is compatible with the rAF loop plan. The rAF loop provides the *trigger* for continuous redraws; `autoPauseRedraw(false)` ensures force-graph doesn't skip them. Both are needed.

### Issue 3: Selection Ring Replaces White Stroke
**Severity:** LOW
**Note:** Phase 2's teal selection ring at 2x core size replaces the current white stroke at core size (lines 396-400). The dep highlight stroke (lines 385-393) is a separate visual and should remain. Phase 2 must be careful to only replace the selection block, not the dep highlight block.

### Issue 4: Hover Alpha vs. Dep Highlight Alpha Ordering
**Severity:** MEDIUM
**Detail:** Currently `dimmed` is computed at line 355 from `highlightDepsRef`. Phase 2 adds hover-based dimming. The plan says hover takes priority. The `ctx.globalAlpha` assignment at line 358 must be restructured to check hover FIRST, then fall through to dep highlight. Suggested structure:
```ts
if (hoveredNodeRef.current) {
  ctx.globalAlpha = (node.id === hoveredNodeRef.current.id || hoveredNeighborsRef.current.has(node.id)) ? 1 : 0.2;
} else if (dimmed) {
  ctx.globalAlpha = 0.12;
} else {
  ctx.globalAlpha = 1;
}
```

### Issue 5: `graph2ScreenCoords` for Tooltip Positioning
**Severity:** LOW
**Detail:** Phase 2's `onNodeHover` handler needs to call `graphRef.current.graph2ScreenCoords(node.x, node.y)` and store the result for Phase 3's tooltip. Phase 2 should store screen coords in a ref (e.g., `tooltipCoordsRef`). Phase 3 then reads this ref to position the tooltip div. This handoff should be documented in Phase 2's implementation.

---

## 8. Summary

| Phase | Can Proceed? | Blockers |
|-------|-------------|----------|
| Phase 2 | YES | Add `hashCode` helper. Restructure alpha logic in `nodeCanvasObject`. |
| Phase 3 | YES (after Phase 2 for tooltip) | Tooltip depends on Phase 2's hover refs + screen coords. All other UI chrome items can proceed after Phase 1 alone. |
| Phase 4 | YES (after Phase 3) | Verification phase only. Glow performance guard already in place. |

**All CSS variables, JS constants, and canvas rendering hooks required by remaining phases are present and correctly defined. No naming mismatches found. No missing interfaces.**
