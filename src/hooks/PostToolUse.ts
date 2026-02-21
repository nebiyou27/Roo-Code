import fs from "fs/promises"
import path from "path"

import type { ToolParamName } from "../shared/tools"
import { TraceLogger } from "./TraceLogger"

export interface PostToolUseContext {
	taskId: string
	cwd: string
	toolName: string
	params: Partial<Record<ToolParamName, string>>
	status: "success" | "denied" | "error"
	reason?: string
	intentId?: string
	toolUseId?: string
}

export class PostToolUse {
	constructor(private readonly traceLogger = new TraceLogger()) {}

	private async ensureFileWithHeader(filePath: string, header: string): Promise<void> {
		try {
			await fs.access(filePath)
		} catch {
			await fs.mkdir(path.dirname(filePath), { recursive: true })
			await fs.writeFile(filePath, `${header}\n\n`, "utf8")
		}
	}

	private async appendIntentMap(context: PostToolUseContext): Promise<void> {
		const mapPath = path.join(context.cwd, ".orchestration", "intent_map.md")
		await this.ensureFileWithHeader(mapPath, "# Intent Spatial Map\n> Maps business intents to physical files")

		const timestamp = new Date().toISOString()
		const filePath = context.params.path ?? context.params.file_path ?? "unknown"
		const mutationClass =
			((context.params as Record<string, string | undefined>).mutation_class as
				| "AST_REFACTOR"
				| "INTENT_EVOLUTION"
				| undefined) ?? "INTENT_EVOLUTION"
		const block = `## ${context.intentId ?? "INT-001"} → ${filePath}
- Last modified: ${timestamp}
- Mutation: ${mutationClass}
- Tool: ${context.toolName}

`
		await fs.appendFile(mapPath, block, "utf8")
	}

	private async appendLessonLearned(context: PostToolUseContext): Promise<void> {
		const timestamp = new Date().toISOString()
		const claudePath = path.join(context.cwd, "CLAUDE.md")
		await this.ensureFileWithHeader(claudePath, "# Shared Brain\n> Lessons learned across agent sessions")
		const lesson = `## Lesson Learned - ${timestamp}
- Intent: ${context.intentId ?? "unknown"}
- Tool: ${context.toolName}
- Failure: ${context.reason ?? "Unknown failure"}
- Action: Re-read file and retry with correct scope

`
		await fs.appendFile(claudePath, lesson, "utf8")
	}

	async record(context: PostToolUseContext): Promise<void> {
		await this.traceLogger.append(context.cwd, {
			ts: new Date().toISOString(),
			task_id: context.taskId,
			intent_id: context.intentId,
			tool_use_id: context.toolUseId,
			tool_name: context.toolName,
			params: context.params,
			status: context.status,
			reason: context.reason,
		})

		if (context.toolName === "write_to_file" && context.status === "success") {
			await this.appendIntentMap(context)
		}

		if (context.status !== "success") {
			await this.appendLessonLearned(context)
		}
	}
}
