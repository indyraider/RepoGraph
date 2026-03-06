import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import Parser from "tree-sitter";
import TypeScriptLang from "tree-sitter-typescript";

const TSParser = TypeScriptLang.typescript;

export interface PackageExportSymbol {
  name: string;
  kind: "function" | "class" | "type" | "constant";
  signature: string;
}

const parser = new Parser();
parser.setLanguage(TSParser);

// Cache to avoid re-fetching types within a single digest
const cache = new Map<string, PackageExportSymbol[]>();

/**
 * Fetch and parse type definitions for an npm package.
 * Strategy:
 *  1. Check if the package bundles its own types (types/typings field in package.json)
 *  2. Try @types/<package> from DefinitelyTyped
 *  3. If neither available, return empty (package without types)
 */
export async function fetchPackageExports(
  packageName: string,
  version: string
): Promise<PackageExportSymbol[]> {
  const cacheKey = `${packageName}@${version}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const tmpDir = path.join(os.tmpdir(), "repograph-types", sanitizeName(packageName));

  try {
    await fs.mkdir(tmpDir, { recursive: true });

    // Try fetching the package itself first (might bundle types)
    let dtsContent = await tryFetchBundledTypes(packageName, version, tmpDir);

    // Fallback to @types package
    if (!dtsContent) {
      const typesPackage = getTypesPackageName(packageName);
      dtsContent = await tryFetchDefinitelyTyped(typesPackage, tmpDir);
    }

    if (!dtsContent) {
      cache.set(cacheKey, []);
      return [];
    }

    const symbols = parseDtsContent(dtsContent);
    cache.set(cacheKey, symbols);
    return symbols;
  } catch (err) {
    console.warn(
      `Failed to fetch types for ${packageName}@${version}:`,
      err instanceof Error ? err.message : err
    );
    cache.set(cacheKey, []);
    return [];
  } finally {
    // Cleanup
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getTypesPackageName(packageName: string): string {
  // @scope/package → @types/scope__package
  if (packageName.startsWith("@")) {
    return "@types/" + packageName.slice(1).replace("/", "__");
  }
  return `@types/${packageName}`;
}

/**
 * Try to fetch bundled types from the package itself.
 * Downloads the package tarball, extracts it, and looks for .d.ts files.
 */
async function tryFetchBundledTypes(
  packageName: string,
  version: string,
  tmpDir: string
): Promise<string | null> {
  try {
    // Use npm pack to download the package
    execSync(
      `npm pack ${packageName}@${version} --pack-destination "${tmpDir}" 2>/dev/null`,
      { stdio: "pipe", timeout: 30000 }
    );

    // Find the tarball
    const files = await fs.readdir(tmpDir);
    const tarball = files.find((f) => f.endsWith(".tgz"));
    if (!tarball) return null;

    // Extract
    const extractDir = path.join(tmpDir, "extracted");
    await fs.mkdir(extractDir, { recursive: true });
    execSync(`tar -xzf "${path.join(tmpDir, tarball)}" -C "${extractDir}" 2>/dev/null`, {
      stdio: "pipe",
      timeout: 15000,
    });

    // Check package.json for types/typings field
    const pkgJsonPath = path.join(extractDir, "package", "package.json");
    if (await fileExists(pkgJsonPath)) {
      const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, "utf-8"));
      const typesEntry = pkgJson.types || pkgJson.typings;
      if (typesEntry) {
        const dtsPath = path.join(extractDir, "package", typesEntry);
        if (await fileExists(dtsPath)) {
          return await fs.readFile(dtsPath, "utf-8");
        }
      }
    }

    // Fallback: look for index.d.ts
    const indexDts = path.join(extractDir, "package", "index.d.ts");
    if (await fileExists(indexDts)) {
      return await fs.readFile(indexDts, "utf-8");
    }

    // Look in dist/
    const distDts = path.join(extractDir, "package", "dist", "index.d.ts");
    if (await fileExists(distDts)) {
      return await fs.readFile(distDts, "utf-8");
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Try to fetch type definitions from @types/<package>.
 */
async function tryFetchDefinitelyTyped(
  typesPackage: string,
  tmpDir: string
): Promise<string | null> {
  try {
    const dtDir = path.join(tmpDir, "dt");
    await fs.mkdir(dtDir, { recursive: true });

    execSync(
      `npm pack ${typesPackage} --pack-destination "${dtDir}" 2>/dev/null`,
      { stdio: "pipe", timeout: 30000 }
    );

    const files = await fs.readdir(dtDir);
    const tarball = files.find((f) => f.endsWith(".tgz"));
    if (!tarball) return null;

    const extractDir = path.join(dtDir, "extracted");
    await fs.mkdir(extractDir, { recursive: true });
    execSync(`tar -xzf "${path.join(dtDir, tarball)}" -C "${extractDir}" 2>/dev/null`, {
      stdio: "pipe",
      timeout: 15000,
    });

    // Look for index.d.ts
    const indexDts = path.join(extractDir, "package", "index.d.ts");
    if (await fileExists(indexDts)) {
      return await fs.readFile(indexDts, "utf-8");
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse .d.ts content with tree-sitter to extract exported symbols.
 */
function parseDtsContent(content: string): PackageExportSymbol[] {
  const symbols: PackageExportSymbol[] = [];
  const tree = parser.parse(content);
  const seen = new Set<string>();

  function walk(node: Parser.SyntaxNode) {
    switch (node.type) {
      case "export_statement": {
        for (const child of node.namedChildren) {
          extractDeclaration(child, symbols, seen);
        }
        break;
      }

      case "ambient_declaration": {
        // declare function, declare class, declare const, etc.
        for (const child of node.namedChildren) {
          extractDeclaration(child, symbols, seen);
        }
        break;
      }

      case "module": {
        // declare module "..." { ... }
        // Walk into module body for exports
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            walk(child);
          }
        }
        break;
      }

      default:
        // Top-level declarations (may be implicitly exported in .d.ts)
        if (isDeclaration(node.type)) {
          extractDeclaration(node, symbols, seen);
        } else {
          for (const child of node.namedChildren) {
            walk(child);
          }
        }
    }
  }

  for (const child of tree.rootNode.namedChildren) {
    walk(child);
  }

  return symbols;
}

function isDeclaration(type: string): boolean {
  return [
    "function_declaration",
    "function_signature",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "lexical_declaration",
    "variable_declaration",
    "enum_declaration",
  ].includes(type);
}

function extractDeclaration(
  node: Parser.SyntaxNode,
  symbols: PackageExportSymbol[],
  seen: Set<string>
): void {
  let name = "";
  let kind: PackageExportSymbol["kind"] = "function";
  let signature = "";

  switch (node.type) {
    case "function_declaration":
    case "function_signature": {
      name = node.childForFieldName("name")?.text || "";
      kind = "function";
      // Get first line as signature
      signature = node.text.split("\n")[0].trim();
      if (signature.length > 200) signature = signature.substring(0, 200) + "...";
      break;
    }

    case "class_declaration": {
      name = node.childForFieldName("name")?.text || "";
      kind = "class";
      signature = node.text.split("\n")[0].trim();
      if (signature.length > 200) signature = signature.substring(0, 200) + "...";
      break;
    }

    case "interface_declaration":
    case "type_alias_declaration": {
      name = node.childForFieldName("name")?.text || "";
      kind = "type";
      signature = node.text.split("\n")[0].trim();
      if (signature.length > 200) signature = signature.substring(0, 200) + "...";
      break;
    }

    case "lexical_declaration":
    case "variable_declaration": {
      for (const decl of node.namedChildren) {
        if (decl.type === "variable_declarator") {
          const declName = decl.childForFieldName("name")?.text || "";
          if (declName && !seen.has(declName)) {
            seen.add(declName);
            symbols.push({
              name: declName,
              kind: "constant",
              signature: node.text.split("\n")[0].trim().substring(0, 200),
            });
          }
        }
      }
      return; // handled inline
    }

    case "enum_declaration": {
      name = node.childForFieldName("name")?.text || "";
      kind = "type";
      signature = node.text.split("\n")[0].trim();
      break;
    }

    default:
      return;
  }

  if (name && !seen.has(name)) {
    seen.add(name);
    symbols.push({ name, kind, signature });
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the types cache (call between digests if needed).
 */
export function clearTypesCache(): void {
  cache.clear();
}
