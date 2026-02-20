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

	private isLintOrTestFailure(context: PostToolUseContext): boolean {
		if (context.status !== "error") {
			return false
		}

		const command = context.params.command?.toLowerCase() ?? ""
		const reason = context.reason?.toLowerCase() ?? ""
		const mentionsLintOrTest =
			command.includes("lint") || command.includes("test") || reason.includes("lint") || reason.includes("test")

		return context.toolName === "execute_command" && mentionsLintOrTest
	}

	private buildFixSuggestion(context: PostToolUseContext): string {
		const reason = context.reason?.toLowerCase() ?? ""
		if (reason.includes("lint")) {
			return "Address lint findings and rerun the linter before continuing."
		}
		if (reason.includes("test")) {
			return "Fix failing tests and rerun the test suite to confirm the behavior."
		}
		return "Review command output, apply a minimal fix, and rerun validation."
	}

	private async appendLessonLearned(context: PostToolUseContext): Promise<void> {
		const timestamp = new Date().toISOString()
		const claudePath = path.join(context.cwd, "CLAUDE.md")
		const lesson = `## Lesson Learned - ${timestamp}
- Tool: ${context.toolName}
- Intent: ${context.intentId ?? "unknown"}
- Failure: ${context.reason ?? "Unknown failure"}
- Fix: ${this.buildFixSuggestion(context)}

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

		if (this.isLintOrTestFailure(context)) {
			await this.appendLessonLearned(context)
		}
	}
}
