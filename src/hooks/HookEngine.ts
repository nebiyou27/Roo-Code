import { PostToolUse } from "./PostToolUse"
import { PreToolUse } from "./PreToolUse"
import type { BeforeToolResult, HookOutcome, HookToolContext, IHook } from "./index"
import { HookRegistry } from "./index"

class IntentValidationHook implements IHook {
	constructor(private readonly preToolUse = new PreToolUse()) {}

	async beforeToolUse(context: HookToolContext): Promise<BeforeToolResult> {
		return this.preToolUse.evaluate({
			taskId: context.taskId,
			cwd: context.cwd,
			toolName: context.toolName,
			params: context.params,
		})
	}

	async afterToolUse(): Promise<void> {
		// No-op: this hook only participates in pre tool validation.
	}
}

class TraceAndLessonsHook implements IHook {
	constructor(private readonly postToolUse = new PostToolUse()) {}

	async beforeToolUse(): Promise<BeforeToolResult> {
		return { allowed: true, reason: "post hook only" }
	}

	async afterToolUse(context: HookToolContext, outcome: HookOutcome): Promise<void> {
		await this.postToolUse.record({
			taskId: context.taskId,
			cwd: context.cwd,
			toolName: context.toolName,
			params: context.params,
			status: outcome.status,
			reason: outcome.reason,
			intentId: outcome.intentId,
			toolUseId: context.toolUseId,
		})
	}
}

export class HookEngine {
	private readonly selectedIntentByTask = new Map<string, string>()
	private readonly registry: HookRegistry

	private getIntentIdFromParams(params: Record<string, string | undefined>): string | undefined {
		return params.intent_id?.trim() || params.intentId?.trim()
	}

	constructor() {
		this.registry = new HookRegistry()
		this.registry.register(new IntentValidationHook())
		this.registry.register(new TraceAndLessonsHook())
	}

	async beforeToolUse(context: HookToolContext): Promise<BeforeToolResult> {
		const normalizedParams = { ...(context.params as Record<string, string | undefined>) }
		const extractedIntentId = this.getIntentIdFromParams(normalizedParams)
		if (extractedIntentId && !normalizedParams.intent_id) {
			normalizedParams.intent_id = extractedIntentId
		}

		if (context.toolName === "select_active_intent") {
			const intentId = this.getIntentIdFromParams(normalizedParams)
			if (!intentId) {
				return { allowed: false, reason: "select_active_intent requires intent_id" }
			}
			this.selectedIntentByTask.set(context.taskId, intentId)
			return { allowed: true, reason: "active intent selected", intentId }
		}

		const selectedIntentId = this.selectedIntentByTask.get(context.taskId)
		if (!normalizedParams.intent_id && selectedIntentId) {
			normalizedParams.intent_id = selectedIntentId
		}

		return this.registry.runBefore({
			taskId: context.taskId,
			cwd: context.cwd,
			toolName: context.toolName,
			params: normalizedParams as HookToolContext["params"],
			toolUseId: context.toolUseId,
		})
	}

	async afterToolUse(context: HookToolContext, outcome: HookOutcome): Promise<void> {
		await this.registry.runAfter(context, outcome)
	}
}

export const hookEngine = new HookEngine()
