import path from "path";
import fs from "fs";
import { ParsedImport } from "./parser.js";

export interface ResolvedImport {
  fromFile: string;
  toFile: string | null; // null = external package
  toPackage: string | null; // non-null = external package
  symbols: string[];
  defaultImport: string | null;
}

interface TsConfigPaths {
  baseUrl: string;
  paths: Record<string, string[]>;
}

function loadTsConfig(repoPath: string): TsConfigPaths | null {
  const tsconfigPath = path.join(repoPath, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return null;

  try {
    const raw = fs.readFileSync(tsconfigPath, "utf-8");
    // Strip comments (simple approach — handles // and /* */ in most cases)
    const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const config = JSON.parse(stripped);
    const compilerOptions = config.compilerOptions || {};

    return {
      baseUrl: compilerOptions.baseUrl || ".",
      paths: compilerOptions.paths || {},
    };
  } catch {
    return null;
  }
}

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_FILES = TS_EXTENSIONS.map((ext) => `index${ext}`);

function resolveRelativePath(
  fromFile: string,
  importSource: string,
  repoPath: string
): string | null {
  const fromDir = path.dirname(path.join(repoPath, fromFile));
  const candidate = path.resolve(fromDir, importSource);

  // Try exact path
  for (const ext of TS_EXTENSIONS) {
    const full = candidate + ext;
    if (fs.existsSync(full)) {
      return path.relative(repoPath, full);
    }
  }

  // Try as directory with index file
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    for (const idx of INDEX_FILES) {
      const full = path.join(candidate, idx);
      if (fs.existsSync(full)) {
        return path.relative(repoPath, full);
      }
    }
  }

  // Try exact (already has extension)
  if (fs.existsSync(candidate)) {
    return path.relative(repoPath, candidate);
  }

  return null;
}

function resolveAliasPath(
  importSource: string,
  tsConfig: TsConfigPaths,
  repoPath: string
): string | null {
  for (const [pattern, replacements] of Object.entries(tsConfig.paths)) {
    // Handle patterns like "@/*" → ["src/*"]
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, "(.*)") + "$"
    );
    const match = importSource.match(regex);

    if (match) {
      for (const replacement of replacements) {
        const resolved = replacement.replace(/\*/g, match[1] || "");
        const fullPath = path.join(repoPath, tsConfig.baseUrl, resolved);

        // Try with extensions
        for (const ext of TS_EXTENSIONS) {
          const withExt = fullPath + ext;
          if (fs.existsSync(withExt)) {
            return path.relative(repoPath, withExt);
          }
        }

        // Try as directory
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
          for (const idx of INDEX_FILES) {
            const withIdx = path.join(fullPath, idx);
            if (fs.existsSync(withIdx)) {
              return path.relative(repoPath, withIdx);
            }
          }
        }

        if (fs.existsSync(fullPath)) {
          return path.relative(repoPath, fullPath);
        }
      }
    }
  }
  return null;
}

function isRelativeImport(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

function isBareSpecifier(source: string): boolean {
  return !source.startsWith(".") && !source.startsWith("/");
}

function extractPackageName(source: string): string {
  // Handle scoped packages: @scope/package/path → @scope/package
  if (source.startsWith("@")) {
    const parts = source.split("/");
    return parts.slice(0, 2).join("/");
  }
  // Regular: package/path → package
  return source.split("/")[0];
}

export function resolveImports(
  parsedImports: ParsedImport[],
  repoPath: string
): ResolvedImport[] {
  const tsConfig = loadTsConfig(repoPath);
  const resolved: ResolvedImport[] = [];

  for (const imp of parsedImports) {
    const { source, symbols, defaultImport, filePath } = imp;

    // Skip Node built-ins
    if (
      source.startsWith("node:") ||
      ["fs", "path", "url", "crypto", "http", "https", "stream", "util", "os", "child_process", "events", "buffer", "querystring", "assert", "net", "tls", "dns", "zlib"].includes(source)
    ) {
      continue;
    }

    let toFile: string | null = null;
    let toPackage: string | null = null;

    if (isRelativeImport(source)) {
      toFile = resolveRelativePath(filePath, source, repoPath);
      if (!toFile) {
        // Couldn't resolve — might still be a valid file we didn't index
        // Create a best-guess path
        toFile = null;
        toPackage = null; // skip entirely
        continue;
      }
    } else if (isBareSpecifier(source)) {
      // Try tsconfig alias first
      if (tsConfig) {
        toFile = resolveAliasPath(source, tsConfig, repoPath);
      }

      if (!toFile) {
        // It's an external package
        toPackage = extractPackageName(source);
      }
    } else {
      // Absolute path
      toFile = resolveRelativePath(filePath, source, repoPath);
    }

    resolved.push({
      fromFile: filePath,
      toFile,
      toPackage,
      symbols,
      defaultImport,
    });
  }

  return resolved;
}
