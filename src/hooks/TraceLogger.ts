import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"

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
}

type SemanticClassification = "AST_REFACTOR" | "INTENT_EVOLUTION"

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
		return createHash("sha256").update(content, "utf8").digest("hex")
	}

	private async classifyChange(cwd: string, filePathValue?: string): Promise<SemanticClassification | undefined> {
		if (!filePathValue) {
			return undefined
		}

		const resolvedPath = path.isAbsolute(filePathValue) ? filePathValue : path.resolve(cwd, filePathValue)
		try {
			await fs.access(resolvedPath)
			return "AST_REFACTOR"
		} catch {
			return "INTENT_EVOLUTION"
		}
	}

	async append(cwd: string, event: TraceEvent): Promise<void> {
		const directoryPath = path.join(cwd, this.traceDir)
		const filePath = path.join(directoryPath, this.traceFileName)

		const filePathValue = event.file_path ?? event.params.path ?? event.params.file_path
		const startLine = event.start_line ?? this.toNumber(event.params.start_line)
		const endLine = event.end_line ?? this.toNumber(event.params.end_line)
		const content = event.content ?? event.params.content ?? ""
		const contentHash = this.hashContent(content)
		const gitSha = event.git_sha ?? process.env.GIT_COMMIT_SHA ?? "unknown"
		const intentId = event.intent_id ?? "INT-001"
		const semanticClassification = await this.classifyChange(cwd, filePathValue)

		const traceRecord = {
			timestamp: event.ts,
			intent_id: intentId,
			file_path: filePathValue,
			git_sha: gitSha,
			start_line: startLine,
			end_line: endLine,
			content_hash: contentHash,
			semantic_classification: semanticClassification,
			related: [{ type: "specification", value: intentId }],
			// Preserve existing operational context for debugging/audit.
			task_id: event.task_id,
			tool_use_id: event.tool_use_id,
			tool_name: event.tool_name,
			params: event.params,
			status: event.status,
			reason: event.reason,
		}

		await fs.mkdir(directoryPath, { recursive: true })
		await fs.appendFile(filePath, `${JSON.stringify(traceRecord)}\n`, "utf8")
	}
}
