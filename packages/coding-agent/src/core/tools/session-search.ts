import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	LabelEntry,
	SessionEntry,
	SessionManager,
	SessionMessageEntry,
} from "../session-manager.js";

const sessionSearchSchema = Type.Object({
	query: Type.String({ description: "搜索关键词（支持多个词空格分隔，匹配任意一个即命中）" }),
	scope: Type.Optional(
		Type.Union(
			[
				Type.Literal("all"),
				Type.Literal("compaction"),
				Type.Literal("branch_summary"),
				Type.Literal("label"),
				Type.Literal("message"),
			],
			{
				description:
					"搜索范围。compaction = 压缩摘要，branch_summary = 分支摘要，label = 标签，message = 用户/助手消息，all = 全部（默认 all）",
			},
		),
	),
	limit: Type.Optional(Type.Number({ description: "最大返回结果数（默认 20）" })),
});

export type SessionSearchToolInput = Static<typeof sessionSearchSchema>;

/** session_search 工具返回的匹配结果 */
export interface SessionSearchMatch {
	/** entry 类型 */
	type: string;
	/** entry ID（可用于定位） */
	entryId: string;
	/** 时间戳 */
	timestamp: string;
	/** 匹配到的文本片段（截取关键上下文，避免过长） */
	snippet: string;
	/** 标签名（仅 label 类型） */
	label?: string;
}

export interface SessionSearchToolDetails {
	matchCount: number;
	scope: string;
	totalEntriesScanned: number;
}

const DEFAULT_LIMIT = 20;
/** 片段最大长度 */
const MAX_SNIPPET_LENGTH = 500;

/**
 * 从文本中提取包含匹配词的上下文片段
 */
function extractSnippet(text: string, keywords: string[]): string {
	if (text.length <= MAX_SNIPPET_LENGTH) {
		return text;
	}

	// 找到第一个关键词出现的位置，截取其上下文
	const lowerText = text.toLowerCase();
	let firstMatchIndex = -1;
	for (const kw of keywords) {
		const idx = lowerText.indexOf(kw.toLowerCase());
		if (idx !== -1 && (firstMatchIndex === -1 || idx < firstMatchIndex)) {
			firstMatchIndex = idx;
		}
	}

	if (firstMatchIndex === -1) {
		// 如果没找到（不应发生），返回开头
		return `${text.slice(0, MAX_SNIPPET_LENGTH)}...`;
	}

	// 以匹配位置为中心，截取上下文
	const contextRadius = Math.floor(MAX_SNIPPET_LENGTH / 2);
	const start = Math.max(0, firstMatchIndex - contextRadius);
	const end = Math.min(text.length, start + MAX_SNIPPET_LENGTH);
	let snippet = text.slice(start, end);

	if (start > 0) snippet = `...${snippet}`;
	if (end < text.length) snippet = `${snippet}...`;

	return snippet;
}

/**
 * 从 SessionMessageEntry 中提取可搜索的文本内容
 */
function extractMessageText(entry: SessionMessageEntry): string {
	const msg = entry.message;
	// 只处理有 content 字段的标准 LLM 消息（user/assistant/toolResult）
	if (!("content" in msg)) {
		return "";
	}
	const content = msg.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.filter((c: { type: string }): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

/**
 * 判断文本是否包含任意一个关键词（大小写不敏感）
 */
function matchesKeywords(text: string, keywords: string[]): boolean {
	const lower = text.toLowerCase();
	return keywords.some((kw) => lower.includes(kw));
}

/**
 * 创建 session_search 工具。
 * 搜索当前 session 的 compaction 摘要、branch summary、label、消息等。
 * 用于 Agent 在 compaction 后回忆已压缩的历史信息。
 */
export function createSessionSearchTool(sessionManager: SessionManager): AgentTool<typeof sessionSearchSchema> {
	return {
		name: "session_search",
		label: "session_search",
		sideEffects: false,
		description:
			"Search through session history including compaction summaries, branch summaries, labels, and messages. " +
			"Use this to recall information that may have been compacted away from the current context. " +
			"Returns matching snippets with entry IDs and timestamps. Does NOT load full history into context.",
		parameters: sessionSearchSchema,
		execute: async (
			_toolCallId: string,
			{ query, scope, limit }: SessionSearchToolInput,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<SessionSearchToolDetails>> => {
			const effectiveScope = scope ?? "all";
			const effectiveLimit = limit ?? DEFAULT_LIMIT;

			// 将 query 按空格拆分为多个关键词
			const keywords = query
				.split(/\s+/)
				.filter((w) => w.length > 0)
				.map((w) => w.toLowerCase());

			if (keywords.length === 0) {
				return {
					content: [{ type: "text", text: "错误：搜索关键词不能为空" }],
					details: { matchCount: 0, scope: effectiveScope, totalEntriesScanned: 0 },
				};
			}

			const entries = sessionManager.getBranch();
			const matches: SessionSearchMatch[] = [];
			let scanned = 0;

			for (const entry of entries) {
				if (matches.length >= effectiveLimit) break;

				// 根据 scope 过滤 entry 类型
				if (effectiveScope !== "all" && !scopeMatchesType(effectiveScope, entry.type)) {
					continue;
				}

				scanned++;
				const match = searchEntry(entry, keywords);
				if (match) {
					matches.push(match);
				}
			}

			const details: SessionSearchToolDetails = {
				matchCount: matches.length,
				scope: effectiveScope,
				totalEntriesScanned: scanned,
			};

			if (matches.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `未找到匹配 "${query}" 的结果（范围: ${effectiveScope}，扫描 ${scanned} 条记录）`,
						},
					],
					details,
				};
			}

			// 格式化输出
			const lines: string[] = [];
			lines.push(`找到 ${matches.length} 条匹配结果（范围: ${effectiveScope}，扫描 ${scanned} 条记录）：\n`);

			for (let i = 0; i < matches.length; i++) {
				const m = matches[i];
				lines.push(`--- [${i + 1}] ${m.type} | ${m.timestamp} | id:${m.entryId} ---`);
				if (m.label) {
					lines.push(`标签: ${m.label}`);
				}
				lines.push(m.snippet);
				lines.push("");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details,
			};
		},
	};
}

/**
 * 检查 scope 是否匹配 entry 类型
 */
function scopeMatchesType(scope: string, entryType: string): boolean {
	switch (scope) {
		case "compaction":
			return entryType === "compaction";
		case "branch_summary":
			return entryType === "branch_summary";
		case "label":
			return entryType === "label";
		case "message":
			return entryType === "message";
		default:
			return true;
	}
}

/**
 * 在单个 entry 中搜索关键词
 */
function searchEntry(entry: SessionEntry, keywords: string[]): SessionSearchMatch | null {
	switch (entry.type) {
		case "compaction": {
			const comp = entry as CompactionEntry;
			const searchText = buildCompactionSearchText(comp);
			if (matchesKeywords(searchText, keywords)) {
				return {
					type: "compaction",
					entryId: entry.id,
					timestamp: entry.timestamp,
					snippet: extractSnippet(searchText, keywords),
				};
			}
			return null;
		}
		case "branch_summary": {
			const bs = entry as BranchSummaryEntry;
			if (matchesKeywords(bs.summary, keywords)) {
				return {
					type: "branch_summary",
					entryId: entry.id,
					timestamp: entry.timestamp,
					snippet: extractSnippet(bs.summary, keywords),
				};
			}
			return null;
		}
		case "label": {
			const lbl = entry as LabelEntry;
			const labelText = lbl.label ?? "";
			if (matchesKeywords(labelText, keywords)) {
				return {
					type: "label",
					entryId: entry.id,
					timestamp: entry.timestamp,
					snippet: labelText,
					label: labelText,
				};
			}
			return null;
		}
		case "message": {
			const msg = entry as SessionMessageEntry;
			const text = extractMessageText(msg);
			const role = msg.message.role;
			// 只搜索 user 和 assistant 消息，跳过 toolResult 等
			if (role !== "user" && role !== "assistant") {
				return null;
			}
			if (matchesKeywords(text, keywords)) {
				return {
					type: `message:${role}`,
					entryId: entry.id,
					timestamp: entry.timestamp,
					snippet: extractSnippet(text, keywords),
				};
			}
			return null;
		}
		default:
			return null;
	}
}

/**
 * 构建 compaction entry 的可搜索文本（包括 summary + details 中的结构化信息）
 */
function buildCompactionSearchText(comp: CompactionEntry): string {
	const parts: string[] = [comp.summary];

	// 提取 CompactionDetails 中的结构化数据
	if (comp.details && typeof comp.details === "object") {
		const d = comp.details as Record<string, unknown>;
		if (Array.isArray(d.modifiedFiles)) {
			parts.push(`Modified files: ${(d.modifiedFiles as string[]).join(", ")}`);
		}
		if (Array.isArray(d.readFiles)) {
			parts.push(`Read files: ${(d.readFiles as string[]).join(", ")}`);
		}
		if (Array.isArray(d.pendingTasks)) {
			parts.push(`Pending tasks: ${(d.pendingTasks as string[]).join(", ")}`);
		}
		if (Array.isArray(d.decisions)) {
			parts.push(`Decisions: ${(d.decisions as string[]).join(", ")}`);
		}
	}

	return parts.join("\n");
}
