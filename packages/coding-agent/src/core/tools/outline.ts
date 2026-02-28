import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { readFile } from "fs/promises";
import nodePath from "path";
import ts from "typescript";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const outlineSchema = Type.Object({
	path: Type.String({ description: "Path to the file to outline (relative or absolute)" }),
});

export type OutlineToolInput = Static<typeof outlineSchema>;

export interface OutlineToolDetails {
	truncation?: TruncationResult;
	/** 提取到的定义数量 */
	definitionCount?: number;
}

/**
 * 可插拔的文件读取操作接口。
 * 重写以支持远程系统（如 SSH）。
 */
export interface OutlineOperations {
	readFile: (absolutePath: string) => Promise<string>;
}

const defaultOutlineOperations: OutlineOperations = {
	readFile: async (p: string) => readFile(p, "utf-8"),
};

export interface OutlineToolOptions {
	operations?: OutlineOperations;
}

// ============================================================================
// 通用 outline entry
// ============================================================================

interface OutlineEntry {
	line: number;
	text: string;
	kind: string;
	/** AST 嵌套深度（0 = 顶层） */
	depth: number;
}

// ============================================================================
// TypeScript / JavaScript AST 提取
// ============================================================================

/** TS/JS 文件扩展名集合 */
const TS_JS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/** 根据扩展名选择 TS ScriptKind */
function getScriptKind(ext: string): ts.ScriptKind {
	switch (ext) {
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		default:
			return ts.ScriptKind.TS;
	}
}

/** 提取修饰符前缀（export, async, abstract 等） */
function getModifiers(node: ts.Node): string {
	const mods: string[] = [];
	if (ts.canHaveModifiers(node)) {
		const modifiers = ts.getModifiers(node);
		if (modifiers) {
			for (const m of modifiers) {
				switch (m.kind) {
					case ts.SyntaxKind.ExportKeyword:
						mods.push("export");
						break;
					case ts.SyntaxKind.DefaultKeyword:
						mods.push("default");
						break;
					case ts.SyntaxKind.AsyncKeyword:
						mods.push("async");
						break;
					case ts.SyntaxKind.AbstractKeyword:
						mods.push("abstract");
						break;
					case ts.SyntaxKind.DeclareKeyword:
						mods.push("declare");
						break;
					case ts.SyntaxKind.StaticKeyword:
						mods.push("static");
						break;
					case ts.SyntaxKind.ReadonlyKeyword:
						mods.push("readonly");
						break;
					case ts.SyntaxKind.PrivateKeyword:
						mods.push("private");
						break;
					case ts.SyntaxKind.ProtectedKeyword:
						mods.push("protected");
						break;
					case ts.SyntaxKind.PublicKeyword:
						mods.push("public");
						break;
				}
			}
		}
	}
	return mods.length > 0 ? `${mods.join(" ")} ` : "";
}

/** 序列化泛型类型参数 <T, U extends Foo> */
function formatTypeParams(node: ts.Node & { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }): string {
	if (!node.typeParameters || node.typeParameters.length === 0) return "";
	const params = node.typeParameters.map((tp) => {
		let text = tp.name.text;
		if (tp.constraint) {
			text += ` extends ${tp.constraint.getText()}`;
		}
		if (tp.default) {
			text += ` = ${tp.default.getText()}`;
		}
		return text;
	});
	return `<${params.join(", ")}>`;
}

/** 序列化函数参数列表 (a: string, b: number) */
function formatParams(
	params: ts.NodeArray<ts.ParameterDeclaration>,
	sourceFile: ts.SourceFile,
	maxLen: number = 80,
): string {
	if (params.length === 0) return "()";
	const parts = params.map((p) => {
		const dots = p.dotDotDotToken ? "..." : "";
		const question = p.questionToken ? "?" : "";
		const name = p.name.getText(sourceFile);
		const typeStr = p.type ? `: ${p.type.getText(sourceFile)}` : "";
		return `${dots}${name}${question}${typeStr}`;
	});
	const full = `(${parts.join(", ")})`;
	if (full.length <= maxLen) return full;
	// 超长时简化：只展示数量
	return `(${params.length} params)`;
}

/** 序列化返回值类型 */
function formatReturnType(node: ts.SignatureDeclaration, sourceFile: ts.SourceFile): string {
	if (node.type) {
		const text = node.type.getText(sourceFile);
		if (text.length <= 60) return `: ${text}`;
		return `: ${text.slice(0, 57)}...`;
	}
	return "";
}

/** 提取 heritage 子句（extends / implements） */
function formatHeritage(clauses: ts.NodeArray<ts.HeritageClause> | undefined, sourceFile: ts.SourceFile): string {
	if (!clauses || clauses.length === 0) return "";
	const parts: string[] = [];
	for (const clause of clauses) {
		const keyword = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
		const types = clause.types.map((t) => t.getText(sourceFile)).join(", ");
		parts.push(`${keyword} ${types}`);
	}
	return ` ${parts.join(" ")}`;
}

/** 判断 VariableDeclaration 的初始化值是否为函数/箭头 */
function isCallableInit(init: ts.Expression | undefined): boolean {
	if (!init) return false;
	return (
		ts.isFunctionExpression(init) ||
		ts.isArrowFunction(init) ||
		(ts.isCallExpression(init) && isCallableInit(init.arguments[0]))
	);
}

/** 使用 TypeScript Compiler API 提取 TS/JS 文件的结构化 outline */
function extractOutlineAST(source: string, fileName: string, ext: string): OutlineEntry[] {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, getScriptKind(ext));
	const entries: OutlineEntry[] = [];

	function visit(node: ts.Node, depth: number): void {
		const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

		if (ts.isFunctionDeclaration(node) && node.name) {
			const mods = getModifiers(node);
			const tp = formatTypeParams(node);
			const params = formatParams(node.parameters, sourceFile);
			const ret = formatReturnType(node, sourceFile);
			entries.push({ line, kind: "function", depth, text: `${mods}function ${node.name.text}${tp}${params}${ret}` });
			// 不递归函数体
			return;
		}

		if (ts.isClassDeclaration(node)) {
			const mods = getModifiers(node);
			const name = node.name?.text ?? "(anonymous)";
			const tp = formatTypeParams(node);
			const heritage = formatHeritage(node.heritageClauses, sourceFile);
			entries.push({ line, kind: "class", depth, text: `${mods}class ${name}${tp}${heritage}` });
			// 遍历 class 成员
			for (const member of node.members) {
				visit(member, depth + 1);
			}
			return;
		}

		if (ts.isInterfaceDeclaration(node)) {
			const mods = getModifiers(node);
			const tp = formatTypeParams(node);
			const heritage = formatHeritage(node.heritageClauses, sourceFile);
			entries.push({ line, kind: "interface", depth, text: `${mods}interface ${node.name.text}${tp}${heritage}` });
			// 遍历接口成员
			for (const member of node.members) {
				visit(member, depth + 1);
			}
			return;
		}

		if (ts.isTypeAliasDeclaration(node)) {
			const mods = getModifiers(node);
			const tp = formatTypeParams(node);
			// 简化类型体：对象/联合类型不全展开
			let typeText = node.type.getText(sourceFile);
			if (typeText.length > 80) typeText = `${typeText.slice(0, 77)}...`;
			entries.push({ line, kind: "type", depth, text: `${mods}type ${node.name.text}${tp} = ${typeText}` });
			return;
		}

		if (ts.isEnumDeclaration(node)) {
			const mods = getModifiers(node);
			const memberNames = node.members.map((m) => m.name.getText(sourceFile));
			const memberText =
				memberNames.length <= 6
					? memberNames.join(", ")
					: `${memberNames.slice(0, 5).join(", ")}, ... (${memberNames.length})`;
			entries.push({ line, kind: "enum", depth, text: `${mods}enum ${node.name.text} { ${memberText} }` });
			return;
		}

		if (ts.isModuleDeclaration(node)) {
			const mods = getModifiers(node);
			entries.push({ line, kind: "namespace", depth, text: `${mods}namespace ${node.name.text}` });
			if (node.body) {
				ts.forEachChild(node.body, (child) => visit(child, depth + 1));
			}
			return;
		}

		// MethodDeclaration（class 方法）
		if (ts.isMethodDeclaration(node) && node.name) {
			const mods = getModifiers(node);
			const name = node.name.getText(sourceFile);
			const tp = formatTypeParams(node);
			const params = formatParams(node.parameters, sourceFile);
			const ret = formatReturnType(node, sourceFile);
			entries.push({ line, kind: "method", depth, text: `${mods}${name}${tp}${params}${ret}` });
			return;
		}

		// 构造函数
		if (ts.isConstructorDeclaration(node)) {
			const params = formatParams(node.parameters, sourceFile);
			entries.push({ line, kind: "constructor", depth, text: `constructor${params}` });
			return;
		}

		// PropertyDeclaration（只收集有函数初始化的属性，或 public/protected accessor）
		if (ts.isPropertyDeclaration(node) && node.name) {
			const name = node.name.getText(sourceFile);
			if (isCallableInit(node.initializer)) {
				const mods = getModifiers(node);
				const typeStr = node.type ? `: ${node.type.getText(sourceFile)}` : "";
				entries.push({ line, kind: "property", depth, text: `${mods}${name}${typeStr} = <fn>` });
			}
			// 非函数属性不收集，减少噪声
			return;
		}

		// GetAccessor / SetAccessor
		if (ts.isGetAccessorDeclaration(node) && node.name) {
			const mods = getModifiers(node);
			const name = node.name.getText(sourceFile);
			const ret = formatReturnType(node, sourceFile);
			entries.push({ line, kind: "getter", depth, text: `${mods}get ${name}()${ret}` });
			return;
		}
		if (ts.isSetAccessorDeclaration(node) && node.name) {
			const mods = getModifiers(node);
			const name = node.name.getText(sourceFile);
			const params = formatParams(node.parameters, sourceFile);
			entries.push({ line, kind: "setter", depth, text: `${mods}set ${name}${params}` });
			return;
		}

		// PropertySignature（接口成员：方法签名）
		if (ts.isPropertySignature(node) && node.name) {
			const name = node.name.getText(sourceFile);
			// 只收集函数类型的属性签名
			if (node.type && ts.isFunctionTypeNode(node.type)) {
				const params = formatParams(node.type.parameters, sourceFile);
				const ret = node.type.type ? `: ${node.type.type.getText(sourceFile)}` : "";
				entries.push({ line, kind: "property", depth, text: `${name}${params}${ret}` });
			}
			return;
		}

		// MethodSignature（接口方法）
		if (ts.isMethodSignature(node) && node.name) {
			const name = node.name.getText(sourceFile);
			const tp = formatTypeParams(node);
			const params = formatParams(node.parameters, sourceFile);
			const ret = formatReturnType(node, sourceFile);
			entries.push({ line, kind: "method", depth, text: `${name}${tp}${params}${ret}` });
			return;
		}

		// VariableStatement: export const foo = ...
		if (ts.isVariableStatement(node)) {
			const mods = getModifiers(node);
			for (const decl of node.declarationList.declarations) {
				if (!ts.isIdentifier(decl.name)) continue;
				const name = decl.name.text;
				const declLine = sourceFile.getLineAndCharacterOfPosition(decl.getStart(sourceFile)).line + 1;

				if (isCallableInit(decl.initializer)) {
					// 函数/箭头赋值 — 尝试提取签名
					const init = decl.initializer!;
					if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
						const tp = formatTypeParams(init);
						const params = formatParams(init.parameters, sourceFile);
						const ret = formatReturnType(init, sourceFile);
						const keyword = ts.isArrowFunction(init) ? "const" : "function";
						entries.push({
							line: declLine,
							kind: "function",
							depth,
							text: `${mods}${keyword} ${name}${tp}${params}${ret}`,
						});
					} else {
						entries.push({ line: declLine, kind: "function", depth, text: `${mods}const ${name} = <fn>` });
					}
				} else if (mods.includes("export")) {
					// 非函数的 export 声明
					const typeStr = decl.type ? `: ${decl.type.getText(sourceFile)}` : "";
					entries.push({ line: declLine, kind: "export", depth, text: `${mods}const ${name}${typeStr}` });
				}
			}
			return;
		}

		// ExportAssignment: export default ...
		if (ts.isExportAssignment(node)) {
			entries.push({ line, kind: "export", depth, text: "export default ..." });
			return;
		}

		// 顶层递归：遍历子节点
		ts.forEachChild(node, (child) => visit(child, depth));
	}

	ts.forEachChild(sourceFile, (child) => visit(child, 0));

	// 截断超长文本
	for (const entry of entries) {
		if (entry.text.length > 120) {
			entry.text = `${entry.text.slice(0, 117)}...`;
		}
	}

	return entries;
}

// ============================================================================
// Regex fallback（非 TS/JS 语言）
// ============================================================================

interface DefinitionPattern {
	pattern: RegExp;
	kind: string;
}

function getRegexPatterns(ext: string): DefinitionPattern[] {
	switch (ext) {
		case ".py":
			return [
				{ pattern: /^class\s+\w+/, kind: "class" },
				{ pattern: /^(?:async\s+)?def\s+\w+/, kind: "function" },
				{ pattern: /^\s{4}(?:async\s+)?def\s+\w+/, kind: "method" },
				{ pattern: /^\s{4}@(?:property|staticmethod|classmethod)/, kind: "decorator" },
			];
		case ".go":
			return [
				{ pattern: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?\w+/, kind: "func" },
				{ pattern: /^type\s+\w+\s+(?:struct|interface)\b/, kind: "type" },
				{ pattern: /^type\s+\w+\s+/, kind: "type" },
				{ pattern: /^var\s+\w+/, kind: "var" },
				{ pattern: /^const\s+\(/, kind: "const" },
			];
		case ".rs":
			return [
				{ pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+/, kind: "fn" },
				{ pattern: /^\s*(?:pub\s+)?struct\s+\w+/, kind: "struct" },
				{ pattern: /^\s*(?:pub\s+)?enum\s+\w+/, kind: "enum" },
				{ pattern: /^\s*(?:pub\s+)?trait\s+\w+/, kind: "trait" },
				{ pattern: /^\s*impl(?:<[^>]+>)?\s+\w+/, kind: "impl" },
				{ pattern: /^\s*(?:pub\s+)?mod\s+\w+/, kind: "mod" },
			];
		case ".java":
		case ".kt":
		case ".scala":
			return [
				{ pattern: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?class\s+\w+/, kind: "class" },
				{ pattern: /^\s*(?:public|private|protected)?\s*(?:static\s+)?interface\s+\w+/, kind: "interface" },
				{ pattern: /^\s*(?:public|private|protected)?\s*(?:static\s+)?enum\s+\w+/, kind: "enum" },
				{
					pattern:
						/^\s+(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?(?:synchronized\s+)?(?:\w+(?:<[^>]+>)?)\s+\w+\s*\(/,
					kind: "method",
				},
			];
		case ".c":
		case ".h":
		case ".cpp":
		case ".hpp":
		case ".cc":
		case ".cxx":
			return [
				{ pattern: /^(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:\w+[\s*]+)+\w+\s*\(/, kind: "function" },
				{ pattern: /^(?:typedef\s+)?struct\s+\w+/, kind: "struct" },
				{ pattern: /^(?:typedef\s+)?enum\s+\w+/, kind: "enum" },
				{ pattern: /^class\s+\w+/, kind: "class" },
				{ pattern: /^namespace\s+\w+/, kind: "namespace" },
				{ pattern: /^#define\s+\w+/, kind: "macro" },
			];
		case ".rb":
			return [
				{ pattern: /^\s*class\s+\w+/, kind: "class" },
				{ pattern: /^\s*module\s+\w+/, kind: "module" },
				{ pattern: /^\s*def\s+\w+/, kind: "method" },
			];
		case ".sh":
		case ".bash":
		case ".zsh":
			return [{ pattern: /^\s*(?:function\s+)?\w+\s*\(\)\s*\{?/, kind: "function" }];
		default:
			return [
				{ pattern: /^(?:export\s+)?(?:function|class|interface|type|enum)\s+\w+/, kind: "definition" },
				{ pattern: /^(?:pub\s+)?(?:fn|struct|enum|trait|impl|mod)\s+\w+/, kind: "definition" },
				{ pattern: /^(?:def|class)\s+\w+/, kind: "definition" },
				{ pattern: /^func\s+\w+/, kind: "definition" },
			];
	}
}

const C_EXTENSIONS = new Set([".c", ".h", ".cpp", ".hpp", ".cc", ".cxx"]);

/** Regex fallback 提取（非 TS/JS 语言） */
function extractOutlineRegex(source: string, ext: string): OutlineEntry[] {
	const patterns = getRegexPatterns(ext);
	if (patterns.length === 0) return [];

	const lines = source.split("\n");
	const entries: OutlineEntry[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trimStart();
		if (!trimmed) continue;
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
		if (trimmed.startsWith("#") && !C_EXTENSIONS.has(ext)) continue;

		for (const { pattern, kind } of patterns) {
			if (pattern.test(line)) {
				const expanded = line.replace(/\t/g, "    ");
				const indent = expanded.length - expanded.trimStart().length;
				let text = line.trimEnd();
				if (text.endsWith("{")) text = text.slice(0, -1).trimEnd();
				if (text.length > 120) text = `${text.slice(0, 117)}...`;
				entries.push({ line: i + 1, text: text.trimStart(), kind, depth: Math.floor(indent / 2) });
				break;
			}
		}
	}

	return entries;
}

// ============================================================================
// 统一入口
// ============================================================================

function extractOutline(source: string, filePath: string, ext: string): OutlineEntry[] {
	if (TS_JS_EXTENSIONS.has(ext)) {
		return extractOutlineAST(source, filePath, ext);
	}
	return extractOutlineRegex(source, ext);
}

// ============================================================================
// 工具创建
// ============================================================================

export function createOutlineTool(cwd: string, options?: OutlineToolOptions): AgentTool<typeof outlineSchema> {
	const ops = options?.operations ?? defaultOutlineOperations;

	return {
		name: "outline",
		label: "outline",
		sideEffects: false,
		description: `Extract code structure outline from a file. Shows definitions (functions, classes, interfaces, types, etc.) with line numbers. Useful for understanding file structure without reading every line. Supports TypeScript, JavaScript, Python, Go, Rust, Java, C/C++, Ruby, and shell scripts.`,
		parameters: outlineSchema,
		execute: async (_toolCallId: string, { path }: { path: string }, signal?: AbortSignal) => {
			if (signal?.aborted) throw new Error("Operation aborted");

			const filePath = resolveToCwd(path, cwd);
			const ext = nodePath.extname(filePath).toLowerCase();

			let source: string;
			try {
				source = await ops.readFile(filePath);
			} catch (e: any) {
				throw new Error(`Cannot read file: ${e.message}`);
			}

			const entries = extractOutline(source, filePath, ext);

			if (entries.length === 0) {
				const totalLines = source.split("\n").length;
				return {
					content: [
						{
							type: "text",
							text:
								`No definitions found in ${nodePath.basename(filePath)} (${totalLines} lines). ` +
								`Try using the read tool for this file.`,
						},
					],
					details: undefined,
				};
			}

			// 格式化输出
			const totalLines = source.split("\n").length;
			const header = `# ${nodePath.basename(filePath)} (${totalLines} lines, ${entries.length} definitions)\n`;
			const body = entries.map((e) => {
				const indentStr = e.depth > 0 ? "  ".repeat(e.depth) : "";
				return `${indentStr}L${e.line}: [${e.kind}] ${e.text}`;
			});

			const rawOutput = header + body.join("\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

			const details: OutlineToolDetails = { definitionCount: entries.length };
			let output = truncation.content;

			if (truncation.truncated) {
				output += `\n\n[Output truncated: ${formatSize(DEFAULT_MAX_BYTES)} limit reached]`;
				details.truncation = truncation;
			}

			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
	};
}

/** 使用 process.cwd() 的默认 outline 工具 — 向后兼容 */
export const outlineTool = createOutlineTool(process.cwd());
