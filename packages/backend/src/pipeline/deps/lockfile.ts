import fs from "fs/promises";
import path from "path";

export interface ParsedDependency {
  name: string;
  version: string;
  registry: "npm" | "pypi" | "go" | "cargo" | "maven";
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

  // Try Rust Cargo.toml
  const cargoTomlPath = path.join(repoPath, "Cargo.toml");
  if (await fileExists(cargoTomlPath)) {
    const cargoDeps = await parseCargoToml(cargoTomlPath);
    deps.push(...cargoDeps);
  }

  // Try Maven pom.xml
  const pomXmlPath = path.join(repoPath, "pom.xml");
  if (await fileExists(pomXmlPath)) {
    const mavenDeps = await parsePomXml(pomXmlPath);
    deps.push(...mavenDeps);
  }

  // Try Gradle build files
  for (const gradleFile of ["build.gradle", "build.gradle.kts"]) {
    const gradlePath = path.join(repoPath, gradleFile);
    if (await fileExists(gradlePath)) {
      const gradleDeps = await parseBuildGradle(gradlePath);
      deps.push(...gradleDeps);
      break; // Only parse one build file
    }
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

/**
 * Parse Cargo.toml for Rust dependencies.
 */
async function parseCargoToml(filePath: string): Promise<ParsedDependency[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  const deps: ParsedDependency[] = [];

  // Parse [dependencies] and [dev-dependencies] sections
  const sections = ["dependencies", "dev-dependencies", "build-dependencies"];

  for (const section of sections) {
    // Match the section header and everything until the next section or EOF
    const sectionRegex = new RegExp(
      `\\[${section.replace("-", "\\-")}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`
    );
    const sectionMatch = raw.match(sectionRegex);
    if (!sectionMatch) continue;

    for (const line of sectionMatch[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;

      // Simple format: package = "1.2.3"
      const simpleMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/);
      if (simpleMatch) {
        deps.push({
          name: simpleMatch[1],
          version: simpleMatch[2].replace(/^[\^~>=<]+/, ""),
          registry: "cargo",
        });
        continue;
      }

      // Table format: package = { version = "1.2.3", features = [...] }
      const tableMatch = trimmed.match(
        /^([a-zA-Z0-9_-]+)\s*=\s*\{.*?version\s*=\s*"([^"]+)"/
      );
      if (tableMatch) {
        deps.push({
          name: tableMatch[1],
          version: tableMatch[2].replace(/^[\^~>=<]+/, ""),
          registry: "cargo",
        });
        continue;
      }

      // Package without version (e.g., path or git dependencies):
      // package = { path = "../local" } or package = { git = "..." }
      const noVersionMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{/);
      if (noVersionMatch) {
        deps.push({
          name: noVersionMatch[1],
          version: "path",
          registry: "cargo",
        });
      }
    }
  }

  return deps;
}

/**
 * Parse pom.xml for Maven dependencies.
 */
async function parsePomXml(filePath: string): Promise<ParsedDependency[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  const deps: ParsedDependency[] = [];

  // Extract property values for ${property} substitution (best-effort)
  const properties = new Map<string, string>();
  const propsMatch = raw.match(/<properties>([\s\S]*?)<\/properties>/);
  if (propsMatch) {
    const propRegex = /<([a-zA-Z0-9._-]+)>([^<]+)<\/\1>/g;
    let propMatch;
    while ((propMatch = propRegex.exec(propsMatch[1])) !== null) {
      properties.set(propMatch[1], propMatch[2]);
    }
  }

  function resolveProperty(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_, key) => properties.get(key) || `\${${key}}`);
  }

  // Match <dependency> blocks (both in <dependencies> and <dependencyManagement>)
  const depRegex = /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g;
  let match;
  while ((match = depRegex.exec(raw)) !== null) {
    const groupId = match[1].trim();
    const artifactId = match[2].trim();
    const rawVersion = match[3]?.trim() || "managed";
    const version = resolveProperty(rawVersion);

    deps.push({
      name: `${groupId}:${artifactId}`,
      version,
      registry: "maven",
    });
  }

  return deps;
}

/**
 * Parse build.gradle or build.gradle.kts for Gradle dependencies.
 */
async function parseBuildGradle(filePath: string): Promise<ParsedDependency[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  const deps: ParsedDependency[] = [];
  const seen = new Set<string>();

  // Groovy DSL: implementation 'group:artifact:version'
  // Also: api, compileOnly, testImplementation, runtimeOnly, etc.
  const groovyRegex = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|classpath)\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = groovyRegex.exec(raw)) !== null) {
    const parts = match[1].split(":");
    if (parts.length >= 2) {
      const name = `${parts[0]}:${parts[1]}`;
      if (seen.has(name)) continue;
      seen.add(name);
      deps.push({
        name,
        version: parts[2] || "latest",
        registry: "maven",
      });
    }
  }

  // Kotlin DSL: implementation("group:artifact:version")
  const kotlinDslRegex = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|classpath)\(["']([^"']+)["']\)/g;
  while ((match = kotlinDslRegex.exec(raw)) !== null) {
    const parts = match[1].split(":");
    if (parts.length >= 2) {
      const name = `${parts[0]}:${parts[1]}`;
      if (seen.has(name)) continue;
      seen.add(name);
      deps.push({
        name,
        version: parts[2] || "latest",
        registry: "maven",
      });
    }
  }

  return deps;
}
