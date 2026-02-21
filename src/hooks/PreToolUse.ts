import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"

import type { ToolParamName } from "../shared/tools"
import { IntentValidator } from "./IntentValidator"

export interface PreToolUseContext {
	taskId: string
	cwd: string
	toolName: string
	params: Partial<Record<ToolParamName, string>>
}

export interface PreToolUseDecision {
	allowed: boolean
	reason: string
	intentId?: string
}

const SIDE_EFFECT_TOOLS = new Set<string>([
	"write_to_file",
	"execute_command",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"new_task",
])

function hookError(
	error: "intent_required" | "scope_violation" | "intent_validation_failed" | "stale_file",
	message: string,
): string {
	return JSON.stringify({ error, message })
}

export class PreToolUse {
	constructor(private readonly validator = new IntentValidator()) {}

	private hashContent(content: string): string {
		return createHash("sha256").update(content, "utf8").digest("hex")
	}

	private async checkFileStale(filePath: string, expectedHash?: string): Promise<PreToolUseDecision | null> {
		if (!expectedHash) {
			return null
		}

		let currentContent = ""
		try {
			currentContent = await fs.readFile(filePath, "utf8")
		} catch {
			// If file does not exist yet, treat current content as empty.
		}

		const currentHash = this.hashContent(currentContent)
		if (currentHash !== expectedHash) {
			return {
				allowed: false,
				reason: hookError(
					"stale_file",
					`Stale File: ${path.basename(filePath)} has been modified by another agent. Re-read the file before writing.`,
				),
			}
		}

		return null
	}

	async evaluate(context: PreToolUseContext): Promise<PreToolUseDecision> {
		const selectedIntentId = context.params.intent_id?.trim()

		// Scope gating focuses on side-effect tools only.
		if (!SIDE_EFFECT_TOOLS.has(context.toolName)) {
			return { allowed: true, reason: "read-only or non-side-effect tool" }
		}

		if (!selectedIntentId) {
			return {
				allowed: false,
				reason: hookError("intent_required", "No selected intent. Call select_active_intent first."),
			}
		}

		if (context.toolName === "write_to_file") {
			const filePath = context.params.path ?? context.params.file_path
			const expectedHash = (context.params as Record<string, string | undefined>).expected_hash
			if (filePath) {
				const staleResult = await this.checkFileStale(path.resolve(context.cwd, filePath), expectedHash)
				if (staleResult) {
					return staleResult
				}
			}
		}

		const validation = await this.validator.validate(context.cwd, context.toolName, context.params)
		if (!validation.allowed) {
			const code = validation.reason.startsWith("Scope Violation:")
				? "scope_violation"
				: "intent_validation_failed"
			return {
				allowed: false,
				reason: hookError(code, validation.reason),
				intentId: validation.intentId,
			}
		}

		return { allowed: true, reason: "intent + scope validated", intentId: validation.intentId }
	}
}
