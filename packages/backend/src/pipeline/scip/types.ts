import { ParsedSymbol, ParsedExport } from "../parser.js";
import { DirectlyImportsEdge } from "../resolver.js";
import { ScannedFile } from "../scanner.js";

/** Diagnostic info extracted from the SCIP index. */
export interface DiagnosticInfo {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  filePath: string;
  line: number;
}

/** A caller→callee edge with optional type info. */
export interface CallsEdge {
  callerFilePath: string;
  callerName: string;
  calleeFilePath: string;
  calleeName: string;
  callSiteLine: number;
  argTypes?: string[];
  argExpressions?: string[];
  hasTypeMismatch?: boolean;
  typeMismatchDetail?: string;
}

/** Stats emitted by the SCIP stage. */
export interface ScipStats {
  scipStatus: "success" | "partial" | "skipped" | "failed" | "timeout" | "cache_hit" | "skipped_no_ts";
  scipDurationMs: number;
  scipSymbolCount: number;
  scipOccurrenceCount: number;
  scipDiagnosticCount: number;
  unmatchedScipSymbols: number;
  callsEdgeCount: number;
  reason?: string;
}

/** Input to the SCIP stage. */
export interface ScipStageInput {
  repoPath: string;
  repoUrl: string;
  jobId: string;
  commitSha: string;
  allFiles: ScannedFile[];
  allSymbols: ParsedSymbol[];
  allExports: ParsedExport[];
  directImports: DirectlyImportsEdge[];
}

/** Output from the SCIP stage. */
export interface ScipStageResult {
  enrichedSymbols: ParsedSymbol[];
  callsEdges: CallsEdge[];
  enrichedDirectImports: DirectlyImportsEdge[];
  diagnostics: DiagnosticInfo[];
  stats: ScipStats;
  skipped: boolean;
}
