import Parser from "tree-sitter";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// tree-sitter language bindings are CommonJS native modules —
// use createRequire for reliable interop in ESM context.
const TypeScriptLang = require("tree-sitter-typescript");
const PythonLang = require("tree-sitter-python");
const GoLang = require("tree-sitter-go");
const RustLang = require("tree-sitter-rust");
const JavaLang = require("tree-sitter-java");
const KotlinLang = require("tree-sitter-kotlin");
const CSharpLang = require("tree-sitter-c-sharp");
const RubyLang = require("tree-sitter-ruby");
const PhpLang = require("tree-sitter-php");
const SwiftLang = require("tree-sitter-swift");

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

type SupportedLanguage = "typescript" | "tsx" | "javascript" | "python" | "go" | "rust" | "java" | "kotlin" | "csharp" | "ruby" | "php" | "swift";

const parsers = new Map<string, Parser>();

function getParser(language: SupportedLanguage): Parser {
  if (parsers.has(language)) return parsers.get(language)!;

  const parser = new Parser();
  switch (language) {
    case "typescript":
      parser.setLanguage(TSParser);
      break;
    case "tsx":
    case "javascript":
      parser.setLanguage(TSXParser); // TSX handles both JSX and TSX
      break;
    case "python":
      parser.setLanguage(PythonLang);
      break;
    case "go":
      parser.setLanguage(GoLang);
      break;
    case "rust":
      parser.setLanguage(RustLang);
      break;
    case "java":
      parser.setLanguage(JavaLang);
      break;
    case "kotlin":
      parser.setLanguage(KotlinLang);
      break;
    case "csharp":
      parser.setLanguage(CSharpLang);
      break;
    case "ruby":
      parser.setLanguage(RubyLang);
      break;
    case "php":
      parser.setLanguage(PhpLang.php);
      break;
    case "swift":
      parser.setLanguage(SwiftLang);
      break;
  }
  parsers.set(language, parser);
  return parser;
}

export function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  return ["typescript", "tsx", "javascript", "python", "go", "rust", "java", "kotlin", "csharp", "ruby", "php", "swift"].includes(lang);
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
    case "tsx":
    case "javascript":
      return parseTypeScript(tree, filePath, lines);
    case "python":
      return parsePython(tree, filePath, lines);
    case "go":
      return parseGo(tree, filePath, lines);
    case "rust":
      return parseRust(tree, filePath, lines);
    case "java":
      return parseJava(tree, filePath, lines);
    case "kotlin":
      return parseKotlin(tree, filePath, lines);
    case "csharp":
      return parseCSharp(tree, filePath, lines);
    case "ruby":
      return parseRuby(tree, filePath, lines);
    case "php":
      return parsePhp(tree, filePath, lines);
    case "swift":
      return parseSwift(tree, filePath, lines);
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

      case "expression_statement": {
        // Detect Express-style route handlers:
        //   router.get("/path", handler)
        //   app.post("/path", async (req, res) => { ... })
        //   router.use("/path", middleware)
        const expr = node.namedChildren[0];
        if (expr?.type === "call_expression") {
          const callee = expr.childForFieldName("function");
          if (callee?.type === "member_expression") {
            const method = callee.childForFieldName("property")?.text;
            const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "use", "all"]);
            if (method && HTTP_METHODS.has(method)) {
              const args = expr.childForFieldName("arguments");
              if (args && args.namedChildren.length >= 2) {
                const pathArg = args.namedChildren[0];
                // First arg should be a string literal (the route path)
                if (pathArg.type === "string" || pathArg.type === "template_string") {
                  const routePath = pathArg.text.replace(/['"`]/g, "");
                  // Find the handler function (last argument that's a function)
                  const handlerArg = args.namedChildren[args.namedChildren.length - 1];
                  if (
                    handlerArg.type === "arrow_function" ||
                    handlerArg.type === "function_expression" ||
                    handlerArg.type === "function"
                  ) {
                    const handlerName = `${method.toUpperCase()} ${routePath}`;
                    symbols.push({
                      kind: "function",
                      name: handlerName,
                      signature: `${method.toUpperCase()} ${routePath}`,
                      docstring: getDocstring(node),
                      startLine: handlerArg.startPosition.row + 1,
                      endLine: handlerArg.endPosition.row + 1,
                      filePath,
                    });
                  }
                }
              }
            }
          }
        }
        // Still recurse into children for any nested declarations
        for (const child of node.namedChildren) {
          walk(child, false, false);
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

// --- Rust ---

function parseRust(
  tree: Parser.Tree,
  filePath: string,
  lines: string[]
): ParseResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const exports: ParsedExport[] = [];

  function getDocstring(node: Parser.SyntaxNode): string {
    const docLines: string[] = [];
    let prev = node.previousNamedSibling;
    while (prev?.type === "line_comment") {
      const text = prev.text;
      if (text.startsWith("///") || text.startsWith("//!")) {
        docLines.unshift(text.replace(/^\/\/[\/!]\s?/, ""));
      } else {
        break;
      }
      prev = prev.previousNamedSibling;
    }
    return docLines.join("\n").trim();
  }

  function getSignature(node: Parser.SyntaxNode, lines: string[]): string {
    const startLine = node.startPosition.row;
    const line = lines[startLine] || "";
    return line.trim().replace(/\{[\s\S]*$/, "").trim();
  }

  function isPublic(node: Parser.SyntaxNode): boolean {
    for (const child of node.children) {
      if (child.type === "visibility_modifier") return true;
    }
    return false;
  }

  function walk(node: Parser.SyntaxNode, implTarget?: string) {
    switch (node.type) {
      case "function_item": {
        const rawName = node.childForFieldName("name")?.text || "";
        const name = implTarget ? `${implTarget}.${rawName}` : rawName;
        const params = node.childForFieldName("parameters")?.text || "";
        const returnType = node.childForFieldName("return_type")?.text || "";

        symbols.push({
          kind: "function",
          name,
          signature: `fn ${rawName}${params}${returnType ? " " + returnType : ""}`,
          docstring: getDocstring(node),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          filePath,
        });

        if (isPublic(node) && !implTarget) {
          exports.push({ symbolName: rawName, isDefault: false, filePath });
        }
        break;
      }

      case "struct_item": {
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
          if (isPublic(node)) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
        }
        break;
      }

      case "enum_item": {
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
          if (isPublic(node)) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
        }
        break;
      }

      case "trait_item": {
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
          if (isPublic(node)) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
        }
        break;
      }

      case "type_item": {
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
          if (isPublic(node)) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
        }
        break;
      }

      case "const_item":
      case "static_item": {
        const name = node.childForFieldName("name")?.text || "";
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
          if (isPublic(node)) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
        }
        break;
      }

      case "impl_item": {
        const typeNode = node.childForFieldName("type");
        const typeName = typeNode?.text || "";
        const body = node.childForFieldName("body");
        if (body && typeName) {
          for (const child of body.namedChildren) {
            if (child.type === "function_item") {
              walk(child, typeName);
            }
          }
        }
        break;
      }

      case "use_declaration": {
        const argument = node.childForFieldName("argument");
        if (!argument) break;

        const usePath = argument.text;
        const importedSymbols: string[] = [];

        const useList = argument.descendantsOfType("use_list")[0];
        if (useList) {
          for (const child of useList.namedChildren) {
            const name = child.type === "use_as_clause"
              ? child.childForFieldName("alias")?.text || child.children[0]?.text || ""
              : child.text;
            if (name) importedSymbols.push(name);
          }
          const pathParts = usePath.split("::{")[0];
          imports.push({
            source: pathParts,
            symbols: importedSymbols,
            defaultImport: null,
            filePath,
          });
        } else if (usePath.includes("::*")) {
          const modulePath = usePath.replace("::*", "");
          imports.push({
            source: modulePath,
            symbols: ["*"],
            defaultImport: null,
            filePath,
          });
        } else {
          const parts = usePath.split("::");
          const lastPart = parts[parts.length - 1] || "";
          const modulePath = parts.slice(0, -1).join("::");
          if (modulePath) {
            imports.push({
              source: modulePath,
              symbols: [lastPart],
              defaultImport: null,
              filePath,
            });
          } else {
            imports.push({
              source: usePath,
              symbols: [],
              defaultImport: usePath,
              filePath,
            });
          }
        }
        break;
      }

      case "mod_item": {
        const name = node.childForFieldName("name")?.text || "";
        const body = node.childForFieldName("body");
        if (name && !body) {
          imports.push({
            source: name,
            symbols: [],
            defaultImport: name,
            filePath,
          });
        }
        if (name && body) {
          for (const child of body.namedChildren) {
            walk(child);
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

// --- Java ---

function parseJava(
  tree: Parser.Tree,
  filePath: string,
  lines: string[]
): ParseResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const exports: ParsedExport[] = [];
  let packageName = "";

  function getDocstring(node: Parser.SyntaxNode): string {
    const prev = node.previousNamedSibling;
    if (prev?.type === "block_comment" || prev?.type === "line_comment") {
      return prev.text.replace(/^\/\*\*?\s*|\s*\*\/$/g, "").replace(/^\s*\*\s?/gm, "").trim();
    }
    return "";
  }

  function getSignature(node: Parser.SyntaxNode, lines: string[]): string {
    const startLine = node.startPosition.row;
    const line = lines[startLine] || "";
    return line.trim().replace(/\{[\s\S]*$/, "").trim();
  }

  function hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
    for (const child of node.children) {
      if (child.type === "modifiers") {
        return child.text.includes(modifier);
      }
    }
    return false;
  }

  function isPublic(node: Parser.SyntaxNode): boolean {
    return hasModifier(node, "public");
  }

  function walk(node: Parser.SyntaxNode, className?: string) {
    switch (node.type) {
      case "class_declaration":
      case "record_declaration": {
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
          if (isPublic(node)) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
          const body = node.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, name);
            }
          }
        }
        break;
      }

      case "interface_declaration":
      case "annotation_type_declaration": {
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
          if (isPublic(node)) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
          const body = node.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, name);
            }
          }
        }
        break;
      }

      case "enum_declaration": {
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
          if (isPublic(node)) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
          const body = node.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, name);
            }
          }
        }
        break;
      }

      case "method_declaration":
      case "constructor_declaration": {
        const rawName = node.type === "constructor_declaration" ? "constructor" : (node.childForFieldName("name")?.text || "");
        const name = className ? `${className}.${rawName}` : rawName;
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
        }
        break;
      }

      case "field_declaration": {
        if (hasModifier(node, "static") && hasModifier(node, "final")) {
          const declarator = node.descendantsOfType("variable_declarator")[0];
          const name = declarator?.childForFieldName("name")?.text || "";
          if (name) {
            symbols.push({
              kind: "constant",
              name: className ? `${className}.${name}` : name,
              signature: getSignature(node, lines),
              docstring: getDocstring(node),
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              filePath,
            });
          }
        }
        break;
      }

      case "import_declaration": {
        const isStatic = node.children.some(c => c.type === "static");
        const pathNodes = node.descendantsOfType("scoped_identifier");
        let importPath = "";
        if (pathNodes.length > 0) {
          // Use the outermost (first) scoped_identifier — it has the full path
          importPath = pathNodes[0].text;
        } else {
          const id = node.descendantsOfType("identifier");
          if (id.length > 0) importPath = id[id.length - 1].text;
        }
        if (!importPath) break;

        const isWildcard = node.text.includes(".*");
        const parts = importPath.split(".");
        const symbolName = isWildcard ? "*" : parts[parts.length - 1];
        const packagePath = isWildcard ? importPath.replace(".*", "") : parts.slice(0, -1).join(".");

        imports.push({
          source: isStatic ? importPath : packagePath,
          symbols: [symbolName],
          defaultImport: null,
          filePath,
        });
        break;
      }

      case "package_declaration": {
        const pathNode = node.descendantsOfType("scoped_identifier")[0] || node.descendantsOfType("identifier")[0];
        packageName = pathNode?.text || "";
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

// --- Kotlin ---

function parseKotlin(
  tree: Parser.Tree,
  filePath: string,
  lines: string[]
): ParseResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const exports: ParsedExport[] = [];

  function getDocstring(node: Parser.SyntaxNode): string {
    const prev = node.previousNamedSibling;
    if (prev?.type === "multiline_comment" || prev?.type === "comment") {
      return prev.text.replace(/^\/\*\*?\s*|\s*\*\/$/g, "").replace(/^\s*\*\s?/gm, "").trim();
    }
    return "";
  }

  function getSignature(node: Parser.SyntaxNode, lines: string[]): string {
    const startLine = node.startPosition.row;
    const line = lines[startLine] || "";
    return line.trim().replace(/\{[\s\S]*$/, "").trim();
  }

  function isPublic(node: Parser.SyntaxNode): boolean {
    for (const child of node.children) {
      if (child.type === "visibility_modifier") {
        return child.text === "public";
      }
      if (child.type === "modifiers") {
        if (child.text.includes("private") || child.text.includes("protected") || child.text.includes("internal")) {
          return false;
        }
      }
    }
    return true; // public by default in Kotlin
  }

  function walk(node: Parser.SyntaxNode, className?: string) {
    switch (node.type) {
      case "class_declaration": {
        const name = node.childForFieldName("name")?.text
          || node.descendantsOfType("type_identifier")[0]?.text || "";
        // Kotlin uses class_declaration for interfaces too — detect via "interface" keyword child
        const isInterface = node.children.some(c => c.type === "interface");
        if (name) {
          symbols.push({
            kind: isInterface ? "type" : "class",
            name,
            signature: getSignature(node, lines),
            docstring: getDocstring(node),
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            filePath,
          });
          if (isPublic(node)) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
          const body = node.childForFieldName("body") || node.descendantsOfType("class_body")[0];
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, name);
            }
          }
        }
        break;
      }

      case "object_declaration": {
        const name = node.childForFieldName("name")?.text
          || node.descendantsOfType("type_identifier")[0]?.text || "";
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
          if (isPublic(node)) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
          const body = node.childForFieldName("body") || node.descendantsOfType("class_body")[0];
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, name);
            }
          }
        }
        break;
      }

      case "companion_object": {
        const body = node.descendantsOfType("class_body")[0];
        if (body && className) {
          for (const child of body.namedChildren) {
            walk(child, `${className}.Companion`);
          }
        }
        break;
      }

      case "function_declaration": {
        const rawName = node.childForFieldName("name")?.text
          || node.descendantsOfType("simple_identifier")[0]?.text || "";
        const name = className ? `${className}.${rawName}` : rawName;
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
          if (!className && isPublic(node)) {
            exports.push({ symbolName: rawName, isDefault: false, filePath });
          }
        }
        break;
      }

      case "property_declaration": {
        const rawName = node.childForFieldName("name")?.text
          || node.descendantsOfType("variable_declaration")[0]?.text || "";
        if (rawName) {
          const isConst = node.text.startsWith("const ") || node.children.some(c => c.type === "modifiers" && c.text.includes("const"));
          const isVal = node.text.includes("val ");
          symbols.push({
            kind: isConst || isVal ? "constant" : "function",
            name: className ? `${className}.${rawName}` : rawName,
            signature: getSignature(node, lines),
            docstring: getDocstring(node),
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            filePath,
          });
          if (!className && isPublic(node)) {
            exports.push({ symbolName: rawName, isDefault: false, filePath });
          }
        }
        break;
      }

      case "interface_declaration": {
        const name = node.childForFieldName("name")?.text
          || node.descendantsOfType("type_identifier")[0]?.text || "";
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
          if (isPublic(node)) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
          const body = node.childForFieldName("body") || node.descendantsOfType("class_body")[0];
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, name);
            }
          }
        }
        break;
      }

      case "type_alias": {
        const name = node.descendantsOfType("type_identifier")[0]?.text || "";
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
          if (isPublic(node)) {
            exports.push({ symbolName: name, isDefault: false, filePath });
          }
        }
        break;
      }

      case "import_header": {
        const identifier = node.descendantsOfType("identifier")[0];
        const importPath = identifier?.text || "";
        if (!importPath) break;

        const isWildcard = node.text.includes(".*");
        const parts = importPath.split(".");
        const symbolName = isWildcard ? "*" : parts[parts.length - 1];
        const packagePath = isWildcard ? importPath.replace(".*", "") : parts.slice(0, -1).join(".");

        imports.push({
          source: packagePath || importPath,
          symbols: [symbolName],
          defaultImport: null,
          filePath,
        });
        break;
      }

      case "import_list": {
        for (const child of node.namedChildren) {
          walk(child);
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

// --- C# ---

function parseCSharp(
  tree: Parser.Tree,
  filePath: string,
  lines: string[]
): ParseResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const exports: ParsedExport[] = [];

  function getDocstring(node: Parser.SyntaxNode): string {
    const prev = node.previousNamedSibling;
    if (prev?.type === "comment") {
      return prev.text.replace(/^\/\/\/?\s?/gm, "").trim();
    }
    return "";
  }

  function getSignature(node: Parser.SyntaxNode): string {
    return (lines[node.startPosition.row] || "").trim().replace(/\{[\s\S]*$/, "").trim();
  }

  function hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
    for (const child of node.children) {
      if (child.type === "modifier" && child.text === modifier) return true;
    }
    return false;
  }

  function walk(node: Parser.SyntaxNode, className?: string) {
    switch (node.type) {
      case "class_declaration":
      case "record_declaration":
      case "struct_declaration": {
        const name = node.childForFieldName("name")?.text || "";
        if (name) {
          symbols.push({ kind: "class", name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          if (hasModifier(node, "public")) exports.push({ symbolName: name, isDefault: false, filePath });
          const body = node.descendantsOfType("declaration_list")[0];
          if (body) for (const child of body.namedChildren) walk(child, name);
        }
        break;
      }

      case "interface_declaration": {
        const name = node.childForFieldName("name")?.text || "";
        if (name) {
          symbols.push({ kind: "type", name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          if (hasModifier(node, "public")) exports.push({ symbolName: name, isDefault: false, filePath });
          const body = node.descendantsOfType("declaration_list")[0];
          if (body) for (const child of body.namedChildren) walk(child, name);
        }
        break;
      }

      case "enum_declaration": {
        const name = node.childForFieldName("name")?.text || "";
        if (name) {
          symbols.push({ kind: "class", name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          if (hasModifier(node, "public")) exports.push({ symbolName: name, isDefault: false, filePath });
        }
        break;
      }

      case "method_declaration":
      case "constructor_declaration": {
        const rawName = node.type === "constructor_declaration" ? "constructor" : (node.childForFieldName("name")?.text || "");
        const name = className ? `${className}.${rawName}` : rawName;
        if (name) {
          symbols.push({ kind: "function", name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
        }
        break;
      }

      case "property_declaration":
      case "field_declaration": {
        if (hasModifier(node, "static") || hasModifier(node, "const") || hasModifier(node, "readonly")) {
          const declarators = node.descendantsOfType("variable_declarator");
          for (const decl of declarators) {
            const name = decl.childForFieldName("name")?.text || decl.text?.split(/\s|=/)[0] || "";
            if (name) {
              symbols.push({ kind: "constant", name: className ? `${className}.${name}` : name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
            }
          }
        }
        break;
      }

      case "using_directive": {
        const qualifiedName = node.descendantsOfType("qualified_name")[0];
        const importPath = qualifiedName?.text || node.descendantsOfType("identifier")[0]?.text || "";
        if (importPath) {
          imports.push({ source: importPath, symbols: [], defaultImport: importPath, filePath });
        }
        break;
      }

      case "namespace_declaration": {
        const body = node.descendantsOfType("declaration_list")[0];
        if (body) for (const child of body.namedChildren) walk(child, className);
        break;
      }

      default:
        if (!className) for (const child of node.namedChildren) walk(child);
    }
  }

  for (const child of tree.rootNode.namedChildren) walk(child);
  return { symbols, imports, exports, barrel: null };
}

// --- Ruby ---

function parseRuby(
  tree: Parser.Tree,
  filePath: string,
  lines: string[]
): ParseResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const exports: ParsedExport[] = [];

  function getDocstring(node: Parser.SyntaxNode): string {
    const prev = node.previousNamedSibling;
    if (prev?.type === "comment") return prev.text.replace(/^#\s?/gm, "").trim();
    return "";
  }

  function walk(node: Parser.SyntaxNode, className?: string) {
    switch (node.type) {
      case "class": {
        const name = node.childForFieldName("name")?.text || "";
        if (name) {
          symbols.push({ kind: "class", name, signature: (lines[node.startPosition.row] || "").trim(), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          exports.push({ symbolName: name, isDefault: false, filePath });
          const body = node.descendantsOfType("body_statement")[0];
          if (body) for (const child of body.namedChildren) walk(child, name);
        }
        break;
      }

      case "module": {
        const name = node.childForFieldName("name")?.text || "";
        if (name) {
          symbols.push({ kind: "class", name, signature: (lines[node.startPosition.row] || "").trim(), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          exports.push({ symbolName: name, isDefault: false, filePath });
          const body = node.descendantsOfType("body_statement")[0];
          if (body) for (const child of body.namedChildren) walk(child, name);
        }
        break;
      }

      case "method": {
        const rawName = node.childForFieldName("name")?.text || "";
        const name = className ? `${className}.${rawName}` : rawName;
        if (name) {
          symbols.push({ kind: "function", name, signature: (lines[node.startPosition.row] || "").trim(), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          if (!className && !rawName.startsWith("_")) exports.push({ symbolName: rawName, isDefault: false, filePath });
        }
        break;
      }

      case "singleton_method": {
        const rawName = node.childForFieldName("name")?.text || "";
        const name = className ? `${className}.${rawName}` : rawName;
        if (name) {
          symbols.push({ kind: "function", name, signature: (lines[node.startPosition.row] || "").trim(), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
        }
        break;
      }

      case "call": {
        const methodName = node.children[0]?.text || "";
        if (methodName === "require" || methodName === "require_relative") {
          const args = node.descendantsOfType("string");
          for (const arg of args) {
            const content = arg.descendantsOfType("string_content")[0]?.text || "";
            if (content) imports.push({ source: content, symbols: [], defaultImport: content, filePath });
          }
        }
        break;
      }

      case "assignment": {
        const left = node.childForFieldName("left")?.text || "";
        if (/^[A-Z][A-Z0-9_]*$/.test(left)) {
          symbols.push({ kind: "constant", name: className ? `${className}.${left}` : left, signature: (lines[node.startPosition.row] || "").trim(), docstring: "", startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          if (!className) exports.push({ symbolName: left, isDefault: false, filePath });
        }
        break;
      }

      default:
        if (!className) for (const child of node.namedChildren) walk(child);
    }
  }

  for (const child of tree.rootNode.namedChildren) walk(child);
  return { symbols, imports, exports, barrel: null };
}

// --- PHP ---

function parsePhp(
  tree: Parser.Tree,
  filePath: string,
  lines: string[]
): ParseResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const exports: ParsedExport[] = [];

  function getDocstring(node: Parser.SyntaxNode): string {
    const prev = node.previousNamedSibling;
    if (prev?.type === "comment") return prev.text.replace(/^\/\*\*?\s*|\s*\*\/$/g, "").replace(/^\s*\*\s?/gm, "").trim();
    return "";
  }

  function getSignature(node: Parser.SyntaxNode): string {
    return (lines[node.startPosition.row] || "").trim().replace(/\{[\s\S]*$/, "").trim();
  }

  function walk(node: Parser.SyntaxNode, className?: string) {
    switch (node.type) {
      case "class_declaration": {
        const name = node.childForFieldName("name")?.text || "";
        if (name) {
          symbols.push({ kind: "class", name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          exports.push({ symbolName: name, isDefault: false, filePath });
          const body = node.descendantsOfType("declaration_list")[0];
          if (body) for (const child of body.namedChildren) walk(child, name);
        }
        break;
      }

      case "interface_declaration": {
        const name = node.childForFieldName("name")?.text || "";
        if (name) {
          symbols.push({ kind: "type", name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          exports.push({ symbolName: name, isDefault: false, filePath });
          const body = node.descendantsOfType("declaration_list")[0];
          if (body) for (const child of body.namedChildren) walk(child, name);
        }
        break;
      }

      case "trait_declaration": {
        const name = node.childForFieldName("name")?.text || "";
        if (name) {
          symbols.push({ kind: "type", name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          exports.push({ symbolName: name, isDefault: false, filePath });
          const body = node.descendantsOfType("declaration_list")[0];
          if (body) for (const child of body.namedChildren) walk(child, name);
        }
        break;
      }

      case "enum_declaration": {
        const name = node.childForFieldName("name")?.text || "";
        if (name) {
          symbols.push({ kind: "class", name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          exports.push({ symbolName: name, isDefault: false, filePath });
        }
        break;
      }

      case "method_declaration": {
        const rawName = node.childForFieldName("name")?.text || "";
        const name = className ? `${className}.${rawName}` : rawName;
        if (name) {
          symbols.push({ kind: "function", name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
        }
        break;
      }

      case "function_definition": {
        const rawName = node.childForFieldName("name")?.text || "";
        if (rawName) {
          symbols.push({ kind: "function", name: rawName, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          exports.push({ symbolName: rawName, isDefault: false, filePath });
        }
        break;
      }

      case "const_declaration": {
        for (const child of node.namedChildren) {
          if (child.type === "const_element") {
            const name = child.text.split(/\s*=/)[0].trim();
            if (name) {
              symbols.push({ kind: "constant", name: className ? `${className}.${name}` : name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
            }
          }
        }
        break;
      }

      case "namespace_use_declaration": {
        const clauses = node.descendantsOfType("namespace_use_clause");
        for (const clause of clauses) {
          const qualifiedName = clause.descendantsOfType("qualified_name")[0];
          const importPath = qualifiedName?.text || clause.text;
          if (importPath) {
            const parts = importPath.split("\\");
            const symbolName = parts[parts.length - 1];
            const namespacePath = parts.slice(0, -1).join("\\");
            imports.push({ source: namespacePath || importPath, symbols: [symbolName], defaultImport: null, filePath });
          }
        }
        break;
      }

      default:
        if (!className) for (const child of node.namedChildren) walk(child);
    }
  }

  for (const child of tree.rootNode.namedChildren) walk(child);
  return { symbols, imports, exports, barrel: null };
}

// --- Swift ---

function parseSwift(
  tree: Parser.Tree,
  filePath: string,
  lines: string[]
): ParseResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const exports: ParsedExport[] = [];

  function getDocstring(node: Parser.SyntaxNode): string {
    const prev = node.previousNamedSibling;
    if (prev?.type === "comment" || prev?.type === "multiline_comment") {
      return prev.text.replace(/^\/\/\/?\s?/gm, "").replace(/^\/\*\*?\s*|\s*\*\/$/g, "").trim();
    }
    return "";
  }

  function getSignature(node: Parser.SyntaxNode): string {
    return (lines[node.startPosition.row] || "").trim().replace(/\{[\s\S]*$/, "").trim();
  }

  function isPublic(node: Parser.SyntaxNode): boolean {
    for (const child of node.children) {
      if (child.type === "modifiers") {
        const vis = child.descendantsOfType("visibility_modifier")[0];
        if (vis) return vis.text === "public" || vis.text === "open";
      }
    }
    return false;
  }

  function walk(node: Parser.SyntaxNode, className?: string) {
    switch (node.type) {
      case "class_declaration": {
        const nameNode = node.childForFieldName("name") || node.descendantsOfType("type_identifier")[0];
        const name = nameNode?.text || "";
        if (name) {
          symbols.push({ kind: "class", name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          if (isPublic(node)) exports.push({ symbolName: name, isDefault: false, filePath });
          const body = node.descendantsOfType("class_body")[0] || node.descendantsOfType("enum_class_body")[0];
          if (body) for (const child of body.namedChildren) walk(child, name);
        }
        break;
      }

      case "protocol_declaration": {
        const nameNode = node.childForFieldName("name") || node.descendantsOfType("type_identifier")[0];
        const name = nameNode?.text || "";
        if (name) {
          symbols.push({ kind: "type", name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          if (isPublic(node)) exports.push({ symbolName: name, isDefault: false, filePath });
          const body = node.descendantsOfType("protocol_body")[0];
          if (body) for (const child of body.namedChildren) walk(child, name);
        }
        break;
      }

      case "function_declaration":
      case "protocol_function_declaration": {
        const nameNode = node.childForFieldName("name") || node.descendantsOfType("simple_identifier")[0];
        const rawName = nameNode?.text || "";
        const name = className ? `${className}.${rawName}` : rawName;
        if (name) {
          symbols.push({ kind: "function", name, signature: getSignature(node), docstring: getDocstring(node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath });
          if (!className && isPublic(node)) exports.push({ symbolName: rawName, isDefault: false, filePath });
        }
        break;
      }

      case "property_declaration":
      case "protocol_property_declaration": {
        const nameNode = node.childForFieldName("name") || node.descendantsOfType("pattern")[0];
        const rawName = nameNode?.text || "";
        if (rawName) {
          const isLet = node.children.some(c => c.type === "value_binding_pattern" && c.text === "let");
          symbols.push({
            kind: isLet ? "constant" : "function",
            name: className ? `${className}.${rawName}` : rawName,
            signature: getSignature(node), docstring: getDocstring(node),
            startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, filePath,
          });
          if (!className && isPublic(node)) exports.push({ symbolName: rawName, isDefault: false, filePath });
        }
        break;
      }

      case "import_declaration": {
        const identifier = node.descendantsOfType("identifier")[0];
        const importPath = identifier?.text || "";
        if (importPath) {
          imports.push({ source: importPath, symbols: [], defaultImport: importPath, filePath });
        }
        break;
      }

      default:
        if (!className) for (const child of node.namedChildren) walk(child);
    }
  }

  for (const child of tree.rootNode.namedChildren) walk(child);
  return { symbols, imports, exports, barrel: null };
}
