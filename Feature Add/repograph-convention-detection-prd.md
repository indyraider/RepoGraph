# RepoGraph — Feature Add-On PRD: Convention Detection

**Add-On To:** RepoGraph v1.0 PRD  
**Version:** 1.0  
**Date:** March 7, 2026  
**Status:** Draft  
**Phase:** 2 Extension (depends on Structural Graph + Name Resolution)  

---

## 1. Overview

Convention detection turns the structural graph into a pattern recognizer. It statistically analyzes every file, function, class, and import in the graph to extract the implicit conventions of a codebase — naming patterns, file organization rules, import structures, error handling approaches, test co-location strategies, and component composition patterns — then exposes those conventions to Claude Code as queryable rules.

Without convention detection, Claude can infer patterns from whatever files it happens to read. If it reads three React components and all three use PascalCase filenames with named exports and co-located test files, it might follow suit. But if it reads a fourth that diverges, it has no way to know which pattern is the norm and which is the outlier. It is inferring from a sample of 3 or 4 when the codebase has 500 components. Convention detection analyzes all 500 and reports: "94% of components use PascalCase filenames with named exports and co-located `.test.tsx` files. 6% diverge — here are the outliers."

This is the difference between Claude guessing at conventions and Claude *knowing* them. The impact on active development is direct: every new file Claude creates, every function it writes, every import it adds matches the statistical norm of the codebase — not because the developer wrote a style guide and pasted it into the prompt, but because the graph already contains the answer.

---

## 2. Problem Statement

Claude Code is good at reading a few files and mimicking their style. But mimicry from a small sample fails in three systematic ways that convention detection solves:

**Small-sample bias.** When Claude reads 3–5 files to infer a pattern, it may hit an unrepresentative sample. The three API route files it read all use inline validation, but 90% of the codebase's 80 route files use Zod schemas. Claude writes inline validation. The developer corrects it, loses time, and gradually loses trust in Claude's ability to write code that fits. Convention detection eliminates this by analyzing the full population, not a sample.

**Invisible structural conventions.** Some conventions are not visible in any single file — they are relational patterns that only emerge when you look at the graph. "Every service file has a corresponding test file in the same directory." "Every API route imports from a shared middleware barrel." "Every React component that uses state also imports from the store." These patterns require cross-file analysis. Claude cannot discover them by reading files one at a time, no matter how many it reads. Convention detection operates on the graph, where relational patterns are first-class queryable structures.

**Convention drift over time.** Codebases evolve. The pattern established 18 months ago may not match the pattern the team uses today. Files written last month follow a new convention; files written two years ago follow an old one. Claude has no way to weight recency — it treats old files and new files identically. Convention detection can weight by recency (via file modification timestamps or temporal graph commit data), giving Claude the *current* convention, not the historical average.

**The developer writes a style guide Claude never sees.** Many teams have conventions documented in READMEs, Notion pages, or team wikis. Claude Code does not read those. Even if the developer pastes the style guide into the prompt, it only applies to that session. Convention detection makes the conventions durable and automatic — they are re-derived on every digest and available to Claude Code permanently, with no manual prompting.

---

## 3. Goals & Non-Goals

### 3.1 Goals

1. Detect naming conventions across the codebase: file naming patterns, function naming patterns, class naming patterns, variable naming patterns, and export naming patterns — segmented by file type and directory.
2. Detect structural conventions: file organization (where do tests live, where do types live, where do utilities live), import ordering patterns, re-export patterns, and module boundary patterns.
3. Detect compositional conventions: error handling patterns (try/catch vs. Result types vs. error callbacks), component structure patterns (hooks usage, prop patterns, state management), and API route patterns (middleware, validation, response formatting).
4. Report convention confidence: what percentage of the codebase follows each detected convention, which files are outliers, and how the convention varies by directory or file age.
5. Expose conventions through MCP tools so Claude Code can query "what are the conventions for this directory" or "does this file follow conventions" before writing code.
6. Re-derive conventions on each digest so they stay current as the codebase evolves.
7. Enable Claude Code to proactively follow conventions during code generation without the developer needing to describe them.

### 3.2 Non-Goals

- Enforcing conventions. Convention detection *reports*; it does not block or auto-fix. Claude Code uses conventions as guidance, not as a linter.
- Linting or formatting rules. Tools like ESLint and Prettier handle syntactic formatting (semicolons, indentation, trailing commas). Convention detection operates at a higher level — structural and compositional patterns that linters do not cover.
- Detecting conventions from documentation or comments. The system analyzes code structure, not prose. If the team's convention is documented in a README but not followed in code, convention detection reports what the code does, not what the README says.
- Cross-repository convention analysis. Each repo's conventions are derived independently.
- Language-specific type system conventions (e.g., "use readonly everywhere"). This overlaps with the Type Flow feature and is deferred.

---

## 4. How Convention Detection Fits the Existing System

Convention detection is a read-only analysis layer that runs at the end of the digest pipeline. It consumes the structural graph and produces convention data stored in Supabase.

### 4.1 Position in the Pipeline

```
Clone → Scan → Parse → Resolve → Deps → Load → Analyze Conventions (new)
```

The Analyze stage runs after Load, when the full graph — files, symbols, imports, exports, and resolved edges — is available in Neo4j. It queries the graph in bulk, computes statistical patterns, and writes convention records to Supabase.

### 4.2 Relationship to Other Phases

**Phase 2 (Structural Graph):** Convention detection is impossible without the structural graph. It needs Function, Class, File, and Import nodes to detect patterns. The richer the graph (name resolution, call edges), the more conventions it can detect.

**Name Resolution:** Critical for import convention detection. Without resolved imports, the system cannot tell whether a codebase consistently imports from barrels vs. direct files, or whether aliased imports follow a consistent alias naming pattern. With name resolution, these patterns are visible.

**Phase 4 (Incremental Re-Digest):** Convention re-analysis should run incrementally too. If only 10 files changed, re-analyze the conventions for the affected directories rather than re-scanning the entire graph.

**Phase 5 (Runtime Context Layer):** No direct dependency. But when both are present, conventions can be enriched with runtime context: "the convention is to add error handling in API routes — and the routes that don't follow the convention have the highest error rates." This cross-layer insight is a fast-follow, not a v1 requirement.

**Phase 6 (Temporal Graph):** Convention drift detection becomes much more powerful with temporal data. The temporal graph can show *when* a convention shifted — "the team started using Zod validation in API routes starting from commit X in January; 60% of routes now use it, up from 0% six months ago." This is a compelling composite feature but depends on Phase 6 being operational.

**Runtime Heatmapping:** The heatmap can prioritize convention violations by blast radius. A convention violation in a `critical_path` function matters more than one in dead code. This is a natural extension but not required for v1.

---

## 5. Technical Specification

### 5.1 Convention Categories

Convention detection covers five categories, each with specific pattern extractors.

#### Category 1: Naming Conventions

Analyze names of files, functions, classes, types, and constants to detect dominant naming patterns.

| Pattern | What It Detects | Example Convention |
|---|---|---|
| File naming | Case convention per directory/file type | "Components use PascalCase (`Button.tsx`), utilities use camelCase (`formatDate.ts`), API routes use kebab-case (`create-order.ts`)" |
| Function naming | Prefix/suffix patterns by context | "Hook functions start with `use` (`useAuth`, `usePayment`), event handlers start with `handle` (`handleSubmit`, `handleClick`)" |
| Class naming | Case and suffix patterns | "Service classes end with `Service` (`PaymentService`, `AuthService`), all PascalCase" |
| Type naming | Prefix/suffix/case patterns | "Interface names start with `I` or end with `Props`/`State`; type aliases use PascalCase" |
| Test file naming | Co-location and suffix pattern | "Test files are co-located with source and use `.test.tsx` suffix (not `.spec.tsx`, not in a separate `__tests__` directory)" |

**Detection method:** For each directory (or directory pattern like `src/components/*`), collect all names of a given entity type, classify each name by case convention (PascalCase, camelCase, kebab-case, snake_case, SCREAMING_SNAKE), and extract common prefixes/suffixes. Report the dominant pattern and its adoption rate.

#### Category 2: File Organization Conventions

Analyze the directory structure and file placement patterns.

| Pattern | What It Detects | Example Convention |
|---|---|---|
| Directory structure | Where different kinds of files live | "Components in `src/components/`, API routes in `src/api/`, utilities in `src/lib/`, types in `src/types/`" |
| Co-location | What files are placed together | "Each component directory contains: `Component.tsx`, `Component.test.tsx`, `index.ts` (barrel), and optionally `Component.styles.ts`" |
| Module boundaries | What constitutes a module | "Each top-level directory under `src/` is a module boundary with its own barrel file" |
| Index/barrel pattern | How modules expose their public API | "Every directory with 2+ files has an `index.ts` that re-exports public symbols" |

**Detection method:** Build a directory tree from File nodes. For each directory, catalog the file types present and their naming relationships. Detect co-location by finding file groups that consistently appear together (component + test + barrel + styles). Detect module boundaries by identifying directories that act as import targets via barrel files.

#### Category 3: Import Conventions

Analyze import statements across the codebase to detect ordering, grouping, and sourcing patterns.

| Pattern | What It Detects | Example Convention |
|---|---|---|
| Import ordering | How imports are grouped and sequenced | "External packages first, then internal absolute imports (`@/...`), then relative imports, separated by blank lines" |
| Import source preference | Barrel vs. direct file imports | "Import from the nearest barrel (`@/components`) rather than direct files (`@/components/Button/Button`)" |
| Alias usage | Consistent use of path aliases | "Always use `@/` alias for internal imports, never relative paths crossing module boundaries" |
| Destructuring pattern | Named vs. default vs. namespace imports | "Prefer named imports; default imports only for React components" |

**Detection method:** For each File node, extract its IMPORTS edges with their properties (symbols, resolved_path, alias from name resolution). Classify each import as external/internal, aliased/relative, named/default/namespace. Detect ordering by analyzing the sequence of import types within files. Report the dominant ordering pattern and adoption rate.

#### Category 4: Code Structure Conventions

Analyze the internal structure of functions, classes, and files to detect compositional patterns.

| Pattern | What It Detects | Example Convention |
|---|---|---|
| Error handling | Try/catch patterns, error types, error propagation | "API route handlers wrap logic in try/catch, catch blocks call `handleApiError(error, res)`" |
| Function length | Typical function size boundaries | "Functions average 25 lines, p95 is 80 lines. Functions over 100 lines are outliers (12 total)." |
| Export pattern | Default vs. named exports per file type | "Components use default exports, utilities use named exports, types use named exports" |
| Return pattern | Consistent return type patterns | "API handlers always return `{ data, error, status }` objects" |

**Detection method:** Use tree-sitter AST data stored during the Parse stage. For functions, measure line count, extract the return pattern (what the function returns), detect try/catch blocks and their catch-clause patterns. For files, analyze export statements. Cluster common patterns and report the dominant one per directory or file type.

#### Category 5: Compositional Conventions (React/Framework-Specific)

Analyze framework-specific patterns for the dominant framework in the codebase.

| Pattern | What It Detects | Example Convention |
|---|---|---|
| Component structure | Hook ordering, prop patterns | "Components declare hooks at the top in order: useState, useEffect, custom hooks, then render logic" |
| State management | How components access state | "Components access global state via `useStore()` hook, not direct Redux connect" |
| API call pattern | How data fetching is structured | "API calls go through `src/lib/api.ts` client, never raw `fetch` in components" |
| Validation pattern | How input validation is handled | "Zod schemas defined in `src/schemas/`, referenced in route handlers via `validate(schema)`" |

**Detection method:** This category is more heuristic than the others. Detect the dominant framework from package.json dependencies. For React, analyze component files for hook usage patterns, prop type definitions, and state management imports. Cluster common patterns. This category has lower confidence scores than naming or file organization conventions because the patterns are more varied.

### 5.2 Convention Data Model

Each detected convention is stored as a record in Supabase:

```
Convention {
  id: uuid
  repo_id: uuid
  category: naming | file_organization | imports | code_structure | compositional
  pattern_key: string          // machine-readable identifier, e.g., "naming.file.components"
  description: string          // human-readable, e.g., "Component files use PascalCase"
  scope: string                // directory or file type this applies to, e.g., "src/components/**"
  confidence: float            // 0.0–1.0 — what percentage of files in scope follow this
  sample_size: int             // how many files/symbols were analyzed
  dominant_pattern: jsonb      // structured representation of the detected pattern
  outliers: jsonb              // list of files/symbols that don't follow the convention
  last_computed_at: datetime
  weight: float                // recency weight — conventions from newer files score higher
}
```

**`dominant_pattern` structure** varies by category but always includes:

```json
{
  "rule": "PascalCase filename with .tsx extension",
  "examples": ["Button.tsx", "PaymentForm.tsx", "UserProfile.tsx"],
  "counter_examples": ["formatDate.ts", "api-client.ts"],
  "adoption_rate": 0.94,
  "total_matches": 47,
  "total_analyzed": 50
}
```

### 5.3 Convention Analysis Engine

The analysis engine runs at the end of each digest. It is structured as a series of independent analyzers, one per convention category. Each analyzer:

1. Queries Neo4j for the relevant graph data (all Function nodes, all File nodes in a directory, all IMPORTS edges, etc.).
2. Applies pattern extraction logic to the dataset.
3. Computes the dominant pattern, confidence score, and outliers.
4. Writes or updates convention records in Supabase.

**Analyzer interface:**

```typescript
interface ConventionAnalyzer {
  category: ConventionCategory;
  analyze(graphClient: Neo4jClient, repo: Repository): Promise<Convention[]>;
}
```

Each analyzer returns zero or more conventions. A single analyzer may produce multiple conventions — for example, the naming analyzer produces separate conventions for component files, utility files, test files, etc.

**Scoping:** Conventions are scoped to directories or file-type patterns. The naming convention for `src/components/` may differ from `src/api/`. The analyzer detects these scope boundaries by analyzing whether patterns are consistent across the entire repo or vary by directory. If a pattern holds globally, it is scoped to `**`. If it only holds within a specific subtree, it is scoped to that subtree.

**Confidence thresholds:** A convention is only stored if its confidence (adoption rate) exceeds a configurable minimum (default: 60%). Below that threshold, there is no dominant pattern — the codebase is genuinely mixed. This prevents noisy low-confidence conventions from misleading Claude.

### 5.4 Recency Weighting

Not all files are equally informative about *current* conventions. A file written last week is a better signal than one written two years ago. The analysis engine applies recency weighting using file modification timestamps (from `git log` if available via Phase 6, or file system timestamps otherwise).

**Weight function:** Exponential decay with a configurable half-life (default: 180 days).

```
weight(file) = exp(-0.693 × age_in_days / half_life_days)
```

A file modified today has weight 1.0. A file modified 180 days ago has weight 0.5. A file modified a year ago has weight 0.25. When computing the dominant pattern, each file's vote is multiplied by its weight. This means recent files have more influence on what counts as "the convention" — which reflects how teams actually evolve their practices.

Recency weighting is optional and off by default if Phase 6 (temporal graph) is not active, since file system timestamps are less reliable than git commit timestamps.

### 5.5 Outlier Identification

For every detected convention, the engine identifies outliers — files or symbols that do not follow the dominant pattern. Outliers are stored as a list on the convention record, including:

- File path
- What the file does instead of following the convention
- When the file was last modified (to help Claude assess whether this is a legacy exception or an intentional divergence)

Outliers serve two purposes:

1. **For Claude Code during code generation:** Claude can check whether a pattern it's about to follow is actually the convention or an outlier it happened to see.
2. **For refactoring suggestions:** Claude can proactively suggest "these 6 files don't follow the convention established by the other 47 files in this directory — would you like me to align them?"

### 5.6 Supabase Schema Additions

| Table | Columns | Purpose |
|---|---|---|
| conventions | id, repo_id, category, pattern_key, description, scope, confidence, sample_size, dominant_pattern (jsonb), outliers (jsonb), last_computed_at, weight | Detected conventions per repo |
| convention_analysis_jobs | id, repo_id, digest_job_id, status, started_at, completed_at, conventions_detected, stats (jsonb) | Track convention analysis runs |

**Indexes:**

- `conventions`: composite on `(repo_id, category, scope)` for filtering by category within a scope.
- `conventions`: composite on `(repo_id, pattern_key)` for direct lookup.

### 5.7 Incremental Convention Analysis

When incremental re-digest (Phase 4) runs and only some files change, full re-analysis of every convention is wasteful. The convention engine supports incremental mode:

1. Receive the set of changed files from the digest pipeline.
2. Determine which convention scopes are affected (which directories contain changed files).
3. Re-run only the analyzers whose scopes overlap with the affected directories.
4. For global-scope conventions (e.g., repo-wide naming patterns), re-run only if the changed files would move the adoption rate past a significance threshold (±2%).

This keeps convention analysis proportional to the size of the change rather than the size of the repo.

---

## 6. MCP Server Specification

### 6.1 New Convention Tools

| Tool Name | Description | Key Parameters |
|---|---|---|
| get_conventions | Return all detected conventions for a scope (directory, file type, or entire repo). The primary tool Claude calls before writing new code. | repo (string), scope? (string — directory path or file pattern), category? (naming\|file_organization\|imports\|code_structure\|compositional) |
| check_conventions | Given a file path or code snippet, check whether it follows the conventions for its scope. Returns violations with the convention it breaks, what the convention expects, and the convention's confidence score. | repo (string), path (string), content? (string — file content to check without saving) |
| get_outliers | Return files that deviate from a specific convention. Useful for refactoring suggestions. | repo (string), pattern_key (string), limit? (int, default 20) |
| get_convention_summary | Return a high-level summary of the repo's conventions — suitable for inclusion in a Claude Code system prompt or for a developer who wants a quick overview. | repo (string), format? (brief\|detailed) |

### 6.2 Enrichments to Existing Tools

| Tool | Enrichment |
|---|---|
| get_repo_structure | Response includes a note about detected file organization conventions — "this repo co-locates tests with source files" or "tests are in a separate `__tests__` directory." |
| get_file | Response includes convention compliance status for the file — "this file follows 5/5 detected conventions for its scope" or "this file violates the naming convention: expected PascalCase, found kebab-case." |
| search_code | Results can be filtered by convention compliance: "show me files in `src/api/` that don't follow the error handling convention." |

### 6.3 Active Development Workflows

**"Create a new component" — convention-aware code generation:**

1. Developer: "Create a new UserProfile component."
2. Claude calls `get_conventions(scope="src/components/", category="naming")` → learns components use PascalCase filenames.
3. Claude calls `get_conventions(scope="src/components/", category="file_organization")` → learns each component gets a directory with `Component.tsx`, `Component.test.tsx`, and `index.ts`.
4. Claude calls `get_conventions(scope="src/components/", category="imports")` → learns components import from `@/lib/hooks` for custom hooks and `@/store` for state.
5. Claude calls `get_conventions(scope="src/components/", category="code_structure")` → learns components use named exports and hooks are declared at the top.
6. Claude creates `src/components/UserProfile/UserProfile.tsx`, `UserProfile.test.tsx`, and `index.ts` — all matching conventions without the developer specifying any of this.

**"Add a new API route" — pattern replication:**

1. Developer: "Add a POST route for creating invoices."
2. Claude calls `get_conventions(scope="src/api/", category="code_structure")` → learns routes use Zod validation, wrap in try/catch, call `handleApiError`, and return `{ data, error }`.
3. Claude calls `get_conventions(scope="src/api/", category="imports")` → learns routes import from `@/lib/validation`, `@/lib/errors`, and the relevant service file.
4. Claude writes the route following every detected convention. The developer does not need to say "use Zod" or "follow our error handling pattern" — the graph already knows.

**"Is this code consistent?" — convention compliance check:**

1. Developer writes or modifies a file.
2. Claude calls `check_conventions(path="src/api/invoices/create.ts", content=<new content>)` → gets a compliance report.
3. Claude reports: "This file follows the error handling and validation conventions. One deviation: it uses a default export, but the convention for API routes is named exports (87% adoption)."

**"Clean up this module" — outlier-driven refactoring:**

1. Developer: "Are there any inconsistencies in the payments module?"
2. Claude calls `get_conventions(scope="src/payments/")` → gets all conventions for the module.
3. Claude calls `get_outliers(pattern_key="naming.file.api_routes")` → finds 3 files using kebab-case in a PascalCase directory.
4. Claude calls `get_outliers(pattern_key="code_structure.error_handling.api")` → finds 2 routes that don't follow the standard error handling pattern.
5. Claude reports the outliers with context and offers to fix them.

**"I'm new to this codebase" — onboarding summary:**

1. New developer: "How is this codebase organized?"
2. Claude calls `get_convention_summary(format="detailed")` → gets a comprehensive overview.
3. Claude presents: naming conventions, file organization, import patterns, error handling patterns, component structure — all derived from the actual code, not from a potentially-stale wiki page.

---

## 7. Implementation Plan

Convention detection is implemented as a Phase 2 extension. It requires the structural graph and benefits significantly from name resolution. It does not depend on Phase 5 (runtime) or Phase 6 (temporal) but gains value from both when they are present.

### 7.1 Subtasks

**1. Analyzer framework** (~2 hours with Claude Code)

Build the `ConventionAnalyzer` interface, the runner that executes all analyzers after a digest, and the Supabase write logic. This is the scaffolding that all analyzers plug into.

**2. Naming convention analyzer** (~3 hours with Claude Code)

Detect file naming, function naming, class naming, and type naming patterns. Implement case classification (PascalCase, camelCase, etc.), prefix/suffix extraction, and scope detection (per-directory vs. global). This is the most straightforward analyzer and a good validation of the framework.

**3. File organization analyzer** (~3 hours with Claude Code)

Detect co-location patterns, directory structure conventions, barrel file patterns, and module boundaries. Requires querying File nodes grouped by directory, analyzing which file types consistently appear together, and detecting barrel files via the name resolution barrel classification.

**4. Import convention analyzer** (~3 hours with Claude Code)

Detect import ordering, source preference (barrel vs. direct), alias usage patterns, and destructuring style. Requires reading IMPORTS edges with name resolution properties. This analyzer benefits most from name resolution being active.

**5. Code structure analyzer** (~4 hours with Claude Code)

Detect error handling patterns, export patterns, function length distributions, and return patterns. Requires deeper AST analysis — this may need additional tree-sitter queries beyond what the Parse stage already extracts, or may work from the stored Function node properties (signature, start_line, end_line) combined with file content analysis.

**6. Compositional convention analyzer** (~4 hours with Claude Code)

Detect React/framework-specific patterns: hook ordering, state management, API call patterns, validation patterns. This is the most heuristic analyzer and has the lowest expected confidence scores. Framework detection from `package.json` dependencies gates which sub-analyzers run.

**7. Recency weighting module** (~1 hour with Claude Code)

Implement the exponential decay weighting using git timestamps (from Phase 6 commit data) or file modification timestamps. Apply weights during convention computation.

**8. New MCP tools** (~3 hours with Claude Code)

Implement `get_conventions`, `check_conventions`, `get_outliers`, and `get_convention_summary`. Each queries Supabase for convention records, optionally filtered by scope and category.

**9. Existing tool enrichment** (~2 hours with Claude Code)

Add convention annotations to `get_repo_structure`, `get_file`, and `search_code`.

**10. Incremental analysis mode** (~2 hours with Claude Code)

Implement scope-based incremental re-analysis when only a subset of files change.

**11. Validation against real repos** (~6–8 hours, developer-led)

Run convention detection on the target codebase. Review detected conventions with the development team. Are the top conventions accurate? Are the confidence scores reasonable? Are the outliers actually outliers? Tune thresholds and pattern extractors based on feedback.

### 7.2 Total Estimated Effort

| Subtask | Implementation | Validation |
|---|---|---|
| Analyzer framework | 2 hours | 30 minutes |
| Naming analyzer | 3 hours | 1 hour |
| File organization analyzer | 3 hours | 1 hour |
| Import convention analyzer | 3 hours | 1 hour |
| Code structure analyzer | 4 hours | 1.5 hours |
| Compositional analyzer | 4 hours | 2 hours |
| Recency weighting | 1 hour | 30 minutes |
| New MCP tools | 3 hours | 1 hour |
| Existing tool enrichment | 2 hours | 30 minutes |
| Incremental analysis | 2 hours | 30 minutes |
| **Total** | **~27 hours** | **~9.5 hours** |

Approximately **5–6 focused days** end-to-end. The code structure and compositional analyzers carry the most risk due to their heuristic nature. The naming and file organization analyzers are high-confidence and fast to validate.

---

## 8. Testing Strategy

### 8.1 Unit Tests

- **Case classifier:** Verify PascalCase, camelCase, kebab-case, snake_case, and SCREAMING_SNAKE detection on a corpus of names including edge cases (acronyms like `APIClient`, single-letter names, numeric suffixes).
- **Prefix/suffix extractor:** Feed a list of names with known prefixes (`useAuth`, `usePayment`, `useStore`) and verify extraction of `use` prefix with correct adoption rate.
- **Co-location detector:** Feed a directory tree with known co-location patterns and verify detection. Include a directory with inconsistent co-location to verify outlier identification.
- **Import ordering detector:** Feed a set of files with known import ordering and verify the detected pattern matches. Include files with intentionally different ordering to verify outlier detection.
- **Recency weighting:** Feed files with known ages and verify that the weight function produces the expected exponential decay values.

### 8.2 Integration Test Repos

**Fixture G — clean conventions.** A small repo (50 files) where every file rigorously follows a single set of conventions. All analyzers should detect conventions with 95%+ confidence. Zero outliers. This validates the happy path.

**Fixture H — mixed conventions.** A repo with two distinct convention sets — one in `src/legacy/` (old patterns) and one in `src/v2/` (new patterns). Validates that convention detection scopes conventions per directory and does not average across the entire repo.

**Fixture I — real-world messiness.** A repo with organic variation: mostly consistent conventions but 10–15% outliers, some undecidable patterns, and a few files that follow no convention at all. Validates that the confidence scores are honest and that the 60% threshold correctly filters out noise.

### 8.3 Acceptance Criteria

- Detected naming conventions for Fixture G match the known conventions with 95%+ confidence.
- Fixture H produces separate convention records for `src/legacy/` and `src/v2/`, not a single blended convention.
- The top 5 conventions detected on the target codebase are confirmed as accurate by the development team.
- `check_conventions` correctly identifies known outliers in the target codebase without false positives on files that follow conventions.
- `get_conventions` response time is under 300ms for a single scope.
- Convention analysis adds less than 30 seconds to a full digest on a 5,000-file repo.
- Convention analysis in incremental mode completes in under 5 seconds when fewer than 50 files changed.

---

## 9. Performance Considerations

Convention analysis is a batch computation that runs at the end of a digest. The dominant cost is querying Neo4j for bulk graph data (all Function nodes, all File nodes in a directory, all IMPORTS edges).

- **Batch Neo4j queries.** Fetch all nodes of a given type in a single Cypher query rather than per-file lookups. For a 5,000-file repo, this means ~5 bulk queries (files, functions, classes, types, imports), not 5,000 individual queries.
- **Cache graph data across analyzers.** Multiple analyzers need the same File nodes. Fetch once, share across analyzers.
- **Parallelize analyzers.** The five convention categories are independent. Run them concurrently.
- **Skip unchanged scopes in incremental mode.** If no files changed in `src/components/`, do not re-analyze component conventions.
- **Pre-compute convention data during digest.** Some convention inputs (file case classification, import ordering) can be computed during the Parse or Load stage and stored as node properties, reducing the analysis-time query cost.

**Performance targets:**

| Metric | Target | Notes |
|---|---|---|
| Full convention analysis (5K files) | < 30 seconds | After the digest Load stage completes |
| Incremental analysis (50 changed files) | < 5 seconds | Only re-analyze affected scopes |
| `get_conventions` response | < 300ms | Supabase indexed query |
| `check_conventions` response | < 500ms | Convention lookup + pattern matching on file content |
| `get_convention_summary` response | < 400ms | Aggregate query across all convention records |
| Storage (conventions + outliers for 5K file repo) | < 50MB | Convention records are compact; outlier lists are the largest component |

---

## 10. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Pattern extractors produce conventions that are technically correct but not meaningful | High | Require minimum sample size (default: 10 files in scope) before reporting a convention. Include the confidence score and sample size in every tool response so Claude can weight accordingly. Developer review during validation phase to tune what is reported. |
| Conventions conflict across scopes (directory-level convention contradicts repo-level) | Medium | Report the most specific scope that applies. If a file is in `src/api/payments/`, report conventions for that directory first, then `src/api/`, then repo-wide. Claude uses the most specific match. |
| Code structure and compositional analyzers are too heuristic to be reliable | Medium | Ship naming and file organization analyzers first (high confidence). Ship code structure and compositional analyzers as opt-in beta with a clear confidence disclaimer. Iterate based on real-world accuracy. |
| Convention analysis is slow on large monorepos | Medium | Scope analysis by package or workspace in monorepos. Analyze each package independently. Limit the number of files queried per analyzer with configurable caps. |
| Recency weighting biases toward new patterns that are actually regressions, not improvements | Low | Off by default. When enabled, include both weighted and unweighted adoption rates in the convention record so Claude can see both perspectives. |
| Conventions change faster than digests run | Low | Convention analysis is a snapshot, not a live view. As long as digests run regularly (daily or on CI), conventions stay reasonably current. The `last_computed_at` timestamp lets Claude know how fresh the data is. |

---

## 11. Success Criteria

Convention detection is complete when:

1. Claude Code creates new files that match the codebase's naming and structural conventions without the developer specifying any conventions in the prompt — verified by developer review of 10+ generated files.
2. `get_conventions` returns conventions that the development team confirms are accurate for at least the top 5 detected patterns.
3. `check_conventions` correctly identifies convention violations in known outlier files without flagging compliant files.
4. Claude Code proactively follows import ordering, error handling, and export patterns that are consistent with the rest of the codebase — verified by comparing Claude-generated code against the detected conventions.
5. A new team member can call `get_convention_summary` and get an accurate overview of how the codebase is organized — confirmed by comparison against the team's internal documentation or tribal knowledge.
6. Convention analysis runs within the performance targets and does not meaningfully increase digest time.

---

## 12. Decision Map

### 12.1 During Analysis

**What is the minimum sample size for a convention?**
Default: 10 files or symbols in scope. Below that, the sample is too small to be meaningful — a directory with 3 files that all use PascalCase could be coincidence, not convention. At 10+, the pattern is statistically meaningful. Make this configurable per-repo.

**What is the minimum confidence threshold?**
Default: 60%. Below that, there is no dominant pattern — the codebase is genuinely mixed. Storing a convention at 55% confidence would mean Claude follows a pattern that 45% of the codebase does not, which is barely better than a coin flip. 60% is the floor; most real conventions land at 80%+.

**How do you scope conventions — per directory, per file type, or global?**
Start by computing conventions at the directory level. If a pattern holds consistently across all directories (within 10% variance), promote it to global scope. If a pattern varies significantly between directories, keep it directory-scoped. This automatic scope detection avoids both over-generalizing (forcing one pattern on a repo that genuinely uses different patterns in different areas) and under-generalizing (reporting the same convention 50 times for 50 directories).

**How do you handle framework detection?**
Read `package.json` dependencies. If `react` is present, enable the React compositional analyzers. If `vue` is present, skip React-specific analysis. If neither is present, skip the compositional category entirely. This is coarse but effective for v1 — do not attempt to detect frameworks from import patterns alone.

### 12.2 For MCP Tool Responses

**Should `get_conventions` return all conventions for a scope, or just the most confident ones?**
Return all conventions above the confidence threshold, sorted by confidence descending. Claude Code typically calls this before writing code and needs the full picture. For the `brief` format of `get_convention_summary`, return only the top convention per category.

**Should `check_conventions` block code generation?**
No. It reports violations but does not prevent action. Convention detection is advisory. Claude Code uses the information to self-correct before presenting code to the developer, but it is not a gate.

**Should Claude call `get_conventions` automatically before every code generation?**
Yes — this is the recommended integration pattern. When Claude is about to create a file or write a function, it should query conventions for the target scope. This adds one MCP tool call per generation, but the result is that every piece of generated code fits the codebase. The latency cost (< 300ms) is negligible relative to the value of convention-aware code.

### 12.3 Decisions Requiring Product Judgment

**Which analyzers to ship in v1.** The naming and file organization analyzers are high-confidence and low-risk. The import convention analyzer is medium-confidence but high-value (import ordering is one of the most common points of friction). The code structure analyzer is medium-risk (heuristic pattern matching on error handling is imperfect). The compositional analyzer is highest-risk (React-specific patterns are varied and hard to generalize). Recommended: ship naming, file organization, and imports in v1. Ship code structure as opt-in. Defer compositional to v1.1 after validating the first three.

**Recency weighting on or off by default.** Off is safer — it means all files vote equally regardless of age, which produces the most stable conventions. On is more useful for repos with evolving practices, but risks biasing toward patterns that only a few recent files use. Recommended: off by default, with a UI toggle. Turn it on if the developer reports that conventions feel "stale" or don't match how the team currently writes code.

**Convention override mechanism.** Should the developer be able to manually define or pin a convention, overriding whatever the analyzer detects? This is useful when the team has a convention they are actively adopting but it has not yet reached 60% adoption in the codebase. A manual override would let Claude follow the *intended* convention rather than the statistical one. Recommended: support overrides in v1.1 via a `conventions.json` file in the repo root. Not required for v1 — let the analyzer results speak for themselves first, and add overrides only if developers request them.

**How to present conventions to Claude Code's system prompt.** The highest-leverage integration is to have Claude Code automatically include relevant conventions in its system prompt when working in a specific directory. This would mean Claude is *always* convention-aware without needing to call a tool. But this requires tight integration with Claude Code's prompt construction, which may not be feasible via MCP alone. For v1, the MCP tool approach is correct — Claude calls `get_conventions` when needed. The system prompt integration is a fast-follow if Anthropic exposes prompt-enrichment hooks in the MCP protocol.
