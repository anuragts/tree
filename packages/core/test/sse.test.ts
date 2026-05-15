import { describe, expect, test } from "bun:test";
import { parseSseMessage, parseSseStream } from "../src/sse.ts";

describe("SSE utilities", () => {
	test("parses a single message", () => {
		const message = parseSseMessage(
			'event: RunContent\ndata: {"content":"hello"}',
		);
		expect(message?.event).toBe("RunContent");
		const json = message?.json as { content?: string } | undefined;
		expect(json?.content).toBe("hello");
	});

	test("parses streamed messages split by blank lines", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				controller.enqueue(
					encoder.encode('event: RunStarted\ndata: {"run_id":"1"}\n\n'),
				);
				controller.enqueue(
					encoder.encode('event: RunContent\ndata: {"content":"ok"}\n\n'),
				);
				controller.close();
			},
		});
		const messages = [];
		for await (const message of parseSseStream(stream)) messages.push(message);
		expect(messages.map((message) => message.event)).toEqual([
			"RunStarted",
			"RunContent",
		]);
	});
});
