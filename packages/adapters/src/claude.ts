import { randomUUID } from "node:crypto";
import type {
	AdapterContext,
	AdapterSession,
	AgentAdapter,
	AgentSummary,
	SendMessageInput,
	TreeEvent,
} from "@tree/core";

export class ClaudeAdapter implements AgentAdapter {
	readonly id = "claude";
	readonly displayName = "Claude Agent SDK";

	async listAgents(): Promise<AgentSummary[]> {
		return [{ id: "claude", name: "Claude Code", provider: "anthropic" }];
	}

	async startSession(context: AdapterContext): Promise<AdapterSession> {
		return {
			id: randomUUID(),
			adapterId: this.id,
			agentId: "claude",
			cwd: context.config.adapters.claude?.cwd ?? context.cwd,
		};
	}

	async *sendMessage(
		session: AdapterSession,
		input: SendMessageInput,
		context: AdapterContext,
	): AsyncIterable<TreeEvent> {
		const runId = randomUUID();
		yield {
			type: "run_started",
			runId,
			sessionId: session.id,
			adapterId: this.id,
			agentId: "claude",
			model: context.config.adapters.claude?.model,
		};
		const sdkHandled = await this.trySdk(input, context, runId);
		if (sdkHandled) {
			for (const event of sdkHandled) yield event;
			yield {
				type: "run_completed",
				runId,
				sessionId: session.id,
				status: "completed",
			};
			return;
		}
		const claudePath = await context.runtime.which("claude");
		if (!claudePath) {
			yield {
				type: "run_error",
				runId,
				message:
					"Claude SDK package/CLI was not found. Install claude-agent-sdk or the Claude Code CLI.",
			};
			return;
		}
		const args = this.cliArgs(context, input.content);
		const child = context.runtime.spawn(claudePath, args, { cwd: session.cwd });
		for await (const chunk of child.stdout)
			yield { type: "assistant_delta", text: chunk, runId };
		for await (const chunk of child.stderr)
			yield {
				type: "log",
				level: "warn",
				message: chunk.trim(),
				details: { runId },
			};
		const exitCode = await child.exitCode;
		if (exitCode === 0)
			yield {
				type: "run_completed",
				runId,
				sessionId: session.id,
				status: "completed",
			};
		else
			yield {
				type: "run_error",
				runId,
				message: `claude exited with code ${exitCode}`,
			};
	}

	private async trySdk(
		input: SendMessageInput,
		context: AdapterContext,
		runId: string,
	): Promise<TreeEvent[] | null> {
		const dynamicImport = new Function(
			"specifier",
			"return import(specifier)",
		) as (specifier: string) => Promise<unknown>;
		let sdk: Record<string, unknown> | undefined;
		for (const specifier of [
			"claude-agent-sdk",
			"@anthropic-ai/claude-agent-sdk",
		]) {
			try {
				sdk = (await dynamicImport(specifier)) as Record<string, unknown>;
				break;
			} catch {}
		}
		if (!sdk || typeof sdk.query !== "function") return null;
		const events: TreeEvent[] = [];
		const options = {
			model: context.config.adapters.claude?.model,
			allowed_tools: context.config.adapters.claude?.allowedTools,
			disallowed_tools: context.config.adapters.claude?.disallowedTools,
			permission_mode: context.config.adapters.claude?.permissionMode,
			cwd: context.config.adapters.claude?.cwd ?? context.cwd,
		};
		const result = (sdk.query as (args: unknown) => AsyncIterable<unknown>)({
			prompt: input.content,
			options,
		});
		for await (const message of result) {
			const text = extractText(message);
			if (text) events.push({ type: "assistant_delta", text, runId });
		}
		return events;
	}

	private cliArgs(context: AdapterContext, prompt: string): string[] {
		const args = ["-p", prompt];
		const config = context.config.adapters.claude;
		if (config?.model) args.push("--model", config.model);
		if (config?.allowedTools?.length)
			args.push("--allowedTools", config.allowedTools.join(","));
		if (config?.disallowedTools?.length)
			args.push("--disallowedTools", config.disallowedTools.join(","));
		if (config?.permissionMode)
			args.push("--permission-mode", config.permissionMode);
		if (config?.fastMode) args.push("--effort", "low");
		return args;
	}
}

function extractText(message: unknown): string | undefined {
	if (typeof message === "string") return message;
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	if (typeof record.text === "string") return record.text;
	if (typeof record.content === "string") return record.content;
	if (Array.isArray(record.content)) {
		return record.content
			.map((part) =>
				part &&
				typeof part === "object" &&
				typeof (part as Record<string, unknown>).text === "string"
					? (part as Record<string, string>).text
					: "",
			)
			.join("");
	}
	return undefined;
}
