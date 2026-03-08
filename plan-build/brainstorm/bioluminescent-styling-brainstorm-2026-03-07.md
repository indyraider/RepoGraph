# Brainstorm: Bioluminescent Deep-Sea Restyling
**Created:** 2026-03-07
**Status:** Draft

## Vision
Restyle the RepoGraph graph explorer from its current violet-accented dark theme to a **bioluminescent deep-sea organism** aesthetic. The graph should feel like a living colony of glowing organisms in deep ocean water — organic, softly luminous, alive. Primary accent shifts from violet (`#8b5cf6`) to teal (`#4ECDC4`). Every node glows. Edges are luminous filaments. The UI chrome recedes into darkness so the graph is the star.

## Existing Context

**Rendering stack:** `force-graph` v1.51.1 (Canvas-based, kapsule pattern). Custom node rendering via `nodeCanvasObject` using `ctx.arc()` + `ctx.fill()`. No glow/blur currently — nodes are flat filled circles.

**Styling stack:** Tailwind CSS v4.2.1 (Vite plugin). No separate config file. Custom CSS utilities in `index.css`: noise overlay, gradient mesh backgrounds, card glass effects, glow utilities. All dark-first using Tailwind gray scale.

**Key files to modify:**
- `packages/frontend/src/GraphExplorer.tsx` — node colors, sizes, canvas rendering, edge colors, UI chrome (top bar, filter sidebar, detail panel)
- `packages/frontend/src/index.css` — CSS variables, custom utilities, gradient meshes, glow effects
- `packages/frontend/src/Sidebar.tsx` — nav sidebar styling, logo area

**Current accent color:** Violet (`#8b5cf6`, `text-violet-400`, `bg-violet-500/10`)
**Target accent color:** Teal (`#4ECDC4`, bright: `#7EFFF5`)

## Components Identified

### 1. CSS Variables & Theme Foundation (`index.css`)
- **Responsibility**: Define the complete bioluminescent color system as CSS custom properties
- **Upstream (receives from)**: Design spec (the prompt document)
- **Downstream (sends to)**: All components consume these variables
- **External dependencies**: None
- **Hands test**: PASS — CSS variables are self-contained, consumed by Tailwind classes and inline styles

### 2. Node Color Palette (`GraphExplorer.tsx` constants)
- **Responsibility**: Map node types to bioluminescent core + glow colors
- **Upstream (receives from)**: Design spec color table
- **Downstream (sends to)**: `nodeCanvasObject` renderer, filter sidebar color dots, detail panel color indicators
- **External dependencies**: None
- **Hands test**: PASS — direct constant swap, consumed in 3 places within the same file + detail panel

### 3. Node Canvas Rendering — Glow Effect (`GraphExplorer.tsx` nodeCanvasObject)
- **Responsibility**: Render two-layer nodes (glow halo + solid core) on Canvas
- **Upstream (receives from)**: Node color palette, node sizes, force-graph coordinates
- **Downstream (sends to)**: Visual output on canvas
- **External dependencies**: Canvas 2D API (`ctx.arc`, `ctx.globalCompositeOperation`, radial gradients)
- **Hands test**: PASS — Canvas API supports radial gradients and composite operations natively. `globalCompositeOperation = 'lighter'` for additive blending is standard Canvas 2D.

### 4. Node Breathing Animation (`GraphExplorer.tsx` nodeCanvasObject)
- **Responsibility**: Subtle sine-wave pulse on glow radius with random phase offsets per node
- **Upstream (receives from)**: `Date.now()` / `performance.now()`, per-node random phase seed
- **Downstream (sends to)**: Glow radius modulation in render loop
- **External dependencies**: Needs continuous re-rendering — force-graph `autoPauseRedraw(false)` is already set, but the sim pauses after cooldown. Need to ensure ongoing redraws.
- **Hands test**: CAUTION — force-graph pauses the render loop after the simulation cools down. The breathing animation needs frames even when the sim is idle. **Wire needed:** either use `requestAnimationFrame` to keep the canvas alive, or periodically `reheat` the sim. The `autoPauseRedraw(false)` flag is already set but may not be sufficient — need to verify force-graph behavior after cooldown.

### 5. Edge Rendering — Luminous Filaments (`GraphExplorer.tsx` link config)
- **Responsibility**: Render edges as thin glowing filaments with double-layer (core + halo) rendering
- **Upstream (receives from)**: Edge data, highlight state
- **Downstream (sends to)**: Visual output on canvas
- **External dependencies**: force-graph `linkCanvasObjectMode` + `linkCanvasObject` for custom edge rendering (needed for double-layer effect). Current code only uses `linkColor`/`linkWidth` — **may need to switch to custom link rendering**.
- **Hands test**: CAUTION — force-graph supports `linkCanvasObject` for custom link drawing, but the current code doesn't use it. Need to verify the API exists in v1.51.1. Alternatively, the subtle glow effect might be achievable with just `linkWidth` and semi-transparent colors if we accept a simpler approach.

### 6. Edge Hover Interaction — Node Neighborhood Isolation
- **Responsibility**: On node hover, brighten connected edges, dim everything else
- **Upstream (receives from)**: Mouse hover events, adjacency maps
- **Downstream (sends to)**: Edge colors, node opacity
- **External dependencies**: force-graph `onNodeHover` callback (exists in API)
- **Hands test**: PASS — `onNodeHover` is a standard force-graph callback. The adjacency maps already exist. Need to add hover state tracking (separate from click/highlight deps state).

### 7. Node Selection Ring (`GraphExplorer.tsx` nodeCanvasObject)
- **Responsibility**: Thin rotating teal ring around selected node
- **Upstream (receives from)**: Selected node state, animation frame time
- **Downstream (sends to)**: Visual output on canvas
- **External dependencies**: Canvas `ctx.arc` with offset + `ctx.setLineDash` or angle-based rendering
- **Hands test**: PASS — Canvas can draw arcs with rotation via `ctx.rotate()`.

### 8. Background & Canvas Styling (`index.css` + `GraphExplorer.tsx`)
- **Responsibility**: Deep blue-black background with radial gradient center glow
- **Upstream (receives from)**: CSS variables
- **Downstream (sends to)**: Graph canvas container, page background
- **External dependencies**: None
- **Hands test**: PASS — update `.gradient-mesh-graph` and page background colors

### 9. UI Chrome — Top Bar, Filter Sidebar, Detail Panel
- **Responsibility**: Restyle all panel backgrounds, borders, text colors, accent colors from violet to teal
- **Upstream (receives from)**: CSS variables, design spec
- **Downstream (sends to)**: Visual output
- **External dependencies**: None — all Tailwind classes, straightforward swap
- **Hands test**: PASS — find-and-replace violet → teal in Tailwind classes, update hardcoded colors

### 10. Navigation Sidebar (`Sidebar.tsx`)
- **Responsibility**: Restyle nav sidebar — logo glow, active state teal accent, background colors
- **Upstream (receives from)**: CSS variables
- **Downstream (sends to)**: Visual output
- **External dependencies**: None
- **Hands test**: PASS

### 11. Detail Panel — Syntax Highlighting Colors
- **Responsibility**: Update source code viewer with bioluminescent syntax colors
- **Upstream (receives from)**: CSS variables for syntax colors
- **Downstream (sends to)**: `highlightLines` function output
- **External dependencies**: Currently no syntax highlighting library — just plain text with line number gutter and highlighted line range. **Adding real syntax highlighting is out of scope** per the prompt, but the code viewer colors (text, gutter, background) should match the spec.
- **Hands test**: PASS for color changes. No AST-level syntax highlighting to wire.

### 12. Tooltip on Node Hover
- **Responsibility**: Show styled tooltip near hovered node with name/type/properties
- **Upstream (receives from)**: Hover state, node data
- **Downstream (sends to)**: DOM overlay or canvas-drawn tooltip
- **External dependencies**: Needs either a React-rendered tooltip div positioned over the canvas, or canvas-drawn text. Canvas overlay div approach is simpler but needs coordinate translation (graph → screen coords via force-graph API).
- **Hands test**: CAUTION — force-graph does not natively render tooltips. Need to use `onNodeHover` + a positioned DOM element. force-graph provides `graph2ScreenCoords(x, y)` API for coordinate translation.

## Rough Dependency Map

```
CSS Variables (foundation)
  ├── Background/Canvas Styling
  ├── Node Color Palette
  │     ├── Node Canvas Rendering (glow)
  │     │     ├── Breathing Animation
  │     │     └── Selection Ring
  │     ├── Filter Sidebar (color dots)
  │     └── Detail Panel (color indicators)
  ├── Edge Rendering (filaments)
  │     └── Edge Hover Interaction
  ├── Tooltip (new component)
  ├── UI Chrome (top bar, panels)
  └── Nav Sidebar
```

## Open Questions

1. **Breathing animation after sim cooldown** — force-graph stops rendering after the physics simulation settles. How do we keep the canvas alive for the breathing pulse? Options: (a) periodic `graphRef.current.refresh()` via `setInterval`, (b) continuously reheat with minimal alpha, (c) use a separate `requestAnimationFrame` loop that calls the force-graph's internal render. Need to test which approach works.

2. **Custom edge rendering** — Do we need `linkCanvasObject` for the double-layer glow effect on edges, or is the simpler approach (wider semi-transparent edge + thinner solid edge) achievable with force-graph's built-in `linkWidth`/`linkColor`? The prompt says edges should have a 1px core + 3px glow at 10% opacity. Using `linkCanvasObject` gives full control but is more code.

3. **Edge particle animation** — The prompt marks this as optional and suggests only enabling below 2,000 visible edges. Should we include it in the initial build or defer?

4. **Tooltip implementation** — Canvas-drawn vs. DOM overlay? DOM is easier to style but needs coord translation. Canvas is more integrated but harder to make rich.

5. **Performance with thousands of nodes** — The glow effect doubles draw calls per node (glow circle + core circle). With additive blending enabled, compositing cost increases. Need to consider viewport culling or simplified rendering at low zoom levels.

## Risks and Concerns

- **Render performance**: Adding glow layers (2x draw calls per node) + breathing animation (continuous redraws) + additive blending may strain Canvas 2D on large graphs (1000+ nodes). Mitigation: skip glow at very low zoom, only animate visible nodes.
- **force-graph internal render loop**: The breathing animation requires frames even when physics is idle. This is the single biggest wiring risk — if we can't keep the render loop alive, the breathing won't work.
- **Color consistency**: The accent color change from violet to teal touches ~30+ Tailwind class references across 3 files. Missing one creates a jarring mixed-theme spot.
- **Custom link rendering**: If `linkCanvasObject` doesn't work well with force-graph's arrow rendering (`linkDirectionalArrowLength`), we may need to draw arrows manually too.
