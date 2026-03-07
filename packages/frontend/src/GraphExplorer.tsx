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
  Repository: "#8b5cf6",
  File: "#3b82f6",
  Function: "#22c55e",
  Class: "#f59e0b",
  TypeDef: "#06b6d4",
  Constant: "#ef4444",
  Package: "#ec4899",
  PackageExport: "#f97316",
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
        // Keep nodes a constant screen-pixel size regardless of zoom
        const size = baseSize / globalScale;
        const x = node.x!;
        const y = node.y!;
        const hl = highlightedNodesRef.current;
        const active = highlightDepsRef.current && hl.size > 0;
        const dimmed = active && !hl.has(node.id);
        const isSelected = selectedNodeIdRef.current === node.id;

        ctx.globalAlpha = dimmed ? 0.12 : 1;

        ctx.beginPath();
        ctx.arc(x, y, size, 0, 2 * Math.PI);
        ctx.fillStyle = node.color;
        ctx.fill();

        if (active && hl.has(node.id) && !isSelected) {
          ctx.save();
          ctx.shadowColor = "rgba(168, 85, 247, 0.20)";
          ctx.shadowBlur = 8;
          ctx.strokeStyle = "rgba(168, 85, 247, 0.80)";
          ctx.lineWidth = 0.8 / globalScale;
          ctx.stroke();
          ctx.restore();
        }

        if (isSelected) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5 / globalScale;
          ctx.stroke();
        }

        if (globalScale > 1.5 || (active && hl.has(node.id) && globalScale > 0.6)) {
          const fontSize = Math.max(10 / globalScale, 1.5);
          ctx.font = `${fontSize}px Inter, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = dimmed ? "rgba(255, 255, 255, 0.1)" : "rgba(255, 255, 255, 0.85)";
          ctx.fillText(node.displayName, x, y + size + 1);
        }

        ctx.globalAlpha = 1;
      })
      .nodePointerAreaPaint((node: FGNode, color: string, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const baseSize = NODE_SIZES[node.label] || 4;
        const size = baseSize / globalScale;
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, size + 2 / globalScale, 0, 2 * Math.PI);
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
      .linkColor((link: FGLink) => {
        const hl = highlightedLinksRef.current;
        if (!highlightDepsRef.current || hl.size === 0) return "rgba(100, 116, 139, 0.3)";
        const key = `${linkNodeId(link.source as string | FGNode)}__${linkNodeId(link.target as string | FGNode)}`;
        return hl.has(key) ? "rgba(168, 85, 247, 0.80)" : "rgba(100, 116, 139, 0.06)";
      })
      .linkWidth((link: FGLink) => {
        const hl = highlightedLinksRef.current;
        if (!highlightDepsRef.current || hl.size === 0) return 0.5;
        const key = `${linkNodeId(link.source as string | FGNode)}__${linkNodeId(link.target as string | FGNode)}`;
        return hl.has(key) ? 1.5 : 0.3;
      })
      .linkDirectionalArrowColor((link: FGLink) => {
        const hl = highlightedLinksRef.current;
        if (!highlightDepsRef.current || hl.size === 0) return "rgba(100, 116, 139, 0.5)";
        const key = `${linkNodeId(link.source as string | FGNode)}__${linkNodeId(link.target as string | FGNode)}`;
        return hl.has(key) ? "rgba(168, 85, 247, 0.90)" : "rgba(100, 116, 139, 0.06)";
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
    <div className="h-full bg-gray-950 text-gray-100 flex flex-col overflow-hidden noise-overlay">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-white/5 bg-gray-900/60 backdrop-blur-md relative z-[1]">
        <div className="flex items-center gap-2">
          <Network className="w-4 h-4 text-violet-400" />
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
                ? "bg-purple-500/10 border-purple-500/30 text-purple-400"
                : "bg-transparent border-white/5 text-gray-400 hover:text-gray-200 hover:border-white/10"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            Highlight Deps
          </button>
          <div className="relative">
            <select
              value={selectedRepoId || ""}
              onChange={(e) => setSelectedRepoId(e.target.value)}
              className="appearance-none bg-gray-800/60 border border-white/5 rounded-md pl-3 pr-8 py-1.5 text-sm text-gray-100 input-focus-ring transition-shadow cursor-pointer"
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.branch})
                </option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-gray-500 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
          <span className="text-xs text-gray-500 tabular-nums bg-white/5 px-2.5 py-1 rounded-md">
            {graphData.nodes.length} nodes &middot; {graphData.links.length} edges
          </span>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Type filter sidebar */}
        <div className="w-52 border-r border-white/5 bg-gray-900/40 p-4 flex-shrink-0 overflow-y-auto gradient-mesh-panel relative z-[1]">
          <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-3">
            Node Types
          </h3>
          <div className="space-y-0.5">
            {NODE_TYPES.map((type) => {
              const Icon = NODE_ICONS[type] || Braces;
              return (
                <button
                  key={type}
                  onClick={() => toggleType(type)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-all duration-150 ${
                    activeTypes.has(type)
                      ? "bg-white/[0.04] text-gray-100"
                      : "text-gray-600 hover:text-gray-400 hover:bg-white/[0.02]"
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0 transition-colors"
                    style={{
                      backgroundColor: activeTypes.has(type)
                        ? NODE_COLORS[type]
                        : "#374151",
                    }}
                  />
                  <Icon className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
                  <span className="flex-1 text-left text-xs">{type}</span>
                  <span className="text-[10px] text-gray-500 tabular-nums">
                    {typeCounts[type] || 0}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-4 pt-3 border-t border-white/5 flex gap-2">
            <button
              onClick={() => setActiveTypes(new Set(NODE_TYPES))}
              className="flex-1 inline-flex items-center justify-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 py-1.5 rounded-md hover:bg-white/[0.03] transition-colors"
            >
              <Eye className="w-3 h-3" />
              All
            </button>
            <button
              onClick={() => setActiveTypes(new Set())}
              className="flex-1 inline-flex items-center justify-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 py-1.5 rounded-md hover:bg-white/[0.03] transition-colors"
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
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-950/80 z-10 pointer-events-none gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
              <span className="text-sm text-gray-400">Loading graph...</span>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-950/80 z-10 pointer-events-none gap-3">
              <AlertTriangle className="w-6 h-6 text-red-400" />
              <span className="text-sm text-red-400">{error}</span>
            </div>
          )}
          {!loading && graphData.nodes.length === 0 && !error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-3">
              <Inbox className="w-8 h-8 text-gray-700" />
              <span className="text-sm text-gray-500">
                {selectedRepoId
                  ? "No graph data. Digest a repository first."
                  : "Select a repository to explore."}
              </span>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <div
            className="border-l border-white/5 bg-gray-900/50 backdrop-blur-sm flex flex-col flex-shrink-0 overflow-hidden gradient-mesh-panel relative z-[1]"
            style={{ width: panelWidth }}
          >
            {/* Resize handle */}
            <div
              onMouseDown={startResize}
              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 hover:bg-violet-500/30 active:bg-violet-500/40 transition-colors"
            />
            <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0 ring-2 ring-white/10"
                  style={{
                    backgroundColor: NODE_COLORS[selectedNode.label] || "#6b7280",
                  }}
                />
                <span className="font-medium text-white truncate text-sm">
                  {selectedNode.displayName}
                </span>
                <span className="text-[10px] text-gray-500 bg-white/5 px-1.5 py-0.5 rounded flex-shrink-0">
                  {selectedNode.label}
                </span>
              </div>
              <button
                onClick={() => {
                  setSelectedNode(null);
                  selectedNodeIdRef.current = null;
                  setFileContent(null);
                }}
                className="text-gray-500 hover:text-white p-1 rounded hover:bg-white/5 transition-colors ml-2"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-4 py-3 border-b border-white/5 overflow-y-auto max-h-60">
              <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-2">
                Properties
              </h4>
              <div className="space-y-1.5">
                {Object.entries(selectedNode.props).map(([key, value]) => (
                  <div key={key} className="text-xs">
                    <span className="text-gray-500">{key}: </span>
                    <span className="text-gray-300 break-all">
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
                <div className="px-4 py-3 border-b border-white/5 overflow-y-auto max-h-52">
                  <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                    <Network className="w-3 h-3" />
                    Relationships
                  </h4>
                  <div className="space-y-2">
                    {[...outByType.entries()].map(([type, edges]) => (
                      <div key={`out-${type}`}>
                        <div className="flex items-center gap-1.5 text-[10px] text-gray-500 mb-1">
                          <ArrowRight className="w-3 h-3 text-violet-400" />
                          <span className="font-medium text-violet-400">{type}</span>
                          <span>({edges.length})</span>
                        </div>
                        <div className="space-y-0.5 ml-4">
                          {edges.slice(0, 10).map((e, i) => (
                            <button
                              key={i}
                              className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white w-full text-left rounded px-1 py-0.5 hover:bg-white/5 transition-colors"
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
                              <span className="text-[10px] text-gray-600 flex-shrink-0">{getLabel(e.target)}</span>
                            </button>
                          ))}
                          {edges.length > 10 && (
                            <div className="text-[10px] text-gray-600 ml-1">+{edges.length - 10} more</div>
                          )}
                        </div>
                      </div>
                    ))}
                    {[...inByType.entries()].map(([type, edges]) => (
                      <div key={`in-${type}`}>
                        <div className="flex items-center gap-1.5 text-[10px] text-gray-500 mb-1">
                          <ArrowLeft className="w-3 h-3 text-emerald-400" />
                          <span className="font-medium text-emerald-400">{type}</span>
                          <span>({edges.length})</span>
                        </div>
                        <div className="space-y-0.5 ml-4">
                          {edges.slice(0, 10).map((e, i) => (
                            <button
                              key={i}
                              className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white w-full text-left rounded px-1 py-0.5 hover:bg-white/5 transition-colors"
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
                              <span className="text-[10px] text-gray-600 flex-shrink-0">{getLabel(e.source)}</span>
                            </button>
                          ))}
                          {edges.length > 10 && (
                            <div className="text-[10px] text-gray-600 ml-1">+{edges.length - 10} more</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="px-4 py-2.5 border-b border-white/5">
                <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest flex items-center gap-1.5">
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
                  <div className="p-4 text-gray-500 text-sm flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                )}
                {!fileContentLoading && fileContent && (
                  <pre className="p-4 text-xs text-gray-300 leading-relaxed font-mono whitespace-pre overflow-x-auto">
                    {highlightLines(
                      fileContent,
                      selectedNode.props.start_line as number | undefined,
                      selectedNode.props.end_line as number | undefined
                    )}
                  </pre>
                )}
                {!fileContentLoading && !fileContent && (
                  <div className="p-4 text-gray-600 text-xs flex items-center gap-2">
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
        className={isHighlighted ? "bg-purple-900/30" : ""}
      >
        <span className="inline-block text-right text-gray-600 select-none mr-4" style={{ width: `${gutterWidth + 1}ch` }}>
          {lineNum}
        </span>
        {line}
      </div>
    );
  });
}
