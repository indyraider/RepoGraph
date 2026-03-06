/**
 * Stack Trace Parser — extracts file paths, line numbers, and function names
 * from raw stack trace strings across multiple languages/runtimes.
 */

export interface ParsedFrame {
  filePath: string;
  lineNumber: number;
  columnNumber?: number;
  functionName?: string;
}

// Container/serverless path prefixes to strip
const PATH_PREFIXES_TO_STRIP = [
  /^\/var\/task\//,
  /^\/app\//,
  /^\/home\/\w+\//,
  /^\/opt\/\w+\//,
  /^\/workspace\//,
];

function stripContainerPrefix(filePath: string): string {
  for (const prefix of PATH_PREFIXES_TO_STRIP) {
    if (prefix.test(filePath)) {
      return filePath.replace(prefix, "");
    }
  }
  return filePath;
}

// Node.js: "    at functionName (src/api/payments.ts:142:18)"
// Also matches: "    at src/api/payments.ts:142:18" (no function name)
const NODE_JS_FRAME =
  /at\s+(?:(.+?)\s+\()?(.+?):(\d+)(?::(\d+))?\)?/;

// Python: '  File "src/api/payments.py", line 142, in process_payment'
const PYTHON_FRAME =
  /File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?/;

// Go: "goroutine 1 [running]:" followed by "src/api/payments.go:142"
// or "src/api/payments.go:142 +0x1a3"
const GO_FRAME =
  /^\s*(.+\.go):(\d+)/;

/**
 * Parse a raw stack trace string into structured frames.
 * Returns an empty array if no frames could be parsed (never throws).
 */
export function parseStackTrace(stackTrace: string): ParsedFrame[] {
  if (!stackTrace) return [];

  const frames: ParsedFrame[] = [];
  const lines = stackTrace.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Try Node.js format
    const nodeMatch = trimmed.match(NODE_JS_FRAME);
    if (nodeMatch) {
      const filePath = stripContainerPrefix(nodeMatch[2]);
      // Skip node_modules and internal frames
      if (filePath.includes("node_modules/") || filePath.startsWith("node:")) continue;
      frames.push({
        functionName: nodeMatch[1] || undefined,
        filePath,
        lineNumber: parseInt(nodeMatch[3], 10),
        columnNumber: nodeMatch[4] ? parseInt(nodeMatch[4], 10) : undefined,
      });
      continue;
    }

    // Try Python format
    const pyMatch = trimmed.match(PYTHON_FRAME);
    if (pyMatch) {
      const filePath = stripContainerPrefix(pyMatch[1]);
      if (filePath.includes("site-packages/") || filePath.startsWith("<")) continue;
      frames.push({
        filePath,
        lineNumber: parseInt(pyMatch[2], 10),
        functionName: pyMatch[3] || undefined,
      });
      continue;
    }

    // Try Go format
    const goMatch = trimmed.match(GO_FRAME);
    if (goMatch) {
      const filePath = stripContainerPrefix(goMatch[1]);
      if (filePath.includes("/pkg/mod/")) continue;
      frames.push({
        filePath,
        lineNumber: parseInt(goMatch[2], 10),
      });
      continue;
    }
  }

  return frames;
}
