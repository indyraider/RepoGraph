# Prompt: Bioluminescent Restyling for RepoGraph Knowledge Graph

You are restyling an existing knowledge graph explorer for a developer tool called RepoGraph. The current UI has a dark theme with a force-directed graph visualization showing nodes (Repository, File, Function, Class, TypeDef, Constant, Package, PackageExport) colored by type, with a left sidebar for node type filters, a top bar with controls, and a right-side detail panel that shows node properties, relationships, and source code when a node is clicked.

The goal is to apply a **bioluminescent deep-sea organism** aesthetic to the graph visualization and surrounding UI chrome. The codebase should look and feel like a living network of interconnected cells glowing against the deep ocean — organic, alive, softly luminous. This is NOT neon cyberpunk. It is natural, soft, and biological. Think bioluminescent jellyfish, deep-sea anglerfish light, neural networks under a microscope, plankton blooms at night.

---

## Background & Canvas

The graph canvas background should be a very deep blue-black — not pure black, but the color of deep ocean water. Use `#060B18` as the base. Layer a subtle radial gradient at the center of the canvas: a barely-visible lighter zone (`#0A1628` at ~30% opacity) that fades to the base color at the edges. This creates a sense of depth — like looking into water where light fades with distance.

Add a very subtle noise texture overlay on the canvas at ~3% opacity (CSS: use a tiny repeating noise PNG or SVG filter). This prevents the background from feeling like a flat CSS color and gives it the organic grain of a microscopy image.

The overall page background (sidebar, top bar, panels) should use `#080D1A` — slightly lighter than the canvas so the graph area feels like a recessed viewport. Panel surfaces (detail panel, filter panel) use `#0E1424`. Borders use `#1A2340` at ~60% opacity — they should be barely there, just enough to define edges.

---

## Node Rendering

Every node should GLOW. The glow is the defining visual characteristic. Nodes are not flat colored circles — they are soft light sources.

### Base Glow Effect

Each node is rendered as a circle with two layers:
1. **Core:** A solid circle at the node's color (see palette below), full opacity, at the node's base size.
2. **Glow:** A larger circle behind the core, same color, with a radial gradient from ~40% opacity at center to 0% opacity at edges. The glow circle should be 2.5–3x the diameter of the core.

If using Canvas/WebGL: render the glow as a radial gradient fill on a larger circle behind the node sprite. Use additive blending (globalCompositeOperation = 'lighter' in Canvas, or additive blend mode in WebGL/PixiJS) for the glow layer so overlapping glows blend naturally — like real light sources.

If using SVG: use a `<filter>` with `<feGaussianBlur stdDeviation="4">` and `<feComposite>` to create the glow. Apply it as a filter on a duplicate of the node circle with reduced opacity.

If using a library like D3-force with Canvas: draw the glow circle first (larger, transparent), then the core circle on top.

### Node Color Palette (by type)

Replace the current type colors with this bioluminescent palette:

| Node Type | Core Color | Glow Color | Inspiration |
|---|---|---|---|
| Repository | `#7EFFF5` | `#4ECDC4` | Bright bioluminescent plankton — the brightest node, the center of the organism |
| File | `#4B8BF5` | `#2E5FBF` | Deep jellyfish blue — the most common node, should be calm and ambient |
| Function | `#A78BFA` | `#7C5FCF` | Violet sea creature — distinct from File but not competing |
| Class | `#F472B6` | `#DB2777` | Pink coral — warm, organic, immediately distinct |
| TypeDef | `#38BDF8` | `#0284C7` | Ice-blue deep-sea fish — cool, precise |
| Constant | `#FBBF24` | `#D97706` | Amber bioluminescence — warm, like anglerfish lure |
| Package | `#34D399` | `#059669` | Green algae bloom — external, natural, alive |
| PackageExport | `#2DD4BF` | `#0D9488` | Teal — a dimmer variant of Package, clearly related |

### Node Size Variation

Keep the current size logic (likely based on node type or connections), but ensure:
- The Repository node is the largest (it's the heart of the organism)
- Package nodes are medium-large (they're major external entities)
- File nodes are medium
- Function/Class/TypeDef/Constant nodes are small (they are the cells of the organism)

### Idle Animation: Breathing

Every node should have a subtle "breathing" animation — a very slow, continuous pulse where the glow layer expands and contracts slightly. This makes the graph feel alive even when nobody is interacting.

Implementation: Animate the glow radius between 2.5x and 3x the core size on a sine wave with a period of 3–5 seconds. **Critically, offset each node's animation phase randomly** so they don't all pulse in sync — that looks mechanical. Random phase offsets make it look organic, like a colony of organisms each breathing independently.

The pulse should be VERY subtle — maybe 10-15% variation in glow radius. If it's visible at a glance, it's too much. It should be the kind of thing you notice after staring for 5 seconds: "wait, are those... moving?"

Performance note: if the graph has thousands of nodes, only animate glow on visible nodes (viewport culling). Or, simpler: animate using a shader uniform/CSS animation rather than per-frame JavaScript calculation.

---

## Edge Rendering

Edges should look like thin filaments of light connecting the nodes — like neural pathways or the tendrils of a jellyfish.

### Base Edge Style

- Color: `#1E3A5F` (dark blue) at ~30% opacity for the base state. Edges should be visible but not dominant — the nodes are the stars, edges are the connective tissue.
- Width: 1px (thin — these are delicate connections, not bold arrows).
- Add a very subtle glow to edges: render each edge twice — once at 1px in the base color, once at 3px in the same color at 10% opacity. This creates a soft luminous halo around each edge.

### Edge Interaction States

- **On node hover:** All edges connected to the hovered node should brighten to `#4B8BF5` (or the color of the hovered node) at 60% opacity, with the glow increasing to 20% opacity. All OTHER edges should dim to 10% opacity. This creates the effect of the hovered node "lighting up its connections" — like a neural impulse traveling along pathways.
- **All non-connected nodes** should also dim to ~20% opacity when a node is hovered. Only the hovered node and its direct neighbors stay bright. This isolation effect is critical — it lets the developer see one node's neighborhood without the visual noise of the full graph.

### Animated Edges (Optional Enhancement)

If performance allows: add a slow-moving particle effect along edges. Tiny dots of light (1–2px, same color as the edge but brighter) travel along the edge from source to target at a slow pace. Only 1 particle per edge, moving continuously. This makes the graph look like it has flowing energy — like signals traveling through a nervous system.

This is expensive to render on large graphs. Only enable it if the graph has fewer than 2,000 visible edges. Above that threshold, use static glowing edges.

---

## Hover & Selection States

### Node Hover

When the cursor approaches a node:
1. The node's glow INTENSIFIES — the glow radius expands to 4x core size, opacity increases to 60%. The transition should be fast (150ms ease-out).
2. A tooltip appears near the node with the node name, type, and key properties. Style the tooltip with a `#0E1424` background, `1px solid rgba(78, 205, 196, 0.3)` border (teal, to match the bioluminescent theme), and `#D4DEE7` text. Subtle box-shadow: `0 4px 20px rgba(0, 0, 0, 0.5)`. Rounded corners (8px).
3. Connected edges and neighbor nodes brighten. Everything else dims. (See Edge Interaction States above.)

### Node Selection (Click)

When a node is clicked:
1. The node's glow color shifts to a brighter variant — almost white-tinted. A selection ring appears around the node: a thin (1.5px) circle at 2x core size, in `#7EFFF5` (bright teal), with a slow rotation animation (60 seconds per revolution). This ring is the visual indicator that a node is selected.
2. The detail panel opens on the right (existing behavior). The panel should use the same dark surfaces and teal accent color for borders and section headers.
3. The glow intensification persists (unlike hover, which fades on mouse-out). The selected node is always the brightest thing in the graph.

---

## Panel & Chrome Styling

### Left Panel (Node Type Filters)

- Background: `#0E1424`
- Each node type row should have a small glowing dot in the node's type color (using the new palette) instead of a flat circle. The dot should have a tiny glow effect — even at this small size, the bioluminescent feel should be consistent.
- Counts should be in `#6B7B8D` (muted secondary text).
- Section headers ("NODE TYPES") in `#4A5568` (dim) with letter-spacing: 0.1em.
- On hover over a node type row: the row background subtly shifts to `rgba(78, 205, 196, 0.05)` — a barely-there teal wash.

### Right Panel (Detail Panel)

- Background: `#0E1424`
- The node name at the top should glow — apply a `text-shadow: 0 0 10px {nodeColor}40` using the node's type color. This is a subtle luminous text effect that ties the panel to the graph visually.
- Section headers (PROPERTIES, RELATIONSHIPS, SOURCE) in `#4A5568` with the same letter-spacing as the left panel.
- Property values in `#B0C4D8` (code-like, slightly blue-shifted).
- Relationship links should use `#4ECDC4` (teal) as the link color — on hover, they should brighten and gain a subtle text-shadow glow.
- Source code block: background `#080D1A` (darker than the panel — it's a recessed area). Line numbers in `#3A4A5C`. Code text in `#B0C4D8`. Syntax highlighting should lean toward the bioluminescent palette — strings in `#FBBF24` (amber), keywords in `#A78BFA` (violet), types in `#38BDF8` (ice blue), comments in `#3A5068` (very dim).

### Top Bar

- Background: `#0A1020` — slightly darker than the sidebar, creating a header hierarchy.
- The repo selector dropdown should have a subtle teal border on focus (`border-color: rgba(78, 205, 196, 0.4)`).
- The node/edge count text in the top-right should use the monospace font in `#6B7B8D` — it's metadata, not primary content.
- The "Highlight Deps" toggle (or any toggle buttons) should use `#4ECDC4` as the active/on color instead of whatever they currently use.

### Sidebar Navigation

- Background: `#080D1A`
- The active nav item should have a left border accent in `#4ECDC4` (teal) and a background of `rgba(78, 205, 196, 0.08)` — a very faint teal wash indicating selection.
- Inactive nav items in `#6B7B8D`, hovering shifts to `#B0C4D8`.
- The RepoGraph logo area at the top: if the logo has a colored element, shift it to `#4ECDC4`. If it's text, add a subtle `text-shadow: 0 0 15px rgba(78, 205, 196, 0.3)` to make it glow gently.

---

## CSS Variables (Complete Set)

Define these at the root level for consistency:

```css
:root {
  /* Backgrounds */
  --bg-void: #060B18;          /* Graph canvas deep background */
  --bg-deep: #080D1A;          /* Page background, sidebar */
  --bg-surface: #0E1424;       /* Panels, cards, elevated surfaces */
  --bg-recessed: #080D1A;      /* Code blocks, inset areas */
  --bg-header: #0A1020;        /* Top bar */

  /* Borders */
  --border-subtle: rgba(26, 35, 64, 0.6);   /* Default borders */
  --border-accent: rgba(78, 205, 196, 0.3);  /* Focused/active borders */

  /* Text */
  --text-primary: #D4DEE7;
  --text-secondary: #6B7B8D;
  --text-code: #B0C4D8;
  --text-dim: #3A4A5C;
  --text-heading: #4A5568;

  /* Accent */
  --accent-primary: #4ECDC4;       /* Teal — the signature color */
  --accent-bright: #7EFFF5;        /* Bright teal — highlights, selections */
  --accent-dim: #2A7A73;           /* Dimmed teal — subtle accents */

  /* Node type colors */
  --node-repository: #7EFFF5;
  --node-file: #4B8BF5;
  --node-function: #A78BFA;
  --node-class: #F472B6;
  --node-typedef: #38BDF8;
  --node-constant: #FBBF24;
  --node-package: #34D399;
  --node-package-export: #2DD4BF;

  /* Glow colors (dimmer versions for the halo) */
  --glow-repository: #4ECDC4;
  --glow-file: #2E5FBF;
  --glow-function: #7C5FCF;
  --glow-class: #DB2777;
  --glow-typedef: #0284C7;
  --glow-constant: #D97706;
  --glow-package: #059669;
  --glow-package-export: #0D9488;

  /* Edge colors */
  --edge-default: rgba(30, 58, 95, 0.3);
  --edge-highlight: rgba(75, 139, 245, 0.6);
  --edge-glow: rgba(30, 58, 95, 0.1);

  /* Severity (for future health encoding) */
  --severity-critical: #FF4757;
  --severity-high: #FF7F50;
  --severity-medium: #FECA57;
  --severity-low: #54A0FF;
  --severity-clean: #2ED573;

  /* Syntax highlighting */
  --syntax-keyword: #A78BFA;
  --syntax-string: #FBBF24;
  --syntax-type: #38BDF8;
  --syntax-comment: #3A5068;
  --syntax-function: #4ECDC4;
  --syntax-number: #F472B6;
  --syntax-operator: #6B7B8D;
}
```

---

## Summary of the Vibe

The end result should feel like this: you open RepoGraph and you're looking into a dark aquarium. Your codebase is a colony of glowing organisms. Each cluster of files is a living structure. The connections between them are delicate, luminous filaments. When you hover over a node, it brightens and its connections light up like a neural impulse. When you click, it pulses and the detail panel reveals its inner structure. When nothing is happening, the whole graph breathes — slowly, subtly, almost imperceptibly.

The UI chrome around the graph is dark, recessive, and functional. It does not compete with the graph for attention. The teal accent color (`#4ECDC4`) ties everything together — it appears in the sidebar selection state, the panel headers, the selected node ring, and the logo glow. It is the organism's signature color.

This is not a theme you should be able to mistake for any other developer tool. It is distinctly RepoGraph.
