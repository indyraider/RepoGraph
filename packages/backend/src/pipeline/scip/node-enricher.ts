import { SymbolTableEntry } from "./symbol-table.js";
import { ScipDocument, ScipDiagnostic } from "./parser.js";
import { DiagnosticInfo } from "./types.js";

/**
 * Enrich ParsedSymbol objects with type information from SCIP.
 * Mutates ParsedSymbol objects in place via the symbol table entries.
 */
export function enrichSymbols(
  table: Map<string, SymbolTableEntry>
): void {
  for (const entry of table.values()) {
    const { parsed, scip: scipSym } = entry;

    // Extract resolved signature
    if (scipSym.signatureText) {
      parsed.resolvedSignature = scipSym.signatureText;

      // Parse param types and return type from the signature
      const typeInfo = parseSignature(scipSym.signatureText, parsed.kind);
      if (typeInfo) {
        if (typeInfo.paramTypes.length > 0) {
          parsed.paramTypes = typeInfo.paramTypes;
        }
        if (typeInfo.returnType) {
          parsed.returnType = typeInfo.returnType;
        }
        if (typeInfo.isGeneric) {
          parsed.isGeneric = true;
        }
        if (typeInfo.typeParams.length > 0) {
          parsed.typeParams = typeInfo.typeParams;
        }
      }
    }
  }
}

/**
 * Collect diagnostics from SCIP documents and attach them to the relevant
 * ParsedSymbol objects via the symbol table.
 */
export function attachDiagnostics(
  scipDocuments: ScipDocument[],
  table: Map<string, SymbolTableEntry>,
  repoPath: string
): DiagnosticInfo[] {
  const repoPrefix = repoPath.endsWith("/") ? repoPath : repoPath + "/";
  const allDiagnostics: DiagnosticInfo[] = [];

  // Build a lookup from relative file path -> ParsedSymbol[] (from table)
  const fileSymbols = new Map<string, SymbolTableEntry[]>();
  for (const entry of table.values()) {
    const relPath = entry.parsed.filePath.startsWith(repoPrefix)
      ? entry.parsed.filePath.slice(repoPrefix.length)
      : entry.parsed.filePath;
    const list = fileSymbols.get(relPath) || [];
    list.push(entry);
    fileSymbols.set(relPath, list);
  }

  for (const doc of scipDocuments) {
    for (const diag of doc.diagnostics) {
      const severity = mapSeverity(diag.severity);
      const diagInfo: DiagnosticInfo = {
        severity,
        code: diag.code,
        message: diag.message,
        filePath: doc.relativePath,
        line: diag.range[0] + 1, // SCIP 0-indexed -> 1-indexed
      };

      // Only store errors for v1 (per plan: "errors-only is recommended for v1")
      if (severity !== "error") continue;

      allDiagnostics.push(diagInfo);

      // Attach to the containing symbol if possible
      const entries = fileSymbols.get(doc.relativePath);
      if (entries) {
        const line1 = diag.range[0] + 1;
        for (const entry of entries) {
          if (entry.parsed.startLine <= line1 && entry.parsed.endLine >= line1) {
            if (!entry.parsed.typeErrors) {
              entry.parsed.typeErrors = [];
            }
            entry.parsed.typeErrors.push({
              severity,
              code: diag.code,
              message: diag.message,
              line: line1,
            });
            break; // attach to the first matching symbol
          }
        }
      }
    }
  }

  return allDiagnostics;
}

function mapSeverity(scipSeverity: number): "error" | "warning" | "info" {
  switch (scipSeverity) {
    case 1: return "error";
    case 2: return "warning";
    default: return "info";
  }
}

interface SignatureInfo {
  paramTypes: string[];
  returnType: string | null;
  isGeneric: boolean;
  typeParams: string[];
}

/**
 * Parse a TypeScript-style type signature to extract param types and return type.
 *
 * Handles signatures like:
 *   (order: Order, count: number) => Promise<Result>
 *   <T extends Base>(items: T[]) => T
 *   class MyClass<T>
 */
function parseSignature(signature: string, kind: string): SignatureInfo | null {
  const result: SignatureInfo = {
    paramTypes: [],
    returnType: null,
    isGeneric: false,
    typeParams: [],
  };

  // Check for generic type parameters <T, U extends X>
  const genericMatch = signature.match(/^<([^>]+)>/);
  if (genericMatch) {
    result.isGeneric = true;
    result.typeParams = genericMatch[1].split(",").map((t) => t.trim());
  }

  if (kind === "class" || kind === "type") {
    // For classes, look for type params in the class signature
    const classGeneric = signature.match(/(?:class|interface|type)\s+\w+\s*<([^>]+)>/);
    if (classGeneric) {
      result.isGeneric = true;
      result.typeParams = classGeneric[1].split(",").map((t) => t.trim());
    }
    return result;
  }

  // For functions: parse parameter list and return type
  // Find the parameter list within parentheses, handling nested parens/generics
  const paramStart = signature.indexOf("(");
  if (paramStart === -1) return result;

  let depth = 0;
  let paramEnd = -1;
  for (let i = paramStart; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "<") depth++;
    else if (ch === ">" && signature[i - 1] !== "=" && signature[i - 1] !== "!") depth--;
    if (depth === 0 && ch === ")") {
      paramEnd = i;
      break;
    }
  }
  if (paramEnd === -1) return result;

  // Extract parameter types
  const paramStr = signature.slice(paramStart + 1, paramEnd);
  if (paramStr.trim()) {
    // Split on commas, but not within nested brackets
    const params = splitTopLevel(paramStr, ",");
    for (const param of params) {
      const colonIdx = param.indexOf(":");
      if (colonIdx !== -1) {
        result.paramTypes.push(param.slice(colonIdx + 1).trim());
      }
    }
  }

  // Extract return type (after =>)
  const afterParams = signature.slice(paramEnd + 1).trim();
  const arrowMatch = afterParams.match(/^(?::|\s*=>)\s*(.+)/);
  if (arrowMatch) {
    result.returnType = arrowMatch[1].trim();
  }

  return result;
}

/**
 * Split a string on a delimiter, but only at the top level
 * (not within parentheses, brackets, or angle brackets).
 */
function splitTopLevel(str: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "<") depth++;
    else if (char === ">" && str[i - 1] !== "=" && str[i - 1] !== "!") depth--;
    if (depth === 0 && char === delimiter) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}
