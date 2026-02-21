import type { ToolParamName } from "../shared/tools"

export interface HookToolContext {
	taskId: string
	cwd: string
	toolName: string
	params: Partial<Record<ToolParamName, string>>
	toolUseId?: string
}

export interface BeforeToolResult {
	allowed: boolean
	reason: string
	intentId?: string
}

export interface HookOutcome {
	status: "success" | "denied" | "error"
	reason?: string
	intentId?: string
}

export interface IHook {
	beforeToolUse(context: HookToolContext): Promise<BeforeToolResult>
	afterToolUse(context: HookToolContext, outcome: HookOutcome): Promise<void>
}

export class HookRegistry {
	private readonly hooks: IHook[] = []

	register(hook: IHook): void {
		this.hooks.push(hook)
	}

	async runBefore(context: HookToolContext): Promise<BeforeToolResult> {
		let lastIntentId: string | undefined
		let lastReason = "allowed"

		for (const hook of this.hooks) {
			try {
				const result = await hook.beforeToolUse(context)
				if (result.intentId) {
					lastIntentId = result.intentId
				}
				lastReason = result.reason
				if (!result.allowed) {
					return {
						allowed: false,
						reason: result.reason,
						intentId: result.intentId ?? lastIntentId,
					}
				}
			} catch (error) {
				console.error("[HookRegistry] beforeToolUse hook failed:", error)
			}
		}

		return { allowed: true, reason: lastReason, intentId: lastIntentId }
	}

	async runAfter(context: HookToolContext, outcome: HookOutcome): Promise<void> {
		for (const hook of this.hooks) {
			try {
				await hook.afterToolUse(context, outcome)
			} catch (error) {
				console.error("[HookRegistry] afterToolUse hook failed:", error)
			}
		}
	}
}
