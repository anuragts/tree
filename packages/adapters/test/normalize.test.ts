import { describe, expect, test } from "bun:test";
import { normalizeAgnoSse } from "../src/normalize.ts";

describe("normalizeAgnoSse", () => {
	test("maps Agno content events into TreeEvents", () => {
		const events = normalizeAgnoSse({
			event: "RunContent",
			data: '{"content":"hello","run_id":"r1"}',
			json: { content: "hello", run_id: "r1" },
		});
		expect(events).toEqual([
			{ type: "assistant_delta", text: "hello", runId: "r1" },
		]);
	});

	test("maps paused tools into approval requests", () => {
		const events = normalizeAgnoSse({
			event: "RunPaused",
			data: "{}",
			json: {
				run_id: "r1",
				session_id: "s1",
				tools: [
					{
						approval_id: "a1",
						tool_name: "write_file",
						tool_args: { path: "x" },
					},
				],
			},
		});
		expect(
			events.some(
				(event) =>
					event.type === "approval_requested" && event.approvalId === "a1",
			),
		).toBe(true);
	});

	test("maps Agno singular tool events", () => {
		const started = normalizeAgnoSse({
			event: "ToolCallStarted",
			data: "{}",
			json: {
				run_id: "r1",
				tool: {
					tool_call_id: "tc1",
					tool_name: "read_file",
					tool_args: { path: "README.md" },
				},
			},
		});
		expect(started).toEqual([
			{
				type: "tool_started",
				toolCallId: "tc1",
				name: "read_file",
				args: { path: "README.md" },
				runId: "r1",
			},
		]);

		const completed = normalizeAgnoSse({
			event: "ToolCallCompleted",
			data: "{}",
			json: {
				run_id: "r1",
				tool: {
					tool_call_id: "tc1",
					tool_name: "read_file",
					result: "ok",
				},
			},
		});
		expect(completed).toEqual([
			{
				type: "tool_completed",
				toolCallId: "tc1",
				name: "read_file",
				result: "ok",
				isError: false,
				runId: "r1",
			},
		]);
	});

	test("maps Agno lifecycle events to visible logs", () => {
		const events = normalizeAgnoSse({
			event: "ModelRequestStarted",
			data: "{}",
			json: {
				event: "ModelRequestStarted",
				run_id: "r1",
				model: "gpt-4.1",
				model_provider: "OpenAI",
			},
		});
		expect(events).toEqual([
			{
				type: "log",
				level: "info",
				message: "model request started · OpenAI/gpt-4.1",
				details: {
					event: "ModelRequestStarted",
					run_id: "r1",
					model: "gpt-4.1",
					model_provider: "OpenAI",
				},
			},
		]);
	});
});
