import Parser from "tree-sitter";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// tree-sitter language bindings are CommonJS native modules —
// use createRequire for reliable interop in ESM context.
const TypeScriptLang = require("tree-sitter-typescript");
const PythonLang = require("tree-sitter-python");
const GoLang = require("tree-sitter-go");

const TSParser = TypeScriptLang.typescript;
const TSXParser = TypeScriptLang.tsx;

export interface ParsedSymbol {
  kind: "function" | "class" | "type" | "constant";
  name: string;
  signature: string;
  docstring: string;
  startLine: number;
  endLine: number;
  filePath: string;
  // SCIP type enrichment (populated by scip stage, undefined otherwise)
  resolvedSignature?: string;
  paramTypes?: string[];
  returnType?: string;
  typeErrors?: Array<{ severity: "error" | "warning" | "info"; code: string; message: string; line: number }>;
  isGeneric?: boolean;
  typeParams?: string[];
}

export interface ParsedImport {
  source: string; // the import path/module
  symbols: string[]; // named imports
  defaultImport: string | null;
  filePath: string;
}

export interface ParsedExport {
  symbolName: string;
  isDefault: boolean;
  filePath: string;
}

export interface ReExportInfo {
  symbols: string[];       // re-exported symbol names (empty for wildcard)
  source: string;          // re-export source path as written
  isWildcard: boolean;     // export * from '...'
}

export interface BarrelInfo {
  filePath: string;
  kind: "strict" | "hybrid"; // strict = all re-exports, hybrid = mixed local + re-exports
  reExports: ReExportInfo[];
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  exports: ParsedExport[];
  barrel: BarrelInfo | null;  // non-null if file has any re-exports
}

type SupportedLanguage = "typescript" | "javascript" | "python" | "go";

const parsers = new Map<string, Parser>();

function getParser(language: SupportedLanguage): Parser {
  if (parsers.has(language)) return parsers.get(language)!;

  const parser = new Parser();
  switch (language) {
    case "typescript":
      parser.setLanguage(TSParser);
      break;
    case "javascript":
      parser.setLanguage(TSXParser); // TSX handles both JS and JSX
      break;
    case "python":
      parser.setLanguage(PythonLang);
      break;
    case "go":
      parser.setLanguage(GoLang);
      break;
  }
  parsers.set(language, parser);
  return parser;
}

export function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  return ["typescript", "javascript", "python", "go"].includes(lang);
}

export function parseFile(
  filePath: string,
  content: string,
  language: string
): ParseResult {
  if (!isSupportedLanguage(language)) {
    return { symbols: [], imports: [], exports: [], barrel: null };
  }

  const parser = getParser(language);
  const tree = parser.parse(content);
  const lines = content.split("\n");

  switch (language) {
    case "typescript":
    case "javascript":
      return parseTypeScript(tree, filePath, lines);
    case "python":
      return parsePython(tree, filePath, lines);
    case "go":
      return parseGo(tree, filePath, lines);
  }
}

// --- TypeScript / JavaScript ---

function parseTypeScript(
  tree: Parser.Tree,
  filePath: string,
  lines: string[]
): ParseResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const exports: ParsedExport[] = [];
  const reExports: ReExportInfo[] = [];
  let localExportCount = 0;

  function getDocstring(node: Parser.SyntaxNode): string {
    const prev = node.previousNamedSibling;
    if (prev?.type === "comment") {
      return prev.text.replace(/^\/\*\*?\s*|\s*\*\/$/g, "").trim();
    }
    return "";
  }

  function getSignature(node: Parser.SyntaxNode, lines: string[]): string {
    // Get first line of the declaration as signature
    const startLine = node.startPosition.row;
    const line = lines[startLine] || "";
    return line.trim().replace(/\{[\s\S]*$/, "").trim();
  }

  function walk(node: Parser.SyntaxNode, isExported: boolean = false, isTopLevel: boolean = true) {
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const name = node.childForFieldName("name")?.text || "";
        if (name) {
          symbols.push({
            kind: "function",
            name,
            signature: getSignature(node, lines),
            docstring: getDocstring(node),
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            filePath,
          });
          if (isExported) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
        }
        break;
      }

      case "class_declaration": {
        const name = node.childForFieldName("name")?.text || "";
        if (name) {
          symbols.push({
            kind: "class",
            name,
            signature: getSignature(node, lines),
            docstring: getDocstring(node),
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            filePath,
          });
          if (isExported) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
          // Parse methods inside the class
          const body = node.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              if (child.type === "method_definition" || child.type === "public_field_definition") {
                const methodName = child.childForFieldName("name")?.text || "";
                if (methodName) {
                  symbols.push({
                    kind: "function",
                    name: `${name}.${methodName}`,
                    signature: getSignature(child, lines),
                    docstring: getDocstring(child),
                    startLine: child.startPosition.row + 1,
                    endLine: child.endPosition.row + 1,
                    filePath,
                  });
                }
              }
            }
          }
        }
        break;
      }

      case "interface_declaration":
      case "type_alias_declaration": {
        const name = node.childForFieldName("name")?.text || "";
        if (name) {
          symbols.push({
            kind: "type",
            name,
            signature: getSignature(node, lines),
            docstring: getDocstring(node),
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            filePath,
          });
          if (isExported) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
        }
        break;
      }

      case "lexical_declaration": {
        // Only extract constants at module scope (top-level or exported).
        // Local variables inside functions/callbacks are noise.
        if (!isTopLevel && !isExported) break;
        for (const decl of node.namedChildren) {
          if (decl.type === "variable_declarator") {
            const name = decl.childForFieldName("name")?.text || "";
            if (name) {
              symbols.push({
                kind: "constant",
                name,
                signature: getSignature(node, lines),
                docstring: getDocstring(node),
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                filePath,
              });
              if (isExported) {
                exports.push({ symbolName: name, isDefault: false, filePath });
              }
            }
          }
        }
        break;
      }

      case "import_statement": {
        const sourceNode = node.childForFieldName("source");
        const source = sourceNode?.text?.replace(/['"]/g, "") || "";
        if (!source) break;

        const importSymbols: string[] = [];
        let defaultImport: string | null = null;

        for (const child of node.namedChildren) {
          if (child.type === "identifier") {
            defaultImport = child.text;
          }
          if (child.type === "import_clause") {
            for (const c of child.namedChildren) {
              if (c.type === "identifier") {
                defaultImport = c.text;
              }
              if (c.type === "named_imports") {
                for (const spec of c.namedChildren) {
                  if (spec.type === "import_specifier") {
                    const name = spec.childForFieldName("name")?.text || spec.text;
                    importSymbols.push(name);
                  }
                }
              }
              if (c.type === "namespace_import") {
                const name = c.childForFieldName("name")?.text || "";
                if (name) importSymbols.push(`* as ${name}`);
              }
            }
          }
        }

        imports.push({ source, symbols: importSymbols, defaultImport, filePath });
        break;
      }

      case "export_statement": {
        const defaultKeyword = node.children.some(
          (c) => c.type === "default"
        );
        // Check for re-exports: export { ... } from '...' or export * from '...'
        const sourceNode = node.childForFieldName("source");
        const source = sourceNode?.text?.replace(/['"]/g, "") || "";

        if (source) {
          // Re-export — treat as both import and export
          const reExportSymbols: string[] = [];
          const isWildcard = node.children.some((c) => c.type === "*");
          const exportClause = node.descendantsOfType("export_clause")[0];
          if (exportClause) {
            for (const spec of exportClause.namedChildren) {
              const name = spec.childForFieldName("name")?.text || spec.text;
              reExportSymbols.push(name);
            }
          }
          imports.push({
            source,
            symbols: reExportSymbols,
            defaultImport: null,
            filePath,
          });
          reExports.push({
            symbols: reExportSymbols,
            source,
            isWildcard,
          });
          break;
        }

        // Walk declaration inside export — these are local exports
        for (const child of node.namedChildren) {
          if (
            child.type === "function_declaration" ||
            child.type === "class_declaration" ||
            child.type === "interface_declaration" ||
            child.type === "type_alias_declaration" ||
            child.type === "lexical_declaration" ||
            child.type === "enum_declaration"
          ) {
            walk(child, true);
            localExportCount++;
          }
          // Handle: export { X, Y } (no source — local named re-exports)
          if (child.type === "export_clause") {
            for (const spec of child.namedChildren) {
              if (spec.type === "export_specifier") {
                const name = spec.childForFieldName("name")?.text || spec.text;
                exports.push({ symbolName: name, isDefault: false, filePath });
                localExportCount++;
              }
            }
          }
          if (child.type === "identifier" && defaultKeyword) {
            exports.push({
              symbolName: child.text,
              isDefault: true,
              filePath,
            });
            localExportCount++;
          }
        }
        break;
      }

      case "export_default_declaration": {
        for (const child of node.namedChildren) {
          if (child.type === "function_declaration" || child.type === "class_declaration") {
            walk(child, true);
            localExportCount++;
            const name = child.childForFieldName("name")?.text;
            if (name) {
              // Mark as default export
              const existing = exports.find((e) => e.symbolName === name);
              if (existing) existing.isDefault = true;
            }
          }
        }
        break;
      }

      default:
        // Recurse into children — mark as non-top-level once we enter
        // expression statements, arrow functions, call expressions, etc.
        for (const child of node.namedChildren) {
          walk(child, false, false);
        }
    }
  }

  // Walk top-level nodes
  for (const child of tree.rootNode.namedChildren) {
    walk(child);
  }

  // Classify barrel status
  let barrel: BarrelInfo | null = null;
  if (reExports.length > 0) {
    barrel = {
      filePath,
      kind: localExportCount === 0 ? "strict" : "hybrid",
      reExports,
    };
  }

  return { symbols, imports, exports, barrel };
}

// --- Python ---

function parsePython(
  tree: Parser.Tree,
  filePath: string,
  lines: string[]
): ParseResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const exports: ParsedExport[] = [];

  function getDocstring(node: Parser.SyntaxNode): string {
    const body = node.childForFieldName("body");
    if (!body) return "";
    const firstChild = body.namedChildren[0];
    if (firstChild?.type === "expression_statement") {
      const str = firstChild.namedChildren[0];
      if (str?.type === "string") {
        return str.text.replace(/^"""|'''|"""|'''$/g, "").trim();
      }
    }
    return "";
  }

  function walk(node: Parser.SyntaxNode, className?: string) {
    switch (node.type) {
      case "function_definition": {
        const rawName = node.childForFieldName("name")?.text || "";
        const name = className ? `${className}.${rawName}` : rawName;
        const params = node.childForFieldName("parameters")?.text || "";
        const returnType = node.childForFieldName("return_type")?.text || "";

        symbols.push({
          kind: "function",
          name,
          signature: `def ${rawName}${params}${returnType ? " -> " + returnType : ""}`,
          docstring: getDocstring(node),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          filePath,
        });

        // Don't export private functions
        if (!rawName.startsWith("_")) {
          exports.push({ symbolName: rawName, isDefault: false, filePath });
        }
        break;
      }

      case "class_definition": {
        const name = node.childForFieldName("name")?.text || "";
        const superclass = node.childForFieldName("superclasses")?.text || "";

        symbols.push({
          kind: "class",
          name,
          signature: `class ${name}${superclass ? `(${superclass})` : ""}`,
          docstring: getDocstring(node),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          filePath,
        });

        exports.push({ symbolName: name, isDefault: false, filePath });

        // Parse methods
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            if (child.type === "function_definition" || child.type === "decorated_definition") {
              walk(child, name);
            }
          }
        }
        break;
      }

      case "decorated_definition": {
        // Walk the actual definition inside the decorator
        for (const child of node.namedChildren) {
          if (child.type === "function_definition" || child.type === "class_definition") {
            walk(child, className);
          }
        }
        break;
      }

      case "import_statement": {
        // import foo, import foo.bar
        for (const child of node.namedChildren) {
          if (child.type === "dotted_name") {
            imports.push({
              source: child.text,
              symbols: [],
              defaultImport: child.text,
              filePath,
            });
          }
          if (child.type === "aliased_import") {
            const name = child.childForFieldName("name")?.text || "";
            imports.push({
              source: name,
              symbols: [],
              defaultImport: name,
              filePath,
            });
          }
        }
        break;
      }

      case "import_from_statement": {
        // from foo import bar, baz
        const module = node.childForFieldName("module_name")?.text || "";
        const importedSymbols: string[] = [];
        for (const child of node.namedChildren) {
          if (child.type === "dotted_name" && child !== node.childForFieldName("module_name")) {
            importedSymbols.push(child.text);
          }
          if (child.type === "aliased_import") {
            const name = child.childForFieldName("name")?.text || "";
            importedSymbols.push(name);
          }
        }
        imports.push({
          source: module,
          symbols: importedSymbols,
          defaultImport: null,
          filePath,
        });
        break;
      }

      case "expression_statement": {
        // Top-level assignments (constants)
        const expr = node.namedChildren[0];
        if (expr?.type === "assignment") {
          const left = expr.childForFieldName("left")?.text || "";
          // Treat UPPER_CASE assignments as constants
          if (left && /^[A-Z_][A-Z0-9_]*$/.test(left)) {
            symbols.push({
              kind: "constant",
              name: left,
              signature: lines[node.startPosition.row]?.trim() || "",
              docstring: "",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              filePath,
            });
            exports.push({ symbolName: left, isDefault: false, filePath });
          }
        }
        break;
      }

      default:
        if (!className) {
          for (const child of node.namedChildren) {
            walk(child);
          }
        }
    }
  }

  for (const child of tree.rootNode.namedChildren) {
    walk(child);
  }

  return { symbols, imports, exports, barrel: null };
}

// --- Go ---

function parseGo(
  tree: Parser.Tree,
  filePath: string,
  lines: string[]
): ParseResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const exports: ParsedExport[] = [];

  function walk(node: Parser.SyntaxNode) {
    switch (node.type) {
      case "function_declaration": {
        const name = node.childForFieldName("name")?.text || "";
        const params = node.childForFieldName("parameters")?.text || "";
        const result = node.childForFieldName("result")?.text || "";

        symbols.push({
          kind: "function",
          name,
          signature: `func ${name}${params}${result ? " " + result : ""}`,
          docstring: "",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          filePath,
        });

        // Go exports = capitalized names
        if (name[0] && name[0] === name[0].toUpperCase()) {
          exports.push({ symbolName: name, isDefault: false, filePath });
        }
        break;
      }

      case "method_declaration": {
        const name = node.childForFieldName("name")?.text || "";
        const receiver = node.childForFieldName("receiver")?.text || "";
        const params = node.childForFieldName("parameters")?.text || "";

        symbols.push({
          kind: "function",
          name,
          signature: `func ${receiver} ${name}${params}`,
          docstring: "",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          filePath,
        });
        break;
      }

      case "type_declaration": {
        for (const spec of node.namedChildren) {
          if (spec.type === "type_spec") {
            const name = spec.childForFieldName("name")?.text || "";
            const typeNode = spec.childForFieldName("type");
            const isStruct = typeNode?.type === "struct_type";
            const isInterface = typeNode?.type === "interface_type";

            symbols.push({
              kind: isStruct || isInterface ? "class" : "type",
              name,
              signature: lines[node.startPosition.row]?.trim() || "",
              docstring: "",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              filePath,
            });

            if (name[0] && name[0] === name[0].toUpperCase()) {
              exports.push({ symbolName: name, isDefault: false, filePath });
            }
          }
        }
        break;
      }

      case "import_declaration": {
        for (const spec of node.descendantsOfType("import_spec")) {
          const path =
            spec.descendantsOfType("interpreted_string_literal")[0]?.text?.replace(/"/g, "") || "";
          if (path) {
            imports.push({
              source: path,
              symbols: [],
              defaultImport: null,
              filePath,
            });
          }
        }
        break;
      }

      case "const_declaration":
      case "var_declaration": {
        for (const spec of node.namedChildren) {
          if (spec.type === "const_spec" || spec.type === "var_spec") {
            const name = spec.childForFieldName("name")?.text || "";
            if (name) {
              symbols.push({
                kind: "constant",
                name,
                signature: lines[node.startPosition.row]?.trim() || "",
                docstring: "",
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                filePath,
              });
              if (name[0] && name[0] === name[0].toUpperCase()) {
                exports.push({ symbolName: name, isDefault: false, filePath });
              }
            }
          }
        }
        break;
      }

      default:
        for (const child of node.namedChildren) {
          walk(child);
        }
    }
  }

  for (const child of tree.rootNode.namedChildren) {
    walk(child);
  }

  return { symbols, imports, exports, barrel: null };
}
