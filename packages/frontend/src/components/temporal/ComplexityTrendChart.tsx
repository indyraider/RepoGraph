import { useState, useEffect } from "react";
import {
  getComplexityTrend,
  getComplexityFiles,
  type ComplexityDataPoint,
} from "../../api";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Loader2, TrendingUp, Inbox } from "lucide-react";

interface Props {
  repoId: string;
}

const METRICS = [
  { value: "coupling_score", label: "Coupling Score" },
  { value: "import_count", label: "Import Count" },
  { value: "reverse_import_count", label: "Reverse Imports" },
  { value: "symbol_count", label: "Symbol Count" },
] as const;

const METRIC_COLORS: Record<string, string> = {
  coupling_score: "#8b5cf6",
  import_count: "#3b82f6",
  reverse_import_count: "#10b981",
  symbol_count: "#f59e0b",
};

export function ComplexityTrendChart({ repoId }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [metric, setMetric] = useState("coupling_score");
  const [data, setData] = useState<ComplexityDataPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [filesLoading, setFilesLoading] = useState(true);

  // Load available files
  useEffect(() => {
    setFilesLoading(true);
    getComplexityFiles(repoId)
      .then((f) => {
        setFiles(f);
        if (f.length > 0 && !selectedFile) setSelectedFile(f[0]);
      })
      .catch(() => setFiles([]))
      .finally(() => setFilesLoading(false));
  }, [repoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load trend data when file or metric changes
  useEffect(() => {
    if (!selectedFile) return;
    setLoading(true);
    getComplexityTrend(repoId, selectedFile, metric)
      .then(setData)
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [repoId, selectedFile, metric]);

  const chartData = data.map((d) => ({
    timestamp: new Date(d.timestamp).toLocaleDateString(),
    value: d.metric_value,
    commit: d.commit_sha.slice(0, 8),
  }));

  if (filesLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Inbox className="w-8 h-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm">No complexity metrics available</p>
        <p className="text-xs mt-1">Run a backfill to compute metrics</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={selectedFile || ""}
          onChange={(e) => setSelectedFile(e.target.value)}
          className="px-3 py-2 rounded-xl bg-gray-800/60 border border-white/[0.06] text-sm text-gray-200 focus:outline-none focus:border-violet-500/40 max-w-xs truncate"
        >
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>

        <div className="flex rounded-xl border border-white/[0.06] overflow-hidden">
          {METRICS.map((m) => (
            <button
              key={m.value}
              onClick={() => setMetric(m.value)}
              className={`px-3 py-1.5 text-xs transition-colors ${
                metric === m.value
                  ? "bg-violet-500/10 text-violet-400"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.02]"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {loading && <Loader2 className="w-4 h-4 animate-spin text-violet-400" />}
      </div>

      {/* Chart */}
      {chartData.length > 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis
                dataKey="timestamp"
                tick={{ fill: "#6b7280", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
              />
              <YAxis
                tick={{ fill: "#6b7280", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1f2937",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: "0.75rem",
                  fontSize: "12px",
                  color: "#e5e7eb",
                }}
                labelStyle={{ color: "#9ca3af" }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke={METRIC_COLORS[metric] || "#8b5cf6"}
                strokeWidth={2}
                dot={{ fill: METRIC_COLORS[metric] || "#8b5cf6", r: 3 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        !loading && (
          <div className="text-center py-12 text-gray-500">
            <TrendingUp className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No data for this file and metric</p>
          </div>
        )
      )}
    </div>
  );
}
