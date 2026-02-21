import fs from "fs/promises"
import path from "path"
import crypto from "crypto"
import { execSync } from "child_process"

interface TraceEvent {
	ts: string
	task_id: string
	intent_id?: string
	tool_use_id?: string
	tool_name: string
	params: Partial<Record<string, string | undefined>>
	status: "success" | "denied" | "error"
	reason?: string
	file_path?: string
	git_sha?: string
	start_line?: number
	end_line?: number
	content?: string
	model_identifier?: string
}

export class TraceLogger {
	private readonly traceDir = ".orchestration"
	private readonly traceFileName = "agent_trace.jsonl"

	private toNumber(value: string | number | undefined): number | undefined {
		if (typeof value === "number") {
			return Number.isFinite(value) ? value : undefined
		}
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value)
			return Number.isFinite(parsed) ? parsed : undefined
		}
		return undefined
	}

	private hashContent(content: string): string {
		return crypto.createHash("sha256").update(content, "utf8").digest("hex")
	}

	private async getContentForHash(cwd: string, event: TraceEvent, filePathValue?: string): Promise<string> {
		if (filePathValue && event.status === "success") {
			const resolvedPath = path.isAbsolute(filePathValue) ? filePathValue : path.resolve(cwd, filePathValue)
			try {
				return await fs.readFile(resolvedPath, "utf8")
			} catch {
				// Fall back to tool payload content if file read fails.
			}
		}

		return event.content ?? event.params.content ?? ""
	}

	private getGitSha(cwd: string): string {
		try {
			return execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim()
		} catch {
			return "unknown"
		}
	}

	async append(cwd: string, event: TraceEvent): Promise<void> {
		const directoryPath = path.join(cwd, this.traceDir)
		const filePath = path.join(directoryPath, this.traceFileName)

		const filePathValue = event.file_path ?? event.params.path ?? event.params.file_path
		const content = await this.getContentForHash(cwd, event, filePathValue)
		const contentHash = this.hashContent(content)
		const gitSha = event.git_sha ?? this.getGitSha(cwd)
		const intentId = event.intent_id ?? "INT-001"
		const modelIdentifier =
			event.model_identifier ??
			(event.params as Record<string, string | undefined>).model_identifier ??
			"unknown-model"
		const relativePath = filePathValue
			? path
					.relative(cwd, path.isAbsolute(filePathValue) ? filePathValue : path.resolve(cwd, filePathValue))
					.replace(/\\/g, "/")
			: ""

		const traceRecord = {
			id: crypto.randomUUID(),
			timestamp: event.ts,
			vcs: {
				revision_id: gitSha,
			},
			files: [
				{
					relative_path: relativePath,
					conversations: [
						{
							contributor: {
								entity_type: "AI",
								model_identifier: modelIdentifier,
							},
							ranges: [
								{
									content_hash: `sha256:${contentHash}`,
								},
							],
							related: [
								{
									type: "specification",
									value: intentId,
								},
							],
						},
					],
				},
			],
		}

		await fs.mkdir(directoryPath, { recursive: true })
		await fs.appendFile(filePath, `${JSON.stringify(traceRecord)}\n`, "utf8")
	}
}
