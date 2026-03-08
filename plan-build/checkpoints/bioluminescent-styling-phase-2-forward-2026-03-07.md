# Phase 2 Forward-Looking Checkpoint: Bioluminescent Styling
**Date:** 2026-03-07
**Phase completed:** Phase 2 — Interactions & Animation
**Next phases:** Phase 3 (UI Chrome & Tooltip), Phase 4 (Polish & Performance)

---

## 1. Exact Interface: `tooltipState`

**Declared at line 165 of `GraphExplorer.tsx`:**
```ts
const [tooltipState, setTooltipState] = useState<{ node: FGNode; x: number; y: number } | null>(null);
```

**Shape:** `{ node: FGNode; x: number; y: number } | null`

Where `FGNode` is (lines 42-48):
```ts
interface FGNode extends NodeObject {
  id: string;
  label: string;
  props: Record<string, unknown>;
  color: string;
  displayName: string;
}
```

**Set on hover** (line 505): `setTooltipState({ node, x: coords.x, y: coords.y })`
**Cleared on unhover** (line 510): `setTooltipState(null)`

### Phase 3 match check
The plan says (line 187): "Add tooltip DOM element: absolute-positioned div in graph container, `pointer-events: none`, `z-index: 20`"
- Plan expects to wire tooltip to `onNodeHover` — MATCHES. The `onNodeHover` handler already populates `tooltipState` with screen coords via `graph2ScreenCoords`.
- Plan expects tooltip content: node `displayName` (bold), type badge (small, colored), 2-3 key properties — ALL available on `tooltipState.node` (`node.displayName`, `node.label`, `node.color`, `node.props`).
- Plan expects tooltip positioning offset 10px right and 10px below cursor, clamp to viewport edges — `tooltipState.x` and `tooltipState.y` are **node position on screen** (not cursor position). Phase 3 should use these as the anchor point and apply the +10px offset from there. This is correct behavior (tooltip follows node, not cursor).

**VERDICT: Full match. No interface changes needed.**

---

## 2. Background Click and Hover State Clearing

**Current `onBackgroundClick` (line 480-485):**
```ts
.onBackgroundClick(() => {
  if (highlightDepsRef.current) {
    highlightedNodesRef.current = new Set();
    highlightedLinksRef.current = new Set();
  }
})
```

**Does Phase 3 need to clear hover state on background click?** NO.
- Hover state is already cleared automatically by the force-graph library: when the mouse leaves a node, `onNodeHover(null)` fires and clears `hoveredNodeRef`, `hoveredNeighborsRef`, `hoveredLinksRef`, and `tooltipState`.
- Background click does not need to clear hover state because hovering is mouse-enter/leave driven, not click driven.
- No modification to `onBackgroundClick` is needed for tooltip support.

---

## 3. Tailwind Class References in Phase 2 Code That Phase 3 Must Restyle

Phase 2 did not introduce any new Tailwind classes in the JSX. All Phase 2 work is in canvas rendering (JavaScript, not Tailwind). The Tailwind classes that Phase 3 must restyle are all pre-existing from Phase 1 or the original codebase.

---

## 4. "Highlight Deps" Toggle vs. Hover Logic Interaction

**Current coexistence logic (lines 370-383 of `nodeCanvasObject`):**
```
hover isolation checks → hover takes visual priority
dep highlight checks → secondary dimming
```

Priority order in `nodeCanvasObject`:
1. If `hoverActive && !isHovered && !isHoverNeighbor` => alpha = 0.2
2. Else if dep highlight active && node not highlighted => alpha = 0.12
3. Otherwise alpha = 1

**Phase 3 plan item:** Restyle "Highlight Deps" toggle from `bg-purple-500/10 border-purple-500/30 text-purple-400` to teal.

**Interaction risk:** NONE. The toggle restyling is purely a CSS class swap on the button element (line 658-662). It does not touch the canvas rendering logic. The hover/deps priority logic is fully implemented and tested in Phase 2. Phase 3 only changes the button's visual appearance.

---

## 5. Tooltip DOM Insertion Point

The tooltip must be inserted as a sibling to the canvas container div and overlay divs, inside the `gradient-mesh-graph` wrapper.

**Exact insertion point — line 768, just before the closing `</div>` of the graph canvas section:**

```
File: GraphExplorer.tsx
Line 742: <div className="flex-1 relative gradient-mesh-graph">
Line 744:   <div ref={containerRef} className="absolute inset-0" />   ← canvas
Line 746-767:   {loading && ...}  {error && ...}  {!loading && ...}   ← overlays
              ← INSERT TOOLTIP HERE
Line 768: </div>
```

**Recommended JSX:**
```tsx
{tooltipState && (
  <div
    className="absolute pointer-events-none z-20"
    style={{
      left: tooltipState.x + 10,
      top: tooltipState.y + 10,
    }}
  >
    {/* tooltip content */}
  </div>
)}
```

This placement ensures:
- The tooltip is inside the `relative` container for correct absolute positioning
- `z-20` sits above the canvas (`z-10` used by overlays)
- `pointer-events-none` prevents interference with force-graph hover detection

---

## 6. Violet/Purple Tailwind References — Complete Replacement List

### In `GraphExplorer.tsx`:

| Line | Current Class | Phase 3 Replacement |
|------|--------------|---------------------|
| 645 | `text-violet-400` (Network icon in top bar) | `text-[#4ECDC4]` |
| 660 | `bg-purple-500/10 border-purple-500/30 text-purple-400` (Highlight Deps active state) | `bg-[rgba(78,205,196,0.1)] border-[rgba(78,205,196,0.3)] text-[#4ECDC4]` |
| 748 | `text-violet-400` (loading spinner) | `text-[#4ECDC4]` |
| 779 | `hover:bg-violet-500/30 active:bg-violet-500/40` (resize handle) | `hover:bg-[rgba(78,205,196,0.3)] active:bg-[rgba(78,205,196,0.4)]` |
| 864 | `text-violet-400` (outgoing ArrowRight icon) | `text-[#4ECDC4]` |
| 865 | `text-violet-400` (outgoing relationship type label) | `text-[#4ECDC4]` |
| 995 | `bg-purple-900/30` (highlighted line range in code viewer) | `bg-[rgba(78,205,196,0.08)]` |

### In `Sidebar.tsx`:

| Line | Current Class | Phase 3 Replacement |
|------|--------------|---------------------|
| 53 | `from-violet-500 to-blue-600` (logo gradient) | `from-[#4ECDC4] to-[#38BDF8]` (teal-to-cyan) |
| 53 | `shadow-violet-500/20` (logo shadow) | `shadow-[rgba(78,205,196,0.2)]` |
| 74 | `bg-violet-500/10 text-violet-400 border-violet-500/20` (active nav item) | `bg-[rgba(78,205,196,0.08)] text-[#4ECDC4] border-[rgba(78,205,196,0.2)]` |

### Total: 10 violet/purple references across 2 files.

---

## 7. Additional Phase 3 Observations

### 7a. `onBackgroundClick` does NOT clear `selectedNode`
Background click only clears highlight deps state. The selected node (and detail panel) persist until the X button is clicked. Phase 3 should NOT change this behavior — it matches the plan's Flow 3 description.

### 7b. `hoveredLinksRef` is populated but not yet consumed for edge coloring by node type
The plan says connected edges should "brighten to **node color** at 60% opacity" but the current implementation uses a fixed `rgba(75, 139, 245, 0.60)` blue for all hovered edges regardless of the hovered node's type color. This is a minor deviation. Phase 3 or Phase 4 may want to address this by looking up `NODE_COLORS[hoveredNodeRef.current.label]` in the `linkColor` callback.

### 7c. `autoPauseRedraw(false)` is already set
Line 354 sets `autoPauseRedraw(false)`. Combined with the rAF loop (lines 571-579), this ensures continuous canvas redraws. Phase 3 does not need to modify the render loop.

### 7d. `graph2ScreenCoords` returns node-relative coordinates
The tooltip `x`/`y` values come from `graph2ScreenCoords(node.x, node.y)` which returns coordinates relative to the canvas container div. Since the tooltip will also be absolutely positioned within that same container (`gradient-mesh-graph`), the coordinates align correctly without any offset transformation.

### 7e. No `emerald-400` in the replacement list
Lines 895-896 use `text-emerald-400` for incoming relationship arrows and labels. The plan says (line 178): "text-emerald-400 stays or shifts." This is intentional — emerald is semantically distinct from violet (incoming vs outgoing direction). Phase 3 should leave `emerald-400` references as-is unless the builder explicitly decides to shift them.

---

## 8. Phase 4 Performance Checkpoint

Phase 2 already implemented the `globalScale > 0.3` guard for glow rendering (line 401), which is exactly what Phase 4's plan item says: "skip glow layer when `globalScale < 0.3`." This optimization is already in place.

Phase 4 still needs to:
- Test with 1000+ node graphs for frame rate
- Consider rAF throttling to every 2nd frame if needed
- Verify tooltip viewport edge-clamping (Phase 3 builds it, Phase 4 tests it)
- Do the final sweep for remaining violet/purple references (this document provides the exhaustive list)
