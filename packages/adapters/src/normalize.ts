import type { SseMessage, TreeEvent, UsageInfo } from "@tree/core";

type JsonObject = Record<string, unknown>;

export function normalizeAgnoSse(message: SseMessage): TreeEvent[] {
	const data = (
		message.json && typeof message.json === "object" ? message.json : {}
	) as JsonObject;
	const event = String(message.event ?? data.event ?? "");
	const runId = stringValue(data.run_id) ?? stringValue(data.runId);
	const sessionId = stringValue(data.session_id) ?? stringValue(data.sessionId);
	const events: TreeEvent[] = [];

	if (event === "RunStarted") {
		events.push({
			type: "run_started",
			runId: runId ?? "unknown",
			sessionId: sessionId ?? "unknown",
			adapterId: "agno",
			agentId: stringValue(data.agent_id),
			model: stringValue(data.model),
		});
		events.push(logEvent("info", agnoStatusLabel(event, data), data));
	}

	if (event === "RunContent" || event === "RunIntermediateContent") {
		const text = contentText(data.content);
		if (text) events.push({ type: "assistant_delta", text, runId });
	}

	if (event === "ReasoningContentDelta") {
		const text = stringValue(data.reasoning_content);
		if (text) events.push({ type: "assistant_delta", text, runId });
	}

	if (event === "ToolCallStarted") {
		for (const parsed of toolExecutions(data)) {
			events.push({
				type: "tool_started",
				toolCallId:
					stringValue(parsed.tool_call_id) ??
					stringValue(parsed.toolCallId) ??
					"unknown",
				name:
					stringValue(parsed.tool_name) ??
					stringValue(parsed.toolName) ??
					"tool",
				args: parsed.tool_args ?? parsed.toolArgs,
				runId,
			});
		}
	}

	if (event === "ToolCallCompleted" || event === "ToolCallError") {
		for (const parsed of toolExecutions(data)) {
			events.push({
				type: "tool_completed",
				toolCallId:
					stringValue(parsed.tool_call_id) ??
					stringValue(parsed.toolCallId) ??
					"unknown",
				name:
					stringValue(parsed.tool_name) ??
					stringValue(parsed.toolName) ??
					"tool",
				result: parsed.result ?? data.content ?? parsed.content,
				isError:
					event === "ToolCallError" ||
					booleanValue(parsed.tool_call_error) ||
					false,
				runId,
			});
		}
	}

	if (event === "RunPaused") {
		const approvals = [...toolExecutions(data), ...asArray(data.requirements)];
		events.push({
			type: "run_paused",
			runId: runId ?? "unknown",
			reason: "approval",
			approvals,
		});
		for (const item of approvals) {
			const approval = unwrapApproval(item as JsonObject);
			events.push({
				type: "approval_requested",
				runId: runId ?? stringValue(approval.run_id) ?? "unknown",
				sessionId,
				approvalId:
					stringValue(approval.approval_id) ?? stringValue(approval.id),
				toolCallId: stringValue(approval.tool_call_id),
				toolName: stringValue(approval.tool_name),
				toolArgs: approval.tool_args,
				pauseType: stringValue(approval.pause_type),
				source: stringValue(approval.source_name),
			});
		}
	}

	if (event === "RunCompleted") {
		const text = contentText(data.content);
		if (text) events.push({ type: "assistant_message", text, runId });
		events.push({
			type: "run_completed",
			runId: runId ?? "unknown",
			sessionId,
			usage: usageFrom(data),
			status: "completed",
		});
	}

	if (event === "RunError" || event === "RunCancelled") {
		events.push({
			type: "run_error",
			runId,
			message:
				stringValue(data.content) ??
				stringValue(data.error) ??
				stringValue(data.reason) ??
				event,
			cause: data,
		});
	}

	if (event === "ModelRequestCompleted") {
		const usage = usageFrom(data);
		if (usage) events.push({ type: "usage", usage, runId });
	}

	if (events.length === 0 && event && shouldShowAgnoStatus(event)) {
		events.push(logEvent("info", agnoStatusLabel(event, data), data));
	}

	return events;
}

function toolExecutions(data: JsonObject): JsonObject[] {
	const tools = asArray(data.tools).filter(isJsonObject);
	if (isJsonObject(data.tool)) tools.push(data.tool);
	if (
		tools.length === 0 &&
		(stringValue(data.tool_name) || stringValue(data.toolName))
	) {
		tools.push(data);
	}
	return tools;
}

function unwrapApproval(value: JsonObject): JsonObject {
	const requirement = value.requirement as JsonObject | undefined;
	const tool = (requirement?.tool_execution ??
		value.tool_execution ??
		value) as JsonObject;
	return { ...value, ...tool };
}

function usageFrom(data: JsonObject): UsageInfo | undefined {
	const metrics = (data.metrics ?? data.usage) as JsonObject | undefined;
	const source = metrics && typeof metrics === "object" ? metrics : data;
	return {
		inputTokens: numberValue(source.input_tokens ?? source.input),
		outputTokens: numberValue(source.output_tokens ?? source.output),
		cacheReadTokens: numberValue(source.cache_read_tokens),
		cacheWriteTokens: numberValue(source.cache_write_tokens),
		totalTokens: numberValue(source.total_tokens ?? source.total),
		costUsd: numberValue(source.cost_usd ?? source.cost),
	};
}

function logEvent(
	level: "debug" | "info" | "warn" | "error",
	message: string,
	details: unknown,
): TreeEvent {
	return { type: "log", level, message, details };
}

function shouldShowAgnoStatus(event: string): boolean {
	return (
		event.endsWith("Started") ||
		event.endsWith("Completed") ||
		event.endsWith("Continued") ||
		event.endsWith("Paused") ||
		event === "CustomEvent" ||
		event === "ToolCallError"
	);
}

function agnoStatusLabel(event: string, data: JsonObject): string {
	switch (event) {
		case "RunStarted":
			return `Agno run started${stringValue(data.run_id) ? ` · ${stringValue(data.run_id)}` : ""}`;
		case "RunContinued":
			return "Agno run continued";
		case "ReasoningStarted":
			return "reasoning started";
		case "ReasoningCompleted":
			return "reasoning completed";
		case "ModelRequestStarted":
			return modelLabel("model request started", data);
		case "ModelRequestCompleted":
			return modelLabel("model request completed", data);
		case "MemoryUpdateStarted":
			return "memory update started";
		case "MemoryUpdateCompleted":
			return "memory update completed";
		case "SessionSummaryStarted":
			return "session summary started";
		case "SessionSummaryCompleted":
			return "session summary completed";
		case "CompressionStarted":
			return "compression started";
		case "CompressionCompleted":
			return "compression completed";
		case "FollowupsStarted":
			return "followups started";
		case "FollowupsCompleted":
			return "followups completed";
		case "PreHookStarted":
			return hookLabel("pre-hook started", data);
		case "PreHookCompleted":
			return hookLabel("pre-hook completed", data);
		case "PostHookStarted":
			return hookLabel("post-hook started", data);
		case "PostHookCompleted":
			return hookLabel("post-hook completed", data);
		case "ParserModelResponseStarted":
			return "parser model response started";
		case "ParserModelResponseCompleted":
			return "parser model response completed";
		case "OutputModelResponseStarted":
			return "output model response started";
		case "OutputModelResponseCompleted":
			return "output model response completed";
		case "CustomEvent":
			return (
				stringValue(data.name) ?? stringValue(data.message) ?? "custom event"
			);
		default:
			return event.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
	}
}

function modelLabel(prefix: string, data: JsonObject): string {
	const model = stringValue(data.model);
	const provider = stringValue(data.model_provider);
	if (model && provider) return `${prefix} · ${provider}/${model}`;
	if (model) return `${prefix} · ${model}`;
	return prefix;
}

function hookLabel(prefix: string, data: JsonObject): string {
	const name =
		stringValue(data.pre_hook_name) ?? stringValue(data.post_hook_name);
	return name ? `${prefix} · ${name}` : prefix;
}

function contentText(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}
