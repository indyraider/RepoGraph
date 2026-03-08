/** Language-specific CodeQL configuration. Mirrors the SCIP adapter pattern. */
export interface CodeQLLanguageConfig {
  /** CodeQL language identifier (e.g., "javascript", "python", "java") */
  language: string;
  /** CodeQL query suite/pack to run (e.g., "codeql/javascript-security-queries") */
  querySuite: string;
  /** File extensions this config covers (used for language detection) */
  extensions: string[];
  /** Label for log messages */
  label: string;
}

/** Input to the CodeQL stage. */
export interface CodeQLStageInput {
  repoPath: string;
  repoUrl: string;
  jobId: string;
  commitSha: string;
  /** Languages detected from scanned files */
  detectedLanguages: string[];
}

/** Output from the CodeQL stage. */
export interface CodeQLStageResult {
  stats: CodeQLStats;
  skipped: boolean;
}

/** Stats emitted by the CodeQL stage. */
export interface CodeQLStats {
  status: "success" | "partial" | "failed" | "skipped" | "timeout";
  durationMs: number;
  findingCount: number;
  flowEdgeCount: number;
  unmatchedLocations: number;
  queriesRun: string[];
  reason?: string;
  error?: string;
}

/** A location in a source file (from SARIF output). */
export interface CodeQLLocation {
  file: string;
  line: number;
  column: number;
}

/** A step in a data flow path. */
export interface CodeQLPathStep {
  location: CodeQLLocation;
  message: string;
}

/** A parsed CodeQL finding extracted from SARIF. */
export interface CodeQLFinding {
  queryId: string;
  severity: "error" | "warning" | "note";
  message: string;
  source: CodeQLLocation;
  sink: CodeQLLocation;
  pathSteps: CodeQLPathStep[];
}

/** A CodeQL finding matched to Neo4j graph nodes. */
export interface MatchedFinding extends CodeQLFinding {
  sourceNodeId: string | null;
  sinkNodeId: string | null;
  pathComplete: boolean;
}

/** Result of the CodeQL runner subprocess. */
export interface CodeQLRunResult {
  success: boolean;
  durationMs: number;
  error?: string;
}
