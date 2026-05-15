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
	}

	if (
		event === "RunContent" ||
		event === "RunIntermediateContent" ||
		event === "ReasoningContentDelta"
	) {
		const text =
			stringValue(data.content) ?? stringValue(data.reasoning_content);
		if (text) events.push({ type: "assistant_delta", text, runId });
	}

	if (event === "ToolCallStarted") {
		for (const tool of asArray(data.tools)) {
			const parsed = tool as JsonObject;
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
		for (const tool of asArray(data.tools)) {
			const parsed = tool as JsonObject;
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
				result: parsed.result ?? parsed.content,
				isError: event === "ToolCallError",
				runId,
			});
		}
	}

	if (event === "RunPaused") {
		const approvals = [...asArray(data.tools), ...asArray(data.requirements)];
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
			message: stringValue(data.content) ?? stringValue(data.error) ?? event,
			cause: data,
		});
	}

	return events;
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
	if (!metrics || typeof metrics !== "object") return undefined;
	return {
		inputTokens: numberValue(metrics.input_tokens ?? metrics.input),
		outputTokens: numberValue(metrics.output_tokens ?? metrics.output),
		totalTokens: numberValue(metrics.total_tokens ?? metrics.total),
		costUsd: numberValue(metrics.cost_usd ?? metrics.cost),
	};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}
