# Build Plan: Bioluminescent Deep-Sea Restyling
**Created:** 2026-03-07
**Brainstorm:** ../brainstorm/bioluminescent-styling-brainstorm-2026-03-07.md
**Status:** Draft

## Overview
Restyle the RepoGraph graph explorer with a bioluminescent deep-sea organism aesthetic. Replace the current violet-accented dark theme with an organic, teal-accented deep ocean look. Nodes glow and breathe, edges are luminous filaments, hover isolates neighborhoods, and all UI chrome shifts to match.

## Component Inventory

| # | Component | File(s) | Inputs | Outputs | Dependencies |
|---|-----------|---------|--------|---------|--------------|
| 1 | CSS Variables & Theme | `index.css` | Design spec | All components | None |
| 2 | Node Color Palette | `GraphExplorer.tsx` L68-98 | Design spec | Canvas render, sidebar, detail panel | None |
| 3 | Background & Canvas | `index.css` + `GraphExplorer.tsx` | CSS vars | Canvas container visuals | Phase 1 |
| 4 | Node Glow Rendering | `GraphExplorer.tsx` nodeCanvasObject | Colors, sizes, Canvas API | Glowing nodes on canvas | Phase 1 |
| 5 | Breathing Animation | `GraphExplorer.tsx` nodeCanvasObject | `performance.now()`, random phase seeds | Glow radius modulation | Phase 2, render loop fix |
| 6 | Render Loop Keep-Alive | `GraphExplorer.tsx` useEffect | `requestAnimationFrame` | Continuous canvas redraws | Phase 2 |
| 7 | Edge Filament Rendering | `GraphExplorer.tsx` link config | Edge data, highlight state | Luminous edges on canvas | Phase 1 |
| 8 | Hover Neighborhood Isolation | `GraphExplorer.tsx` | `onNodeHover`, adjacency maps | Dimmed non-neighbors, brightened connections | Phase 2 |
| 9 | Selection Ring | `GraphExplorer.tsx` nodeCanvasObject | Selected node state, animation time | Rotating teal ring on canvas | Phase 2 |
| 10 | Hover Tooltip (DOM) | `GraphExplorer.tsx` | `onNodeHover`, `graph2ScreenCoords` | Positioned React div | Phase 3 |
| 11 | UI Chrome Restyling | `GraphExplorer.tsx`, `Sidebar.tsx`, `index.css` | CSS vars | Updated panels, bars, sidebar | Phase 1 |
| 12 | Detail Panel Refinements | `GraphExplorer.tsx` detail panel JSX | CSS vars, node colors | Glowing text, teal links, code viewer colors | Phase 3 |

## Integration Contracts

### CSS Variables → All Components
```
:root CSS custom properties → consumed via var() in index.css utilities
                            → consumed via inline styles in GraphExplorer.tsx
What flows: Color values (hex, rgba)
How: CSS custom properties, referenced in Tailwind arbitrary values and inline styles
Error path: Missing variable = transparent/inherit fallback (CSS default)
```

### Node Colors → Canvas Renderer
```
NODE_COLORS + NODE_GLOW_COLORS constants → nodeCanvasObject callback
What flows: Core color string, glow color string per node type
How: Direct object lookup by node.label
Error path: Fallback color "#6b7280" already exists
```

### onNodeHover → Tooltip + Neighborhood Isolation
```
force-graph onNodeHover(node, prevNode) → sets hoveredNode state + hoveredNeighbors set
What flows: FGNode | null
How: force-graph callback → React setState → re-render tooltip div + modulate node/edge alpha
Auth/Config: None
Error path: null node = clear hover state (tooltip hides, all nodes restore full alpha)
```

### graph2ScreenCoords → Tooltip Position
```
graphRef.current.graph2ScreenCoords(node.x, node.y) → tooltip left/top
What flows: {x: number, y: number} screen coordinates
How: force-graph API call inside onNodeHover handler
Error path: If coords undefined, hide tooltip
```

### requestAnimationFrame → Canvas Redraw (Breathing)
```
rAF loop → graphRef.current.refresh() every frame
What flows: Trigger to re-execute nodeCanvasObject
How: useEffect with rAF loop, cleanup on unmount
Error path: If graphRef.current null, skip. Loop self-terminates on unmount.
```

## End-to-End Flows

### Flow 1: User Opens Graph Explorer
1. Page loads → CSS variables applied from `:root` in `index.css`
2. `GraphExplorer` mounts → force-graph initialized with `backgroundColor("transparent")`
3. Canvas container has `.gradient-mesh-graph` with deep ocean radial gradient → `#060B18` base
4. Graph data loads → nodes rendered with two-layer glow (halo + core) via `nodeCanvasObject`
5. Edges rendered as luminous filaments via `linkColor`/`linkWidth` (dark blue, thin)
6. rAF loop starts → breathing animation pulses glow radius on sine wave
7. Left sidebar shows node type filters with glowing color dots on `#0E1424` background
8. Top bar shows controls on `#0A1020` background with teal accents

### Flow 2: User Hovers a Node
1. Mouse enters node hit area → `onNodeHover(node)` fires
2. Handler sets `hoveredNodeRef.current = node`
3. Handler computes `hoveredNeighborsRef.current` from adjacency maps (direct neighbors only)
4. Handler calls `graph2ScreenCoords(node.x, node.y)` → positions tooltip div
5. `nodeCanvasObject` reads hover state:
   - Hovered node: glow radius 4x, opacity 60%
   - Neighbor nodes: normal rendering
   - All other nodes: alpha 0.2
6. `linkColor`/`linkWidth` reads hover state:
   - Connected edges: brighten to node color at 60% opacity, width 1.5px
   - All other edges: dim to 10% opacity
7. Tooltip div renders with node name, type badge, key properties
8. Mouse leaves → `onNodeHover(null)` → clear hover state, hide tooltip, restore all alphas

### Flow 3: User Clicks a Node
1. Click fires `onNodeClick(node)` (existing behavior)
2. Sets `selectedNode` state, `selectedNodeIdRef`
3. `nodeCanvasObject` draws selection ring: thin `#7EFFF5` circle at 2x core size, slowly rotating (angle from `performance.now()`)
4. Selected node glow intensifies (brighter, persists unlike hover)
5. Detail panel opens with `#0E1424` background
6. Node name gets `text-shadow` glow in node's type color
7. Relationships use `#4ECDC4` teal for link color
8. Source code viewer uses `#080D1A` background, dim line numbers

### Error Flow: force-graph Destroyed During Animation
1. Component unmounts → useEffect cleanup runs
2. rAF loop checks `graphRef.current` → null → stops loop
3. force-graph `_destructor()` called (existing behavior)
4. No dangling animations or state updates

## Issues Found

### Issue 1: Render Loop After Cooldown (CRITICAL)
**Problem:** force-graph stops calling `nodeCanvasObject` after the physics simulation cools down. The breathing animation needs continuous redraws.
**Solution:** Add a `requestAnimationFrame` loop in a `useEffect` that calls `graphRef.current.refresh()` (or `.tickFrame()`) every frame. This is cheap — it just re-renders, doesn't re-simulate physics. Clean up with `cancelAnimationFrame` on unmount.
**Wire:** `useEffect` → `rAF` loop → `graphRef.current.refresh()`.

### Issue 2: Hover State Separate from Highlight Deps (MEDIUM)
**Problem:** The existing highlight system is click-triggered ("Highlight Deps" toggle). The new hover neighborhood isolation is a separate, always-on interaction. These must coexist without conflicting.
**Solution:** Add separate refs: `hoveredNodeRef`, `hoveredNeighborsRef`. In `nodeCanvasObject`, check hover state FIRST (it's transient), then highlight deps state (it's persistent). If both active, hover takes visual priority for the hovered node; deps highlighting still shows for non-hovered highlighted nodes.

### Issue 3: NODE_GLOW_COLORS Not Yet Defined
**Problem:** Current code only has `NODE_COLORS`. The two-layer glow needs a second color map for the dimmer glow halo.
**Solution:** Add `NODE_GLOW_COLORS` constant alongside `NODE_COLORS`.

### Issue 4: Random Phase Seeds for Breathing
**Problem:** Each node needs a stable random phase offset for its breathing animation. This must persist across re-renders but be unique per node.
**Solution:** Use a hash of `node.id` to generate a deterministic phase offset (0 to 2π). Compute inline in `nodeCanvasObject`: `const phase = (hashCode(node.id) % 1000) / 1000 * Math.PI * 2`.

### Issue 5: Tooltip Z-Index and Pointer Events
**Problem:** The tooltip DOM element sits above the canvas but must not intercept mouse events (which would break hover detection).
**Solution:** `pointer-events: none` on the tooltip container. Style with the spec's colors, `z-index` above the canvas overlay layer.

## Wiring Checklist

### Phase 1: Foundation (no dependencies)
- [ ] Define all CSS custom properties in `:root` in `index.css` (backgrounds, borders, text, accent, node colors, glow colors, edge colors, syntax highlighting)
- [ ] Update `.gradient-mesh-graph` to use deep ocean gradient (`#060B18` base, `#0A1628` center glow)
- [ ] Update `.gradient-mesh-panel` to use new surface colors
- [ ] Update `.glow-violet` → `.glow-teal` utility
- [ ] Update `.card-glass` border/background to match theme
- [ ] Update `.input-focus-ring` to teal accent
- [ ] Update `NODE_COLORS` constant to bioluminescent palette
- [ ] Add `NODE_GLOW_COLORS` constant (dimmer halo colors per type)
- [ ] Update `NODE_SIZES` — Repository largest (10), Package 7, File 5, Class 5, Function 3.5, TypeDef 3.5, Constant 3 (already matches, confirm)
- [ ] Update `nodeCanvasObject` — add glow layer: draw larger circle with radial gradient (glow color, 40%→0% opacity) at 2.5x core size BEFORE drawing core circle
- [ ] Set `ctx.globalCompositeOperation = 'lighter'` for glow layer, restore to `'source-over'` for core
- [ ] Update edge colors: base `rgba(30, 58, 95, 0.3)`, highlight `rgba(75, 139, 245, 0.6)`
- [ ] Update edge width: base 0.5→1, add glow via wider semi-transparent pass (if `linkCanvasObject` supported) or accept single-layer
- [ ] Update directional arrow colors to match new edge colors

### Phase 2: Interactions & Animation (depends on Phase 1)
- [ ] Add `requestAnimationFrame` loop in `useEffect` that calls `graphRef.current.refresh()` — keeps canvas alive after sim cooldown
- [ ] Add breathing animation in `nodeCanvasObject`: modulate glow radius between 2.5x–3x core on sine wave, period 3–5s, random phase per node via `hashCode(node.id)`
- [ ] Add `hoveredNodeRef` and `hoveredNeighborsRef` state refs
- [ ] Add `onNodeHover` callback to force-graph: compute direct neighbors from adjacency maps, set hover refs
- [ ] In `nodeCanvasObject`: if hovered node set → hovered node glow 4x/60%, neighbors normal, others alpha 0.2
- [ ] In `linkColor`/`linkWidth`: if hovered node set → connected edges brighten to node color 60% opacity, others dim to 10%
- [ ] Add selection ring in `nodeCanvasObject`: for selected node, draw 1.5px `#7EFFF5` circle at 2x core, rotate angle from `performance.now() / 60000 * 2π`
- [ ] Update selected node glow to be brighter (white-tinted core shift)

### Phase 3: UI Chrome & Tooltip (depends on Phase 1)
- [ ] **Top bar:** `bg-gray-900/60` → `#0A1020`, `border-white/5` → `rgba(26, 35, 64, 0.6)`, violet accents → teal
- [ ] **Top bar:** "Highlight Deps" toggle `bg-purple-500/10` → `bg-[rgba(78,205,196,0.1)]`, text `text-purple-400` → teal
- [ ] **Top bar:** Repo selector focus border → `rgba(78, 205, 196, 0.4)`
- [ ] **Top bar:** Node/edge count badge → monospace `#6B7B8D` text
- [ ] **Filter sidebar:** Background → `#0E1424`, remove gradient-mesh-panel or update to teal mesh
- [ ] **Filter sidebar:** Color dot swatches → add tiny glow (box-shadow with node color)
- [ ] **Filter sidebar:** Section headers → `#4A5568`, counts → `#6B7B8D`
- [ ] **Filter sidebar:** Hover state → `rgba(78, 205, 196, 0.05)` background
- [ ] **Detail panel:** Background → `#0E1424`, borders → `rgba(26, 35, 64, 0.6)`
- [ ] **Detail panel:** Node name → `text-shadow: 0 0 10px {nodeColor}40`
- [ ] **Detail panel:** Section headers → `#4A5568` + letter-spacing 0.1em
- [ ] **Detail panel:** Property values → `#B0C4D8`
- [ ] **Detail panel:** Relationship links → `#4ECDC4` teal, hover glow
- [ ] **Detail panel:** Arrow icons `text-violet-400` → teal, `text-emerald-400` → stays or shifts
- [ ] **Detail panel:** Source code viewer → background `#080D1A`, line numbers `#3A4A5C`, code text `#B0C4D8`
- [ ] **Detail panel:** Highlighted line range → teal tint instead of purple (`bg-purple-900/30` → `bg-[rgba(78,205,196,0.08)]`)
- [ ] **Detail panel:** Resize handle hover → teal instead of violet
- [ ] **Nav sidebar (`Sidebar.tsx`):** Background → `#080D1A`
- [ ] **Nav sidebar:** Active state → `bg-[rgba(78,205,196,0.08)] text-[#4ECDC4] border-[rgba(78,205,196,0.2)]`
- [ ] **Nav sidebar:** Logo gradient → teal/cyan gradient instead of violet/blue, add text-shadow glow to "RepoGraph" text
- [ ] **Nav sidebar:** Logout hover → keep red (semantic color for destructive action)
- [ ] **Loading overlay:** `text-violet-400` → teal accent on spinner
- [ ] Add tooltip DOM element: absolute-positioned div in graph container, `pointer-events: none`, `z-index: 20`
- [ ] Tooltip styling: `#0E1424` bg, `1px solid rgba(78, 205, 196, 0.3)` border, `#D4DEE7` text, `box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5)`, `border-radius: 8px`
- [ ] Tooltip content: node displayName (bold), type badge (small, colored), 2-3 key properties
- [ ] Tooltip positioning: offset 10px right and 10px below cursor, clamp to viewport edges
- [ ] Wire tooltip to `onNodeHover`: show on hover, hide on null

### Phase 4: Polish & Performance
- [ ] Test with large graph (1000+ nodes) — verify glow rendering doesn't drop below 30fps
- [ ] If performance issue: skip glow layer when `globalScale < 0.3` (very zoomed out, glows not visible)
- [ ] If performance issue: reduce rAF to every 2nd frame for breathing
- [ ] Verify scrollbar styling matches theme
- [ ] Verify all overlay states (loading, error, empty) use new theme colors
- [ ] Test tooltip edge-clamping at viewport boundaries
- [ ] Cross-check: no remaining violet/purple references in Tailwind classes

## Build Order

1. **Phase 1: Foundation** — CSS variables, color constants, background, node glow rendering, edge colors
2. **Phase 2: Interactions & Animation** — rAF loop, breathing, hover isolation, selection ring
3. **Phase 3: UI Chrome & Tooltip** — all panel/sidebar restyling, tooltip component
4. **Phase 4: Polish & Performance** — testing, optimization, cleanup

Each phase checkpoint runs after completion before starting the next.
