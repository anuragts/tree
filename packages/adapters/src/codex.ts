import { randomUUID } from "node:crypto";
import type {
	AdapterContext,
	AdapterSession,
	AgentAdapter,
	AgentSummary,
	ContinueRunInput,
	SendMessageInput,
	SpawnHandle,
	TreeEvent,
} from "@tree/core";

type JsonRpcMessage = {
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message?: string; code?: number };
};

type PendingRequest = {
	id: number | string;
	method: string;
	params: Record<string, unknown>;
};

type AppServerState = {
	child: SpawnHandle;
	threadId?: string;
	turnId?: string;
	queue: AsyncQueue<JsonRpcMessage>;
	pending: Map<
		number | string,
		{ resolve: (value: JsonRpcMessage) => void; reject: (error: Error) => void }
	>;
	serverRequests: Map<string, PendingRequest>;
	nextId: number;
};

export class CodexAdapter implements AgentAdapter {
	readonly id = "codex";
	readonly displayName = "OpenAI Codex";
	private readonly appServers = new Map<string, AppServerState>();

	async listAgents(): Promise<AgentSummary[]> {
		return [{ id: "codex", name: "Codex CLI", provider: "openai" }];
	}

	async startSession(context: AdapterContext): Promise<AdapterSession> {
		return {
			id: randomUUID(),
			adapterId: this.id,
			agentId: "codex",
			cwd: context.config.adapters.codex?.cwd ?? context.cwd,
		};
	}

	async *sendMessage(
		session: AdapterSession,
		input: SendMessageInput,
		context: AdapterContext,
	): AsyncIterable<TreeEvent> {
		const runId = randomUUID();
		const mode = context.config.adapters.codex?.mode ?? "app-server";
		yield {
			type: "run_started",
			runId,
			sessionId: session.id,
			adapterId: this.id,
			agentId: "codex",
			model: context.config.adapters.codex?.model,
		};
		const codexPath = await context.runtime.which("codex");
		if (!codexPath) {
			yield {
				type: "run_error",
				runId,
				message: "Codex CLI was not found on PATH.",
			};
			return;
		}
		if (mode === "app-server") {
			yield* this.sendViaAppServer(codexPath, session, input, context, runId);
			return;
		}
		if (mode === "mcp") {
			yield {
				type: "log",
				level: "info",
				message:
					"Codex MCP mode is configured; using exec fallback until MCP orchestration is selected for this TUI.",
				details: { runId },
			};
		}
		const args = this.execArgs(context, input.content);
		const child = context.runtime.spawn(codexPath, args, { cwd: session.cwd });
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
				message: `codex exited with code ${exitCode}`,
			};
	}

	async *continueRun(
		session: AdapterSession,
		input: ContinueRunInput,
	): AsyncIterable<TreeEvent> {
		const state = this.appServers.get(session.id);
		const approvalId = input.approvalId;
		if (!state || !approvalId) {
			yield {
				type: "run_error",
				runId: input.runId,
				message:
					"No active Codex app-server approval is available for this session.",
			};
			return;
		}
		const request = state.serverRequests.get(approvalId);
		if (!request) {
			yield {
				type: "run_error",
				runId: input.runId,
				message: `No Codex app-server request ${approvalId} is pending.`,
			};
			return;
		}
		state.serverRequests.delete(approvalId);
		const approved = input.approved !== false;
		respond(state, request.id, buildApprovalResponse(request.method, approved));
		yield {
			type: "log",
			level: "info",
			message: `${approved ? "Approved" : "Rejected"} Codex request ${approvalId}`,
			details: request.params,
		};
	}

	async cancelRun(session: AdapterSession, _runId: string): Promise<void> {
		const state = this.appServers.get(session.id);
		if (!state?.threadId || !state.turnId) {
			state?.child.kill();
			return;
		}
		await request(state, "turn/interrupt", {
			threadId: state.threadId,
			turnId: state.turnId,
		});
	}

	async dispose(): Promise<void> {
		for (const state of this.appServers.values()) state.child.kill();
		this.appServers.clear();
	}

	private async *sendViaAppServer(
		codexPath: string,
		session: AdapterSession,
		input: SendMessageInput,
		context: AdapterContext,
		runId: string,
	): AsyncIterable<TreeEvent> {
		const state =
			this.appServers.get(session.id) ??
			this.startAppServer(codexPath, session, context);
		try {
			if (!state.threadId) {
				await request(state, "initialize", {
					clientInfo: {
						name: "tree_agent",
						title: "Tree Agent",
						version: "0.1.0",
					},
					capabilities: { experimentalApi: true },
				});
				notify(state, "initialized", {});
				const thread = await request(state, "thread/start", {
					model: context.config.adapters.codex?.model,
				});
				state.threadId =
					stringAt(thread.result, ["thread", "id"]) ??
					stringAt(thread.result, ["id"]);
			}
			if (!state.threadId) {
				yield {
					type: "run_error",
					runId,
					message: "Codex app-server did not return a thread id.",
				};
				return;
			}
			const start = await request(state, "turn/start", {
				threadId: state.threadId,
				input: [{ type: "text", text: input.content }],
				model: context.config.adapters.codex?.model,
				cwd: session.cwd,
				sandboxPolicy: sandboxPolicy(context.config.adapters.codex?.sandbox),
			});
			state.turnId =
				stringAt(start.result, ["turn", "id"]) ??
				stringAt(start.result, ["turnId"]);
			for (;;) {
				const message = await state.queue.shift();
				if (message.id !== undefined && message.method) {
					const approval = this.handleServerRequest(
						state,
						message,
						runId,
						session.id,
					);
					if (approval) yield approval;
					continue;
				}
				const events = normalizeCodexMessage(message, runId, session.id);
				for (const event of events) yield event;
				if (message.method === "turn/completed") {
					state.turnId = undefined;
					break;
				}
			}
		} catch (error) {
			yield {
				type: "run_error",
				runId,
				message: error instanceof Error ? error.message : String(error),
				cause: error,
			};
		}
	}

	private startAppServer(
		codexPath: string,
		session: AdapterSession,
		context: AdapterContext,
	): AppServerState {
		const child = context.runtime.spawn(codexPath, ["app-server"], {
			cwd: session.cwd,
		});
		const state: AppServerState = {
			child,
			queue: new AsyncQueue<JsonRpcMessage>(),
			pending: new Map(),
			serverRequests: new Map(),
			nextId: 1,
		};
		this.appServers.set(session.id, state);
		void (async () => {
			for await (const line of child.stdout) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const message = JSON.parse(trimmed) as JsonRpcMessage;
					const pending =
						message.id !== undefined
							? state.pending.get(message.id)
							: undefined;
					if (message.id !== undefined && !message.method && pending) {
						state.pending.delete(message.id);
						if (message.error)
							pending.reject(
								new Error(
									message.error.message ??
										`Codex app-server error ${message.error.code ?? ""}`,
								),
							);
						else pending.resolve(message);
					} else {
						state.queue.push(message);
					}
				} catch (error) {
					state.queue.push({
						method: "tree/log",
						params: {
							message: `Invalid Codex JSON-RPC line: ${trimmed}`,
							error: String(error),
						},
					});
				}
			}
		})();
		void (async () => {
			for await (const line of child.stderr) {
				state.queue.push({
					method: "tree/log",
					params: { level: "warn", message: line.trim() },
				});
			}
		})();
		return state;
	}

	private handleServerRequest(
		state: AppServerState,
		message: JsonRpcMessage,
		runId: string,
		sessionId: string,
	): TreeEvent | undefined {
		if (message.id === undefined) return undefined;
		const method = message.method ?? "request";
		const requestId = String(message.id);
		state.serverRequests.set(requestId, {
			id: message.id,
			method,
			params: message.params ?? {},
		});
		if (
			method.includes("requestApproval") ||
			method === "item/tool/requestUserInput"
		) {
			return {
				type: "approval_requested",
				approvalId: requestId,
				runId,
				sessionId,
				toolCallId: stringValue(message.params?.itemId),
				toolName: method,
				toolArgs: message.params,
				pauseType: "confirmation",
				source: "codex app-server",
			};
		}
		return {
			type: "approval_requested",
			approvalId: requestId,
			runId,
			sessionId,
			toolName: method,
			toolArgs: message.params,
			pauseType: "user_input",
			source: "codex app-server",
		};
	}

	private execArgs(context: AdapterContext, prompt: string): string[] {
		const args = ["exec"];
		const config = context.config.adapters.codex;
		if (config?.model) args.push("--model", config.model);
		if (config?.sandbox) args.push("--sandbox", config.sandbox);
		args.push(prompt);
		return args;
	}
}

function request(
	state: AppServerState,
	method: string,
	params: Record<string, unknown>,
): Promise<JsonRpcMessage> {
	const id = state.nextId++;
	const payload = { method, id, params };
	state.child.writeStdin(`${JSON.stringify(payload)}\n`);
	return new Promise((resolve, reject) => {
		state.pending.set(id, { resolve, reject });
	});
}

function notify(
	state: AppServerState,
	method: string,
	params: Record<string, unknown>,
): void {
	state.child.writeStdin(`${JSON.stringify({ method, params })}\n`);
}

function respond(
	state: AppServerState,
	id: number | string,
	result: unknown,
): void {
	state.child.writeStdin(`${JSON.stringify({ id, result })}\n`);
}

function normalizeCodexMessage(
	message: JsonRpcMessage,
	runId: string,
	sessionId: string,
): TreeEvent[] {
	const method = message.method ?? "";
	const params = message.params ?? {};
	if (method === "tree/log") {
		return [
			{
				type: "log",
				level: stringValue(params.level) === "error" ? "error" : "warn",
				message: stringValue(params.message) ?? "Codex app-server log",
				details: params,
			},
		];
	}
	if (method === "item/agentMessage/delta") {
		const text =
			stringValue(params.delta) ??
			stringValue(params.text) ??
			stringValue(params.content);
		return text ? [{ type: "assistant_delta", text, runId }] : [];
	}
	if (method === "item/started") {
		const item = objectValue(params.item);
		const itemType = stringValue(item?.type) ?? "item";
		if (isToolItem(itemType)) {
			return [
				{
					type: "tool_started",
					toolCallId: stringValue(item?.id) ?? randomUUID(),
					name: itemType,
					args: item,
					runId,
				},
			];
		}
		return [];
	}
	if (method === "item/completed") {
		const item = objectValue(params.item);
		const itemType = stringValue(item?.type) ?? "item";
		if (itemType === "agentMessage") {
			const text = stringValue(item?.text) ?? stringValue(item?.message);
			return text ? [{ type: "assistant_message", text, runId }] : [];
		}
		if (isToolItem(itemType)) {
			return [
				{
					type: "tool_completed",
					toolCallId: stringValue(item?.id) ?? randomUUID(),
					name: itemType,
					result: item,
					isError: stringValue(item?.status) === "failed",
					runId,
				},
			];
		}
		return [];
	}
	if (
		method === "item/commandExecution/outputDelta" ||
		method === "item/fileChange/outputDelta"
	) {
		const text =
			stringValue(params.delta) ??
			stringValue(params.text) ??
			stringValue(params.output);
		return text
			? [
					{
						type: "log",
						level: "info",
						message: text,
						details: { runId, method, params },
					},
				]
			: [];
	}
	if (method === "thread/tokenUsage/updated") {
		const usage = objectValue(params.usage) ?? params;
		return [
			{
				type: "usage",
				runId,
				usage: {
					inputTokens: numberValue(usage.inputTokens ?? usage.input_tokens),
					outputTokens: numberValue(usage.outputTokens ?? usage.output_tokens),
					totalTokens: numberValue(usage.totalTokens ?? usage.total_tokens),
					costUsd: numberValue(usage.costUsd ?? usage.cost_usd),
				},
			},
		];
	}
	if (method === "turn/completed") {
		const turn = objectValue(params.turn);
		const status = stringValue(turn?.status) ?? "completed";
		const error = objectValue(turn?.error);
		if (status === "failed") {
			return [
				{
					type: "run_error",
					runId,
					message: stringValue(error?.message) ?? "Codex turn failed",
					cause: params,
				},
			];
		}
		return [{ type: "run_completed", runId, sessionId, status }];
	}
	if (method === "error") {
		const error = objectValue(params.error);
		return [
			{
				type: "run_error",
				runId,
				message: stringValue(error?.message) ?? "Codex app-server error",
				cause: params,
			},
		];
	}
	return [];
}

function buildApprovalResponse(
	method: string,
	approved: boolean,
): Record<string, unknown> {
	// Codex's app-server uses different decision enums per request type.
	// See `codex app-server generate-json-schema` for the canonical shapes.
	switch (method) {
		case "applyPatchApproval":
		case "execCommandApproval":
			return { decision: approved ? "approved" : "denied" };
		case "item/commandExecution/requestApproval":
		case "item/fileChange/requestApproval":
			return { decision: approved ? "accept" : "decline" };
		default:
			return { decision: approved ? "accept" : "decline" };
	}
}

function sandboxPolicy(
	value: string | undefined,
): Record<string, unknown> | undefined {
	if (!value) return undefined;
	if (value === "workspace-write") return { type: "workspaceWrite" };
	if (value === "read-only") return { type: "readOnly" };
	if (value === "danger-full-access") return { type: "dangerFullAccess" };
	return { type: value };
}

function isToolItem(type: string): boolean {
	return [
		"commandExecution",
		"fileChange",
		"dynamicToolCall",
		"mcpToolCall",
		"collabToolCall",
		"webSearch",
	].includes(type);
}

function stringAt(value: unknown, path: string[]): string | undefined {
	let current = value;
	for (const part of path) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return stringValue(current);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

class AsyncQueue<T> {
	private readonly values: T[] = [];
	private readonly resolvers: Array<(value: T) => void> = [];

	push(value: T): void {
		const resolver = this.resolvers.shift();
		if (resolver) resolver(value);
		else this.values.push(value);
	}

	shift(): Promise<T> {
		const value = this.values.shift();
		if (value !== undefined) return Promise.resolve(value);
		return new Promise((resolve) => this.resolvers.push(resolve));
	}
}
