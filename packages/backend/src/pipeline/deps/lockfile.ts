import fs from "fs/promises";
import path from "path";

export interface ParsedDependency {
  name: string;
  version: string;
  registry: "npm" | "pypi" | "go";
}

/**
 * Detect and parse lockfiles in the repo to extract direct dependencies.
 */
export async function parseLockfiles(
  repoPath: string
): Promise<ParsedDependency[]> {
  const deps: ParsedDependency[] = [];

  // Try npm/yarn/pnpm lockfiles — but use package.json for direct deps
  const packageJsonPath = path.join(repoPath, "package.json");
  if (await fileExists(packageJsonPath)) {
    const npmDeps = await parsePackageJson(packageJsonPath);
    deps.push(...npmDeps);
  }

  // Try Python requirements / pyproject
  const requirementsPath = path.join(repoPath, "requirements.txt");
  if (await fileExists(requirementsPath)) {
    const pyDeps = await parseRequirementsTxt(requirementsPath);
    deps.push(...pyDeps);
  }

  const pyprojectPath = path.join(repoPath, "pyproject.toml");
  if (await fileExists(pyprojectPath)) {
    const pyDeps = await parsePyprojectToml(pyprojectPath);
    deps.push(...pyDeps);
  }

  // Try Go go.mod
  const goModPath = path.join(repoPath, "go.mod");
  if (await fileExists(goModPath)) {
    const goDeps = await parseGoMod(goModPath);
    deps.push(...goDeps);
  }

  return deps;
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
 * Parse package.json for direct dependencies (dependencies + devDependencies).
 */
async function parsePackageJson(filePath: string): Promise<ParsedDependency[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  const pkg = JSON.parse(raw);
  const deps: ParsedDependency[] = [];

  const allDeps: Record<string, string> = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  for (const [name, versionSpec] of Object.entries(allDeps)) {
    // Clean version spec: ^1.2.3 → 1.2.3, ~2.0.0 → 2.0.0, etc.
    const version = versionSpec.replace(/^[\^~>=<]+/, "");
    deps.push({ name, version, registry: "npm" });
  }

  return deps;
}

/**
 * Parse requirements.txt for Python dependencies.
 */
async function parseRequirementsTxt(
  filePath: string
): Promise<ParsedDependency[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  const deps: ParsedDependency[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;

    // Handle: package==1.2.3, package>=1.2.3, package~=1.2.3, package
    const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*([>=<~!]+\s*[\d.]+)?/);
    if (match) {
      const name = match[1];
      const version = match[2]?.replace(/^[>=<~!]+\s*/, "") || "latest";
      deps.push({ name, version, registry: "pypi" });
    }
  }

  return deps;
}

/**
 * Parse pyproject.toml for Python dependencies (basic extraction).
 */
async function parsePyprojectToml(
  filePath: string
): Promise<ParsedDependency[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  const deps: ParsedDependency[] = [];

  // Simple regex extraction from [project.dependencies] or [tool.poetry.dependencies]
  const depSection = raw.match(
    /\[(?:project\.dependencies|tool\.poetry\.dependencies)\]\s*\n([\s\S]*?)(?:\n\[|$)/
  );

  if (depSection) {
    for (const line of depSection[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // TOML: package = "^1.2.3" or package = {version = "^1.2.3", ...}
      const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*=\s*"([^"]+)"/);
      if (match) {
        const name = match[1];
        if (name === "python") continue;
        const version = match[2].replace(/^[\^~>=<]+/, "");
        deps.push({ name, version, registry: "pypi" });
      }
    }
  }

  // Also check dependencies array format: dependencies = ["package>=1.0"]
  const arrayMatch = raw.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (arrayMatch) {
    const entries = arrayMatch[1].match(/"([^"]+)"/g);
    if (entries) {
      for (const entry of entries) {
        const clean = entry.replace(/"/g, "");
        const match = clean.match(/^([a-zA-Z0-9_.-]+)\s*([>=<~!]+\s*[\d.]+)?/);
        if (match) {
          deps.push({
            name: match[1],
            version: match[2]?.replace(/^[>=<~!]+\s*/, "") || "latest",
            registry: "pypi",
          });
        }
      }
    }
  }

  return deps;
}

/**
 * Parse go.mod for Go dependencies.
 */
async function parseGoMod(filePath: string): Promise<ParsedDependency[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  const deps: ParsedDependency[] = [];

  // Match require block
  const requireBlock = raw.match(/require\s*\(([\s\S]*?)\)/);
  if (requireBlock) {
    for (const line of requireBlock[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;

      const match = trimmed.match(/^(\S+)\s+(\S+)/);
      if (match) {
        deps.push({
          name: match[1],
          version: match[2].replace(/^v/, ""),
          registry: "go",
        });
      }
    }
  }

  // Match single-line requires
  const singleRequires = raw.matchAll(/require\s+(\S+)\s+(\S+)/g);
  for (const match of singleRequires) {
    deps.push({
      name: match[1],
      version: match[2].replace(/^v/, ""),
      registry: "go",
    });
  }

  return deps;
}
