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

// Runtime: kapsule factory function; Types: class constructor. Cast to match runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph = _ForceGraph as any;

// ─── Types ───────────────────────────────────────────────────

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

export default function GraphExplorer({
  onBack,
}: {
  onBack: () => void;
}) {
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
      .cooldownTicks(200)
      .d3AlphaDecay(0.015)
      .d3VelocityDecay(0.25)
      .linkDirectionalArrowLength(3)
      .linkDirectionalArrowRelPos(1)
      .nodeCanvasObject((node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const size = NODE_SIZES[node.label] || 4;
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
          ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }

        if (isSelected) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
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
      .nodePointerAreaPaint((node: FGNode, color: string, ctx: CanvasRenderingContext2D) => {
        const size = NODE_SIZES[node.label] || 4;
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, size + 2, 0, 2 * Math.PI);
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
        return hl.has(key) ? "rgba(250, 204, 21, 0.7)" : "rgba(100, 116, 139, 0.06)";
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
        return hl.has(key) ? "rgba(250, 204, 21, 0.9)" : "rgba(100, 116, 139, 0.06)";
      });

    // Tune forces: stronger repulsion + longer links for cleaner layout
    graph.d3Force('charge')?.strength(-120);
    graph.d3Force('link')?.distance((link: FGLink) => {
      const src = typeof link.source === 'object' ? (link.source as FGNode).label : '';
      const tgt = typeof link.target === 'object' ? (link.target as FGNode).label : '';
      // Push files further from repo hub, keep symbols closer to their files
      if (src === 'Repository' || tgt === 'Repository') return 80;
      if (src === 'File' || tgt === 'File') return 40;
      return 30;
    });
    graph.d3Force('center')?.strength(0.05);

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

  return (
    <div className="h-screen bg-gray-950 text-gray-100 flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800 bg-gray-900/80 backdrop-blur">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="text-gray-400 hover:text-white transition-colors text-sm"
          >
            &larr; Back
          </button>
          <h1 className="text-lg font-semibold text-white">Graph Explorer</h1>
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
            className={`text-xs px-3 py-1.5 rounded border transition-colors ${
              highlightDeps
                ? "bg-yellow-900/40 border-yellow-700 text-yellow-400"
                : "bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200"
            }`}
          >
            Highlight Deps
          </button>
          <select
            value={selectedRepoId || ""}
            onChange={(e) => setSelectedRepoId(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.branch})
              </option>
            ))}
          </select>
          <span className="text-xs text-gray-500">
            {graphData.nodes.length} nodes / {graphData.links.length} edges
          </span>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Type filter sidebar */}
        <div className="w-52 border-r border-gray-800 bg-gray-900/50 p-4 flex-shrink-0 overflow-y-auto">
          <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">
            Node Types
          </h3>
          <div className="space-y-1.5">
            {NODE_TYPES.map((type) => (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm transition-colors ${
                  activeTypes.has(type)
                    ? "bg-gray-800 text-gray-100"
                    : "text-gray-600 hover:text-gray-400"
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor: activeTypes.has(type)
                      ? NODE_COLORS[type]
                      : "#4b5563",
                  }}
                />
                <span className="flex-1 text-left">{type}</span>
                <span className="text-xs text-gray-500">
                  {typeCounts[type] || 0}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t border-gray-800 space-y-1.5">
            <button
              onClick={() => setActiveTypes(new Set(NODE_TYPES))}
              className="w-full text-xs text-gray-500 hover:text-gray-300 py-1"
            >
              Show All
            </button>
            <button
              onClick={() => setActiveTypes(new Set())}
              className="w-full text-xs text-gray-500 hover:text-gray-300 py-1"
            >
              Hide All
            </button>
          </div>
        </div>

        {/* Graph canvas */}
        <div className="flex-1 relative">
          {/* force-graph owns this div exclusively — no React children */}
          <div ref={containerRef} className="absolute inset-0" />
          {/* Overlays rendered by React in a separate sibling */}
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-950/80 z-10 pointer-events-none">
              <span className="text-gray-400">Loading graph...</span>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-950/80 z-10 pointer-events-none">
              <span className="text-red-400">{error}</span>
            </div>
          )}
          {!loading && graphData.nodes.length === 0 && !error && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-gray-500">
                {selectedRepoId
                  ? "No graph data. Digest a repository first."
                  : "Select a repository to explore."}
              </span>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <div className="w-96 border-l border-gray-800 bg-gray-900/50 flex flex-col flex-shrink-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor: NODE_COLORS[selectedNode.label] || "#6b7280",
                  }}
                />
                <span className="font-medium text-white truncate">
                  {selectedNode.displayName}
                </span>
                <span className="text-xs text-gray-500 flex-shrink-0">
                  {selectedNode.label}
                </span>
              </div>
              <button
                onClick={() => {
                  setSelectedNode(null);
                  selectedNodeIdRef.current = null;
                  setFileContent(null);
                }}
                className="text-gray-500 hover:text-white text-sm ml-2"
              >
                &times;
              </button>
            </div>

            <div className="px-4 py-3 border-b border-gray-800 overflow-y-auto max-h-60">
              <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">
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

            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="px-4 py-2 border-b border-gray-800">
                <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
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
                  <div className="p-4 text-gray-500 text-sm">Loading...</div>
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
                  <div className="p-4 text-gray-600 text-xs">
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
        className={isHighlighted ? "bg-yellow-900/30" : ""}
      >
        <span className="inline-block text-right text-gray-600 select-none mr-4" style={{ width: `${gutterWidth + 1}ch` }}>
          {lineNum}
        </span>
        {line}
      </div>
    );
  });
}
