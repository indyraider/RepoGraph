import { readFile } from "fs/promises";
import { CodeQLFinding, CodeQLLocation, CodeQLPathStep } from "./types.js";

/**
 * SARIF (Static Analysis Results Interchange Format) types.
 * Only the subset we need from the spec.
 */
interface SarifLog {
  $schema?: string;
  version: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: { driver: { name: string; rules?: SarifRule[] } };
  results?: SarifResult[];
}

interface SarifRule {
  id: string;
  defaultConfiguration?: { level?: string };
}

interface SarifResult {
  ruleId?: string;
  level?: "error" | "warning" | "note" | "none";
  message: { text?: string };
  locations?: SarifLocation[];
  codeFlows?: SarifCodeFlow[];
  relatedLocations?: SarifLocation[];
}

interface SarifLocation {
  id?: number;
  physicalLocation?: {
    artifactLocation?: { uri?: string };
    region?: { startLine?: number; startColumn?: number };
  };
  message?: { text?: string };
}

interface SarifCodeFlow {
  threadFlows: SarifThreadFlow[];
}

interface SarifThreadFlow {
  locations: SarifThreadFlowLocation[];
}

interface SarifThreadFlowLocation {
  location: SarifLocation;
}

/**
 * Extract a CodeQLLocation from a SARIF physical location.
 * Returns null if the location is missing required fields.
 */
function extractLocation(loc: SarifLocation | undefined): CodeQLLocation | null {
  if (!loc?.physicalLocation) return null;

  const uri = loc.physicalLocation.artifactLocation?.uri;
  const region = loc.physicalLocation.region;

  if (!uri || !region?.startLine) return null;

  // SARIF URIs are relative to the source root, strip leading file:// or ./
  const file = uri.replace(/^file:\/\//, "").replace(/^\.\//, "");

  return {
    file,
    line: region.startLine,
    column: region.startColumn ?? 1,
  };
}

/**
 * Map SARIF level to our severity type.
 */
function mapSeverity(level?: string): "error" | "warning" | "note" {
  switch (level) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "note":
    case "none":
    default:
      return "note";
  }
}

/**
 * Extract source and sink from a CodeQL result.
 *
 * CodeQL data flow results use codeFlows to show the full path.
 * The first location in the first threadFlow is the source,
 * and the last location is the sink.
 *
 * For results without codeFlows (simple alerts), source = sink = the result location.
 */
function extractSourceSink(
  result: SarifResult
): { source: CodeQLLocation; sink: CodeQLLocation; pathSteps: CodeQLPathStep[] } | null {
  // Try codeFlows first (data flow results)
  if (result.codeFlows && result.codeFlows.length > 0) {
    const threadFlow = result.codeFlows[0].threadFlows[0];
    if (threadFlow && threadFlow.locations.length >= 2) {
      const steps = threadFlow.locations;
      const sourceLoc = extractLocation(steps[0].location);
      const sinkLoc = extractLocation(steps[steps.length - 1].location);

      if (!sourceLoc || !sinkLoc) return null;

      // Intermediate steps (everything between source and sink)
      const pathSteps: CodeQLPathStep[] = [];
      for (const step of steps) {
        const loc = extractLocation(step.location);
        if (loc) {
          pathSteps.push({
            location: loc,
            message: step.location.message?.text ?? "",
          });
        }
      }

      return { source: sourceLoc, sink: sinkLoc, pathSteps };
    }
  }

  // Fallback: use the result's primary location as both source and sink
  // (simple alert, not a data flow result)
  if (result.locations && result.locations.length > 0) {
    const loc = extractLocation(result.locations[0]);
    if (!loc) return null;

    return {
      source: loc,
      sink: loc,
      pathSteps: [{ location: loc, message: result.message.text ?? "" }],
    };
  }

  return null;
}

/**
 * Parse a SARIF file and extract CodeQL findings.
 *
 * @param filePath - Path to the SARIF JSON file
 * @returns Array of parsed findings
 * @throws If the file cannot be read or is not valid SARIF
 */
export async function parseSarif(filePath: string): Promise<CodeQLFinding[]> {
  const content = await readFile(filePath, "utf-8");
  let sarif: SarifLog;

  try {
    sarif = JSON.parse(content);
  } catch {
    throw new Error(`Invalid SARIF JSON in ${filePath}`);
  }

  if (!sarif.runs || sarif.runs.length === 0) {
    return [];
  }

  const findings: CodeQLFinding[] = [];
  // Deduplicate by queryId + source + sink
  const seen = new Set<string>();

  for (const run of sarif.runs) {
    // Build rule-level severity map (rules may specify default severity)
    const ruleSeverityMap = new Map<string, string>();
    if (run.tool.driver.rules) {
      for (const rule of run.tool.driver.rules) {
        if (rule.defaultConfiguration?.level) {
          ruleSeverityMap.set(rule.id, rule.defaultConfiguration.level);
        }
      }
    }

    if (!run.results) continue;

    for (const result of run.results) {
      const queryId = result.ruleId ?? "unknown";
      const sourceSink = extractSourceSink(result);
      if (!sourceSink) continue;

      // Deduplicate: same query + same source + same sink = same finding
      const dedupeKey = `${queryId}:${sourceSink.source.file}:${sourceSink.source.line}:${sourceSink.sink.file}:${sourceSink.sink.line}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // Severity: result-level overrides rule-level
      const severity = mapSeverity(
        result.level ?? ruleSeverityMap.get(queryId)
      );

      findings.push({
        queryId,
        severity,
        message: result.message.text ?? "",
        source: sourceSink.source,
        sink: sourceSink.sink,
        pathSteps: sourceSink.pathSteps,
      });
    }
  }

  console.log(`[codeql] Parsed ${findings.length} findings from SARIF`);
  return findings;
}
