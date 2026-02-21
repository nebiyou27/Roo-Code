import fs from "fs/promises"
import path from "path"
import YAML from "yaml"

import type { ToolParamName } from "../shared/tools"

interface ActiveIntentSpec {
	active_intent_id?: string
	owned_scope?: string[]
	status?: IntentStatus
	intents?: Array<{
		id: string
		status?: IntentStatus
		owned_scope?: string[]
	}>
}

export interface IntentValidationResult {
	allowed: boolean
	reason: string
	intentId?: string
}

export type IntentStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "LOCKED"

function normalizeScope(scope: string): string {
	let normalized = scope.replace(/\\/g, "/").trim()
	if (normalized.endsWith("/**")) {
		normalized = normalized.slice(0, -3)
	}
	return normalized.replace(/\/+$/, "")
}

export class IntentValidator {
	private readonly intentsFileName = "active_intents.yaml"
	private readonly intentIgnoreFileName = ".intentignore"

	private async readIntentSpec(cwd: string): Promise<ActiveIntentSpec> {
		const intentPath = path.join(cwd, this.intentsFileName)
		const raw = await fs.readFile(intentPath, "utf8")
		const parsed = YAML.parse(raw) as ActiveIntentSpec | undefined
		return parsed ?? {}
	}

	private async readIntentDocument(cwd: string): Promise<Record<string, unknown>> {
		const intentPath = path.join(cwd, this.intentsFileName)
		const raw = await fs.readFile(intentPath, "utf8")
		return (YAML.parse(raw) as Record<string, unknown> | undefined) ?? {}
	}

	private async writeIntentDocument(cwd: string, doc: Record<string, unknown>): Promise<void> {
		const intentPath = path.join(cwd, this.intentsFileName)
		await fs.writeFile(intentPath, YAML.stringify(doc), "utf8")
	}

	async updateIntentStatus(cwd: string, intentId: string, newStatus: IntentStatus): Promise<boolean> {
		try {
			const doc = await this.readIntentDocument(cwd)
			let updated = false

			if (Array.isArray(doc.intents)) {
				const nextIntents = doc.intents.map((entry) => {
					if (
						entry &&
						typeof entry === "object" &&
						"id" in entry &&
						(entry as { id?: unknown }).id === intentId
					) {
						updated = true
						return { ...(entry as Record<string, unknown>), status: newStatus }
					}
					return entry
				})
				doc.intents = nextIntents
			}

			if (!updated && doc.active_intent_id === intentId) {
				doc.status = newStatus
				updated = true
			}

			if (updated) {
				await this.writeIntentDocument(cwd, doc)
			}

			return updated
		} catch {
			return false
		}
	}

	private isPathInOwnedScope(cwd: string, targetPath: string, scopes: string[]): boolean {
		const normalizedTarget = path.resolve(targetPath).replace(/\\/g, "/").replace(/\/+$/, "")
		return scopes.some((scope) => {
			const normalizedScope = path.resolve(cwd, normalizeScope(scope)).replace(/\\/g, "/").replace(/\/+$/, "")
			return normalizedTarget === normalizedScope || normalizedTarget.startsWith(`${normalizedScope}/`)
		})
	}

	private async readIntentIgnorePatterns(cwd: string): Promise<string[]> {
		try {
			const raw = await fs.readFile(path.join(cwd, this.intentIgnoreFileName), "utf8")
			return raw
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#"))
		} catch {
			return []
		}
	}

	private wildcardToRegex(pattern: string): RegExp {
		const escaped = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*/g, ".*")
			.replace(/\*/g, "[^/]*")
		return new RegExp(`^${escaped}$`)
	}

	private isIgnoredByIntentIgnore(cwd: string, targetPath: string, patterns: string[]): boolean {
		const rel = path.relative(cwd, targetPath).replace(/\\/g, "/")
		return patterns.some((pattern) => this.wildcardToRegex(pattern).test(rel))
	}

	private getTargetPathFromToolParams(
		cwd: string,
		toolName: string,
		params: Partial<Record<ToolParamName, string>>,
	): string | undefined {
		const directPath = params.path || params.file_path || (toolName === "execute_command" ? params.cwd : undefined)

		if (!directPath) {
			return undefined
		}

		return path.resolve(cwd, directPath)
	}

	async validate(
		cwd: string,
		toolName: string,
		params: Partial<Record<ToolParamName, string>>,
	): Promise<IntentValidationResult> {
		try {
			const spec = await this.readIntentSpec(cwd)
			const intentId = spec.active_intent_id?.trim()
			const selectedIntentId = params.intent_id?.trim()

			// Selection handshake transition: PENDING -> IN_PROGRESS
			if (toolName === "select_active_intent" && selectedIntentId) {
				await this.updateIntentStatus(cwd, selectedIntentId, "IN_PROGRESS")
				return { allowed: true, reason: "Intent selected and marked IN_PROGRESS", intentId: selectedIntentId }
			}

			if (!intentId) {
				return { allowed: false, reason: "No active intent ID found in active_intents.yaml" }
			}

			if (selectedIntentId && selectedIntentId !== intentId) {
				return {
					allowed: false,
					reason: `Selected intent '${selectedIntentId}' does not match active_intents.yaml active_intent_id '${intentId}'`,
					intentId,
				}
			}

			const scope = (spec.owned_scope ?? []).map((entry) => entry.trim()).filter(Boolean)
			if (scope.length === 0) {
				return {
					allowed: false,
					reason: "No owned_scope entries found in active_intents.yaml",
					intentId,
				}
			}

			const targetPath = this.getTargetPathFromToolParams(cwd, toolName, params)
			if (!targetPath) {
				// Completion transition: IN_PROGRESS -> COMPLETED
				if (toolName === "attempt_completion") {
					await this.updateIntentStatus(cwd, intentId, "COMPLETED")
					return { allowed: true, reason: "Intent marked COMPLETED", intentId }
				}

				// If a tool does not target an explicit path, we keep skeleton behavior permissive.
				return { allowed: true, reason: "No explicit target path to scope-check", intentId }
			}

			const intentIgnorePatterns = await this.readIntentIgnorePatterns(cwd)
			if (this.isIgnoredByIntentIgnore(cwd, targetPath, intentIgnorePatterns)) {
				return { allowed: true, reason: "Path is excluded by .intentignore", intentId }
			}

			if (!this.isPathInOwnedScope(cwd, targetPath, scope)) {
				await this.updateIntentStatus(cwd, intentId, "LOCKED")
				return {
					allowed: false,
					reason: `Scope Violation: ${intentId} is not authorized to edit ${path.basename(targetPath)}. Request scope expansion.`,
					intentId,
				}
			}

			return { allowed: true, reason: "Path is within owned_scope", intentId }
		} catch (error) {
			return {
				allowed: false,
				reason: `Intent validation failed: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}
}
