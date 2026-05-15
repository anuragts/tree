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
});
