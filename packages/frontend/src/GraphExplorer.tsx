import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { NodeObject, LinkObject } from "force-graph";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import _ForceGraph from "force-graph";
import {
  getGraphData,
  getFileContent,
  getRepositories,
  type GraphNode,
  type GraphEdge,
  type Repository,
} from "./api";
import {
  X,
  Loader2,
  Sparkles,
  ChevronDown,
  Eye,
  EyeOff,
  FileCode2,
  Box,
  FunctionSquare,
  Braces,
  Type,
  Hash,
  Package,
  PackageOpen,
  GitBranch,
  Network,
  AlertTriangle,
  Inbox,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";

// Runtime: kapsule factory function; Types: class constructor. Cast to match runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph = _ForceGraph as any;

// ─── Types ───────────────────────────────────────────────

interface FGNode extends NodeObject {
  id: string;
  label: string;
  props: Record<string, unknown>;
  color: string;
  displayName: string;
}

interface FGLink extends LinkObject<FGNode> {
  type: string;
  props: Record<string, unknown>;
}

// ─── Constants ───────────────────────────────────────────────

const NODE_TYPES = [
  "Repository",
  "File",
  "Function",
  "Class",
  "TypeDef",
  "Constant",
  "Package",
  "PackageExport",
] as const;

const NODE_COLORS: Record<string, string> = {
  Repository: "#7EFFF5",
  File: "#4B8BF5",
  Function: "#A78BFA",
  Class: "#F472B6",
  TypeDef: "#38BDF8",
  Constant: "#FBBF24",
  Package: "#34D399",
  PackageExport: "#2DD4BF",
};

const NODE_GLOW_COLORS: Record<string, string> = {
  Repository: "#4ECDC4",
  File: "#2E5FBF",
  Function: "#7C5FCF",
  Class: "#DB2777",
  TypeDef: "#0284C7",
  Constant: "#D97706",
  Package: "#059669",
  PackageExport: "#0D9488",
};

const NODE_ICONS: Record<string, typeof GitBranch> = {
  Repository: GitBranch,
  File: FileCode2,
  Function: FunctionSquare,
  Class: Box,
  TypeDef: Type,
  Constant: Hash,
  Package: Package,
  PackageExport: PackageOpen,
};

const NODE_SIZES: Record<string, number> = {
  Repository: 10,
  File: 5,
  Function: 3.5,
  Class: 5,
  TypeDef: 3.5,
  Constant: 3,
  Package: 7,
  PackageExport: 3,
};

function linkNodeId(endpoint: string | FGNode | NodeObject): string {
  if (typeof endpoint === "object" && endpoint !== null) {
    return (endpoint as FGNode).id;
  }
  return endpoint as string;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ─── Component ───────────────────────────────────────────────

export default function GraphExplorer() {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);

  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const selectedRepoIdRef = useRef<string | null>(null);
  const [rawNodes, setRawNodes] = useState<GraphNode[]>([]);
  const [rawEdges, setRawEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [activeTypes, setActiveTypes] = useState<Set<string>>(
    new Set(NODE_TYPES)
  );

  // Node detail panel
  const [selectedNode, setSelectedNode] = useState<FGNode | null>(null);
  const selectedNodeIdRef = useRef<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentLoading, setFileContentLoading] = useState(false);
  const [panelWidth, setPanelWidth] = useState(384);
  const isResizingRef = useRef(false);

  // Highlight deps
  const [highlightDeps, setHighlightDeps] = useState(false);
  const highlightDepsRef = useRef(false);
  const highlightedNodesRef = useRef<Set<string>>(new Set());
  const highlightedLinksRef = useRef<Set<string>>(new Set());

  // Hover state for neighborhood isolation
  const hoveredNodeRef = useRef<FGNode | null>(null);
  const hoveredNeighborsRef = useRef<Set<string>>(new Set());
  const hoveredLinksRef = useRef<Set<string>>(new Set());
  const [tooltipState, setTooltipState] = useState<{ node: FGNode; x: number; y: number } | null>(null);

  // Keep refs in sync
  useEffect(() => { selectedRepoIdRef.current = selectedRepoId; }, [selectedRepoId]);
  useEffect(() => { highlightDepsRef.current = highlightDeps; }, [highlightDeps]);

  // Load repos on mount
  useEffect(() => {
    getRepositories().then((r) => {
      setRepos(r);
      if (r.length > 0) setSelectedRepoId(r[0].id);
    });
  }, []);

  // Load graph data when repo changes
  useEffect(() => {
    if (!selectedRepoId) return;
    setLoading(true);
    setError(null);
    setSelectedNode(null);
    selectedNodeIdRef.current = null;
    setFileContent(null);
    highlightedNodesRef.current = new Set();
    highlightedLinksRef.current = new Set();
    getGraphData(selectedRepoId)
      .then((data) => {
        setRawNodes(data.nodes);
        setRawEdges(data.edges);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [selectedRepoId]);

  // Build filtered graph data
  const graphData = useMemo(() => {
    const visibleIds = new Set(
      rawNodes.filter((n) => activeTypes.has(n.label)).map((n) => n.id)
    );

    const nodes: FGNode[] = rawNodes
      .filter((n) => visibleIds.has(n.id))
      .map((n) => ({
        id: n.id,
        label: n.label,
        props: n.props,
        color: NODE_COLORS[n.label] || "#6b7280",
        displayName:
          (n.props.name as string) ||
          (n.props.path as string)?.split("/").pop() ||
          n.label,
      }));

    const links: FGLink[] = rawEdges
      .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type,
        props: e.props,
      }));

    return { nodes, links };
  }, [rawNodes, rawEdges, activeTypes]);

  // Build adjacency maps
  const adjacencyRef = useRef<{
    neighbors: Map<string, Set<string>>;
    chainForward: Map<string, Set<string>>;
    chainReverse: Map<string, Set<string>>;
  }>({ neighbors: new Map(), chainForward: new Map(), chainReverse: new Map() });

  const rawEdgesRef = useRef(rawEdges);
  rawEdgesRef.current = rawEdges;

  useMemo(() => {
    const neighbors = new Map<string, Set<string>>();
    const chainForward = new Map<string, Set<string>>();
    const chainReverse = new Map<string, Set<string>>();

    const CHAIN_TYPES = new Set(["IMPORTS", "CALLS", "DEPENDS_ON", "CONTAINS", "EXPORTS", "CONTAINS_FILE", "PROVIDES"]);

    for (const link of rawEdges) {
      if (!neighbors.has(link.source)) neighbors.set(link.source, new Set());
      if (!neighbors.has(link.target)) neighbors.set(link.target, new Set());
      neighbors.get(link.source)!.add(link.target);
      neighbors.get(link.target)!.add(link.source);

      if (CHAIN_TYPES.has(link.type)) {
        if (!chainForward.has(link.source)) chainForward.set(link.source, new Set());
        if (!chainReverse.has(link.target)) chainReverse.set(link.target, new Set());
        chainForward.get(link.source)!.add(link.target);
        chainReverse.get(link.target)!.add(link.source);
      }
    }

    adjacencyRef.current = { neighbors, chainForward, chainReverse };
  }, [rawEdges]);

  const computeHighlight = useCallback((nodeId: string) => {
    const adj = adjacencyRef.current;
    const nodes = new Set<string>();
    nodes.add(nodeId);

    const directNeighbors = adj.neighbors.get(nodeId);
    if (directNeighbors) {
      for (const n of directNeighbors) nodes.add(n);
    }

    const walkDown = (id: string, visited: Set<string>) => {
      const targets = adj.chainForward.get(id);
      if (!targets) return;
      for (const t of targets) {
        if (!visited.has(t)) {
          visited.add(t);
          nodes.add(t);
          walkDown(t, visited);
        }
      }
    };

    const walkUp = (id: string, visited: Set<string>) => {
      const sources = adj.chainReverse.get(id);
      if (!sources) return;
      for (const s of sources) {
        if (!visited.has(s)) {
          visited.add(s);
          nodes.add(s);
          walkUp(s, visited);
        }
      }
    };

    const visited = new Set<string>([nodeId]);
    walkDown(nodeId, visited);
    walkUp(nodeId, visited);

    const links = new Set<string>();
    for (const link of rawEdgesRef.current) {
      if (nodes.has(link.source) && nodes.has(link.target)) {
        links.add(`${link.source}__${link.target}`);
      }
    }

    highlightedNodesRef.current = nodes;
    highlightedLinksRef.current = links;
  }, []);

  // Handle node click (called from force-graph, updates React state)
  const handleNodeClickRef = useRef<(node: FGNode) => void>(() => {});
  handleNodeClickRef.current = (node: FGNode) => {
    setSelectedNode(node);
    selectedNodeIdRef.current = node.id;
    setFileContent(null);

    // Smoothly center the view on the clicked node
    if (node.x != null && node.y != null) {
      graphRef.current?.centerAt(node.x, node.y, 300);
    }

    if (highlightDepsRef.current) {
      computeHighlight(node.id);
    }

    const repoId = selectedRepoIdRef.current;
    if (node.label === "File" && repoId && node.props.path) {
      setFileContentLoading(true);
      getFileContent(repoId, node.props.path as string)
        .then((data) => setFileContent(data.content))
        .catch(() => setFileContent(null))
        .finally(() => setFileContentLoading(false));
    } else if (
      ["Function", "Class", "TypeDef", "Constant"].includes(node.label) &&
      repoId &&
      node.props.file_path
    ) {
      setFileContentLoading(true);
      getFileContent(repoId, node.props.file_path as string)
        .then((data) => setFileContent(data.content))
        .catch(() => setFileContent(null))
        .finally(() => setFileContentLoading(false));
    }
  };

  // ─── Initialize force-graph vanilla instance ──────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const graph = ForceGraph()(el)
      .autoPauseRedraw(false)
      .backgroundColor("transparent")
      .cooldownTicks(150)
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.4)
      .linkDirectionalArrowLength(3)
      .linkDirectionalArrowRelPos(1)
      .nodeCanvasObject((node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const baseSize = NODE_SIZES[node.label] || 4;
        const size = globalScale <= 1 ? baseSize : baseSize / globalScale;
        const x = node.x!;
        const y = node.y!;
        const hl = highlightedNodesRef.current;
        const active = highlightDepsRef.current && hl.size > 0;
        const isSelected = selectedNodeIdRef.current === node.id;

        // Hover isolation: check if any node is hovered
        const hovered = hoveredNodeRef.current;
        const isHovered = hovered?.id === node.id;
        const isHoverNeighbor = hovered ? hoveredNeighborsRef.current.has(node.id) : false;
        const hoverActive = hovered != null;

        // Alpha: hover isolation takes priority, then dep highlight
        let alpha = 1;
        if (hoverActive && !isHovered && !isHoverNeighbor) {
          alpha = 0.2;
        } else if (active && !hl.has(node.id)) {
          alpha = 0.12;
        }
        ctx.globalAlpha = alpha;

        // Glow layer — radial gradient halo behind the core
        const glowColor = NODE_GLOW_COLORS[node.label] || node.color;

        // Breathing animation: sine-wave modulation on glow radius
        const phase = (hashCode(node.id) % 1000) / 1000 * Math.PI * 2;
        const breathe = Math.sin(performance.now() / 4000 * Math.PI * 2 + phase);
        const breatheScale = 2.625 + 0.375 * breathe; // oscillate 2.25x – 3x
        let glowRadius = size * breatheScale;
        let glowOpacity = "66"; // 40%

        // Hover intensification
        if (isHovered) {
          glowRadius = size * 4;
          glowOpacity = "99"; // 60%
        }

        if (globalScale > 0.3) {
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          const gradient = ctx.createRadialGradient(x, y, size * 0.5, x, y, glowRadius);
          gradient.addColorStop(0, glowColor + glowOpacity);
          gradient.addColorStop(1, glowColor + "00");
          ctx.beginPath();
          ctx.arc(x, y, glowRadius, 0, 2 * Math.PI);
          ctx.fillStyle = gradient;
          ctx.fill();
          ctx.globalCompositeOperation = "source-over";
          ctx.restore();
        }

        // Core circle
        ctx.beginPath();
        ctx.arc(x, y, size, 0, 2 * Math.PI);
        ctx.fillStyle = isSelected ? "#ffffff" : node.color;
        if (isSelected) {
          // White-tinted core for selected node
          ctx.fillStyle = node.color;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, size, 0, 2 * Math.PI);
          ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
        }
        ctx.fill();

        // Dependency highlight stroke
        if (active && hl.has(node.id) && !isSelected) {
          ctx.save();
          ctx.shadowColor = glowColor + "33";
          ctx.shadowBlur = 8;
          ctx.strokeStyle = glowColor + "CC";
          ctx.lineWidth = 0.8 / globalScale;
          ctx.stroke();
          ctx.restore();
        }

        // Selection ring — rotating teal circle
        if (isSelected) {
          const ringRadius = size * 2;
          const angle = (performance.now() / 60000) * Math.PI * 2;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(angle);
          ctx.beginPath();
          ctx.arc(0, 0, ringRadius, 0, 2 * Math.PI);
          ctx.strokeStyle = "#7EFFF5";
          ctx.lineWidth = 1.5 / globalScale;
          ctx.setLineDash([ringRadius * 0.3, ringRadius * 0.15]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }

        // Labels at zoom
        if (globalScale > 1.5 || (active && hl.has(node.id) && globalScale > 0.6) || isHovered) {
          const fontSize = Math.max(10 / globalScale, 1.5);
          ctx.font = `${fontSize}px Inter, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = alpha < 0.5 ? "rgba(255, 255, 255, 0.1)" : "rgba(212, 222, 231, 0.85)";
          ctx.fillText(node.displayName, x, y + size + 1);
        }

        ctx.globalAlpha = 1;
      })
      .nodePointerAreaPaint((node: FGNode, color: string, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const baseSize = NODE_SIZES[node.label] || 4;
        const size = globalScale <= 1 ? baseSize : baseSize / globalScale;
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, size + 2 / Math.max(globalScale, 1), 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
      })
      .onNodeClick((node: FGNode) => {
        handleNodeClickRef.current(node);
      })
      .onBackgroundClick(() => {
        if (highlightDepsRef.current) {
          highlightedNodesRef.current = new Set();
          highlightedLinksRef.current = new Set();
        }
      })
      .onNodeHover((node: FGNode | null) => {
        hoveredNodeRef.current = node;
        if (node) {
          const neighbors = new Set<string>();
          const links = new Set<string>();
          const adj = adjacencyRef.current.neighbors.get(node.id);
          if (adj) {
            for (const n of adj) neighbors.add(n);
          }
          for (const edge of rawEdgesRef.current) {
            if (edge.source === node.id || edge.target === node.id) {
              links.add(`${edge.source}__${edge.target}`);
            }
          }
          hoveredNeighborsRef.current = neighbors;
          hoveredLinksRef.current = links;
          // Position tooltip
          const coords = graphRef.current?.graph2ScreenCoords(node.x, node.y);
          if (coords) {
            setTooltipState({ node, x: coords.x, y: coords.y });
          }
        } else {
          hoveredNeighborsRef.current = new Set();
          hoveredLinksRef.current = new Set();
          setTooltipState(null);
        }
      })
      .linkColor((link: FGLink) => {
        const key = `${linkNodeId(link.source as string | FGNode)}__${linkNodeId(link.target as string | FGNode)}`;
        // Hover isolation takes priority
        if (hoveredNodeRef.current) {
          return hoveredLinksRef.current.has(key) ? "rgba(75, 139, 245, 0.60)" : "rgba(30, 58, 95, 0.06)";
        }
        const hl = highlightedLinksRef.current;
        if (!highlightDepsRef.current || hl.size === 0) return "rgba(30, 58, 95, 0.3)";
        return hl.has(key) ? "rgba(75, 139, 245, 0.60)" : "rgba(30, 58, 95, 0.08)";
      })
      .linkWidth((link: FGLink) => {
        const key = `${linkNodeId(link.source as string | FGNode)}__${linkNodeId(link.target as string | FGNode)}`;
        if (hoveredNodeRef.current) {
          return hoveredLinksRef.current.has(key) ? 1.5 : 0.3;
        }
        const hl = highlightedLinksRef.current;
        if (!highlightDepsRef.current || hl.size === 0) return 0.5;
        return hl.has(key) ? 1.5 : 0.3;
      })
      .linkDirectionalArrowColor((link: FGLink) => {
        const key = `${linkNodeId(link.source as string | FGNode)}__${linkNodeId(link.target as string | FGNode)}`;
        if (hoveredNodeRef.current) {
          return hoveredLinksRef.current.has(key) ? "rgba(75, 139, 245, 0.80)" : "rgba(30, 58, 95, 0.04)";
        }
        const hl = highlightedLinksRef.current;
        if (!highlightDepsRef.current || hl.size === 0) return "rgba(30, 58, 95, 0.5)";
        return hl.has(key) ? "rgba(75, 139, 245, 0.80)" : "rgba(30, 58, 95, 0.08)";
      });

    // Tune forces for a clean, compact layout
    graph.d3Force('charge')?.strength(-80).distanceMax(250);
    graph.d3Force('link')?.distance((link: FGLink) => {
      const src = typeof link.source === 'object' ? (link.source as FGNode).label : '';
      const tgt = typeof link.target === 'object' ? (link.target as FGNode).label : '';
      if (src === 'Repository' || tgt === 'Repository') return 60;
      if (src === 'Package' || tgt === 'Package') return 50;
      if (src === 'File' || tgt === 'File') return 35;
      return 25;
    });
    graph.d3Force('center')?.strength(0.12);

    graphRef.current = graph;

    // Resize observer
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      graph.width(width).height(height);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      graph._destructor();
      graphRef.current = null;
    };
  }, []); // Mount once, destroy on unmount

  // ─── Keep canvas alive for breathing animation ────────────
  useEffect(() => {
    let rafId: number;
    const tick = () => {
      graphRef.current?.refresh();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // ─── Update graph data when it changes ────────────────────
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || graphData.nodes.length === 0) return;

    graph.graphData(graphData);

    // Zoom to fit after layout settles
    setTimeout(() => {
      graphRef.current?.zoomToFit(400, 40);
    }, 500);
  }, [graphData]);

  // Toggle a node type filter
  const toggleType = useCallback((type: string) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  // Count nodes by type
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of rawNodes) {
      counts[n.label] = (counts[n.label] || 0) + 1;
    }
    return counts;
  }, [rawNodes]);

  // Panel resize drag handler
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = panelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      setPanelWidth(Math.max(320, Math.min(startWidth + delta, 900)));
    };
    const onMouseUp = () => {
      isResizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [panelWidth]);

  return (
    <div className="h-full flex flex-col overflow-hidden noise-overlay" style={{ background: "var(--bg-deep)", color: "var(--text-primary)" }}>
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-2.5 backdrop-blur-md relative z-[1]" style={{ background: "var(--bg-header)", borderBottom: "1px solid var(--border-subtle)" }}>
        <div className="flex items-center gap-2">
          <Network className="w-4 h-4" style={{ color: "var(--accent-primary)" }} />
          <h1 className="text-sm font-semibold text-white">Graph Explorer</h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              const next = !highlightDeps;
              if (!next) {
                highlightedNodesRef.current = new Set();
                highlightedLinksRef.current = new Set();
              }
              setHighlightDeps(next);
            }}
            className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-all duration-200 ${
              highlightDeps
                ? "bg-transparent"
                : "bg-transparent hover:border-white/10"
            }`}
            style={highlightDeps ? { background: "rgba(78, 205, 196, 0.1)", borderColor: "rgba(78, 205, 196, 0.3)", color: "var(--accent-primary)" } : { borderColor: "rgba(255,255,255,0.05)", color: "var(--text-secondary)" }}
          >
            <Sparkles className="w-3.5 h-3.5" />
            Highlight Deps
          </button>
          <div className="relative">
            <select
              value={selectedRepoId || ""}
              onChange={(e) => setSelectedRepoId(e.target.value)}
              className="appearance-none border rounded-md pl-3 pr-8 py-1.5 text-sm input-focus-ring transition-shadow cursor-pointer"
              style={{ background: "rgba(14, 20, 36, 0.6)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.branch})
                </option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--text-secondary)" }} />
          </div>
          <span className="text-xs tabular-nums font-mono px-2.5 py-1 rounded-md" style={{ color: "var(--text-secondary)", background: "rgba(255,255,255,0.03)" }}>
            {graphData.nodes.length} nodes &middot; {graphData.links.length} edges
          </span>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Type filter sidebar */}
        <div className="w-52 p-4 flex-shrink-0 overflow-y-auto gradient-mesh-panel relative z-[1]" style={{ borderRight: "1px solid var(--border-subtle)" }}>
          <h3 className="text-[10px] font-semibold uppercase mb-3" style={{ color: "var(--text-heading)", letterSpacing: "0.1em" }}>
            Node Types
          </h3>
          <div className="space-y-0.5">
            {NODE_TYPES.map((type) => {
              const Icon = NODE_ICONS[type] || Braces;
              return (
                <button
                  key={type}
                  onClick={() => toggleType(type)}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-all duration-150"
                  style={{
                    background: activeTypes.has(type) ? "rgba(255,255,255,0.04)" : "transparent",
                    color: activeTypes.has(type) ? "var(--text-primary)" : "var(--text-secondary)",
                  }}
                  onMouseEnter={(e) => { if (!activeTypes.has(type)) e.currentTarget.style.background = "rgba(78, 205, 196, 0.05)"; }}
                  onMouseLeave={(e) => { if (!activeTypes.has(type)) e.currentTarget.style.background = "transparent"; }}
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0 transition-colors"
                    style={{
                      backgroundColor: activeTypes.has(type)
                        ? NODE_COLORS[type]
                        : "#374151",
                      boxShadow: activeTypes.has(type)
                        ? `0 0 6px ${NODE_COLORS[type]}80`
                        : "none",
                    }}
                  />
                  <Icon className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
                  <span className="flex-1 text-left text-xs">{type}</span>
                  <span className="text-[10px] tabular-nums" style={{ color: "var(--text-secondary)" }}>
                    {typeCounts[type] || 0}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-4 pt-3 flex gap-2" style={{ borderTop: "1px solid var(--border-subtle)" }}>
            <button
              onClick={() => setActiveTypes(new Set(NODE_TYPES))}
              className="flex-1 inline-flex items-center justify-center gap-1 text-[10px] py-1.5 rounded-md hover:bg-white/[0.03] transition-colors"
              style={{ color: "var(--text-secondary)" }}
            >
              <Eye className="w-3 h-3" />
              All
            </button>
            <button
              onClick={() => setActiveTypes(new Set())}
              className="flex-1 inline-flex items-center justify-center gap-1 text-[10px] py-1.5 rounded-md hover:bg-white/[0.03] transition-colors"
              style={{ color: "var(--text-secondary)" }}
            >
              <EyeOff className="w-3 h-3" />
              None
            </button>
          </div>
        </div>

        {/* Graph canvas */}
        <div className="flex-1 relative gradient-mesh-graph">
          {/* force-graph owns this div exclusively — no React children */}
          <div ref={containerRef} className="absolute inset-0" />
          {/* Overlays rendered by React in a separate sibling */}
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none gap-3" style={{ background: "rgba(6, 11, 24, 0.8)" }}>
              <Loader2 className="w-6 h-6 animate-spin" style={{ color: "var(--accent-primary)" }} />
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Loading graph...</span>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none gap-3" style={{ background: "rgba(6, 11, 24, 0.8)" }}>
              <AlertTriangle className="w-6 h-6 text-red-400" />
              <span className="text-sm text-red-400">{error}</span>
            </div>
          )}
          {!loading && graphData.nodes.length === 0 && !error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-3">
              <Inbox className="w-8 h-8" style={{ color: "var(--text-dim)" }} />
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                {selectedRepoId
                  ? "No graph data. Digest a repository first."
                  : "Select a repository to explore."}
              </span>
            </div>
          )}
          {/* Hover tooltip */}
          {tooltipState && (
            <div
              className="absolute z-20 pointer-events-none px-3 py-2 rounded-lg max-w-xs"
              style={{
                left: tooltipState.x + 10,
                top: tooltipState.y + 10,
                background: "var(--bg-surface)",
                border: "1px solid var(--border-accent)",
                color: "var(--text-primary)",
                boxShadow: "0 4px 20px rgba(0, 0, 0, 0.5)",
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="font-medium text-sm" style={{ textShadow: `0 0 10px ${NODE_COLORS[tooltipState.node.label]}40` }}>
                  {tooltipState.node.displayName}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.05)", color: "var(--text-secondary)" }}>
                  {tooltipState.node.label}
                </span>
              </div>
              {tooltipState.node.props.path && (
                <div className="text-[10px] truncate" style={{ color: "var(--text-code)" }}>
                  {String(tooltipState.node.props.path)}
                </div>
              )}
              {tooltipState.node.props.signature && (
                <div className="text-[10px] truncate font-mono mt-0.5" style={{ color: "var(--text-code)" }}>
                  {String(tooltipState.node.props.signature)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <div
            className="backdrop-blur-sm flex flex-col flex-shrink-0 overflow-hidden gradient-mesh-panel relative z-[1]"
            style={{ width: panelWidth, borderLeft: "1px solid var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            {/* Resize handle */}
            <div
              onMouseDown={startResize}
              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 transition-colors"
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(78, 205, 196, 0.3)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            />
            <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor: NODE_COLORS[selectedNode.label] || "#6b7280",
                    boxShadow: `0 0 8px ${NODE_COLORS[selectedNode.label]}60`,
                    border: "1px solid rgba(255,255,255,0.1)",
                  }}
                />
                <span
                  className="font-medium text-white truncate text-sm"
                  style={{ textShadow: `0 0 10px ${NODE_COLORS[selectedNode.label]}40` }}
                >
                  {selectedNode.displayName}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" style={{ background: "rgba(255,255,255,0.05)", color: "var(--text-secondary)" }}>
                  {selectedNode.label}
                </span>
              </div>
              <button
                onClick={() => {
                  setSelectedNode(null);
                  selectedNodeIdRef.current = null;
                  setFileContent(null);
                }}
                className="p-1 rounded hover:bg-white/5 transition-colors ml-2"
                style={{ color: "var(--text-secondary)" }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-4 py-3 overflow-y-auto max-h-60" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
              <h4 className="text-[10px] font-semibold uppercase mb-2" style={{ color: "var(--text-heading)", letterSpacing: "0.1em" }}>
                Properties
              </h4>
              <div className="space-y-1.5">
                {Object.entries(selectedNode.props).map(([key, value]) => (
                  <div key={key} className="text-xs">
                    <span style={{ color: "var(--text-secondary)" }}>{key}: </span>
                    <span className="break-all" style={{ color: "var(--text-code)" }}>
                      {typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Relationships */}
            {(() => {
              const outgoing = rawEdges.filter((e) => e.source === selectedNode.id);
              const incoming = rawEdges.filter((e) => e.target === selectedNode.id);
              const nodeMap = new Map(rawNodes.map((n) => [n.id, n]));
              const getDisplayName = (id: string) => {
                const n = nodeMap.get(id);
                if (!n) return id;
                return (n.props.name as string) || (n.props.path as string)?.split("/").pop() || n.label;
              };
              const getLabel = (id: string) => nodeMap.get(id)?.label || "";

              if (outgoing.length === 0 && incoming.length === 0) return null;

              // Group by type
              const outByType = new Map<string, GraphEdge[]>();
              for (const e of outgoing) {
                const arr = outByType.get(e.type) || [];
                arr.push(e);
                outByType.set(e.type, arr);
              }
              const inByType = new Map<string, GraphEdge[]>();
              for (const e of incoming) {
                const arr = inByType.get(e.type) || [];
                arr.push(e);
                inByType.set(e.type, arr);
              }

              return (
                <div className="px-4 py-3 overflow-y-auto max-h-52" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  <h4 className="text-[10px] font-semibold uppercase mb-2 flex items-center gap-1.5" style={{ color: "var(--text-heading)", letterSpacing: "0.1em" }}>
                    <Network className="w-3 h-3" />
                    Relationships
                  </h4>
                  <div className="space-y-2">
                    {[...outByType.entries()].map(([type, edges]) => (
                      <div key={`out-${type}`}>
                        <div className="flex items-center gap-1.5 text-[10px] mb-1" style={{ color: "var(--text-secondary)" }}>
                          <ArrowRight className="w-3 h-3" style={{ color: "var(--accent-primary)" }} />
                          <span className="font-medium" style={{ color: "var(--accent-primary)" }}>{type}</span>
                          <span>({edges.length})</span>
                        </div>
                        <div className="space-y-0.5 ml-4">
                          {edges.slice(0, 10).map((e, i) => (
                            <button
                              key={i}
                              className="flex items-center gap-1.5 text-xs hover:text-white w-full text-left rounded px-1 py-0.5 hover:bg-white/5 transition-colors"
                              style={{ color: "var(--text-code)" }}
                              onClick={() => {
                                const target = graphData.nodes.find((n) => n.id === e.target);
                                if (target) { setSelectedNode(target); selectedNodeIdRef.current = target.id; }
                              }}
                            >
                              <span
                                className="w-2 h-2 rounded-full flex-shrink-0"
                                style={{ backgroundColor: NODE_COLORS[getLabel(e.target)] || "#6b7280" }}
                              />
                              <span className="truncate">{getDisplayName(e.target)}</span>
                              <span className="text-[10px] flex-shrink-0" style={{ color: "var(--text-secondary)" }}>{getLabel(e.target)}</span>
                            </button>
                          ))}
                          {edges.length > 10 && (
                            <div className="text-[10px] ml-1" style={{ color: "var(--text-secondary)" }}>+{edges.length - 10} more</div>
                          )}
                        </div>
                      </div>
                    ))}
                    {[...inByType.entries()].map(([type, edges]) => (
                      <div key={`in-${type}`}>
                        <div className="flex items-center gap-1.5 text-[10px] mb-1" style={{ color: "var(--text-secondary)" }}>
                          <ArrowLeft className="w-3 h-3" style={{ color: "#38BDF8" }} />
                          <span className="font-medium" style={{ color: "#38BDF8" }}>{type}</span>
                          <span>({edges.length})</span>
                        </div>
                        <div className="space-y-0.5 ml-4">
                          {edges.slice(0, 10).map((e, i) => (
                            <button
                              key={i}
                              className="flex items-center gap-1.5 text-xs hover:text-white w-full text-left rounded px-1 py-0.5 hover:bg-white/5 transition-colors"
                              style={{ color: "var(--text-code)" }}
                              onClick={() => {
                                const source = graphData.nodes.find((n) => n.id === e.source);
                                if (source) { setSelectedNode(source); selectedNodeIdRef.current = source.id; }
                              }}
                            >
                              <span
                                className="w-2 h-2 rounded-full flex-shrink-0"
                                style={{ backgroundColor: NODE_COLORS[getLabel(e.source)] || "#6b7280" }}
                              />
                              <span className="truncate">{getDisplayName(e.source)}</span>
                              <span className="text-[10px] flex-shrink-0" style={{ color: "var(--text-secondary)" }}>{getLabel(e.source)}</span>
                            </button>
                          ))}
                          {edges.length > 10 && (
                            <div className="text-[10px] ml-1" style={{ color: "var(--text-secondary)" }}>+{edges.length - 10} more</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                <h4 className="text-[10px] font-semibold uppercase flex items-center gap-1.5" style={{ color: "var(--text-heading)", letterSpacing: "0.1em" }}>
                  <FileCode2 className="w-3 h-3" />
                  {selectedNode.label === "File"
                    ? "File Content"
                    : ["Function", "Class", "TypeDef", "Constant"].includes(
                          selectedNode.label
                        )
                      ? `Source (${(selectedNode.props.file_path as string)?.split("/").pop() || ""})`
                      : "Content"}
                </h4>
              </div>
              <div className="flex-1 overflow-auto">
                {fileContentLoading && (
                  <div className="p-4 text-sm flex items-center gap-2" style={{ color: "var(--text-secondary)" }}>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                )}
                {!fileContentLoading && fileContent && (
                  <pre className="p-4 text-xs leading-relaxed font-mono whitespace-pre overflow-x-auto" style={{ color: "var(--text-code)", background: "var(--bg-recessed)" }}>
                    {highlightLines(
                      fileContent,
                      selectedNode.props.start_line as number | undefined,
                      selectedNode.props.end_line as number | undefined
                    )}
                  </pre>
                )}
                {!fileContentLoading && !fileContent && (
                  <div className="p-4 text-xs flex items-center gap-2" style={{ color: "var(--text-dim)" }}>
                    <FileCode2 className="w-4 h-4 opacity-40" />
                    {["File", "Function", "Class", "TypeDef", "Constant"].includes(
                      selectedNode.label
                    )
                      ? "Content not available"
                      : "Select a File or symbol node to view source"}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function highlightLines(
  content: string,
  startLine?: number,
  endLine?: number
): React.ReactNode {
  const lines = content.split("\n");
  const gutterWidth = String(lines.length).length;

  return lines.map((line, i) => {
    const lineNum = i + 1;
    const isHighlighted =
      startLine != null &&
      endLine != null &&
      lineNum >= startLine &&
      lineNum <= endLine;

    return (
      <div
        key={i}
        style={isHighlighted ? { background: "rgba(78, 205, 196, 0.08)" } : undefined}
      >
        <span className="inline-block text-right select-none mr-4" style={{ width: `${gutterWidth + 1}ch`, color: "var(--text-dim)" }}>
          {lineNum}
        </span>
        {line}
      </div>
    );
  });
}
